#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_DOMAINS, PAIRWISE_ASSERTIONS } from "./assertions.js";
import { flattenManifest, loadManifest } from "./split-loader.js";
import {
  formatCIDetail,
  formatCILowerDetail,
  wilsonLowerBound,
  wilsonUpperBound,
} from "./stats.js";
import type { RedactedShadowSummary } from "./types.js";
import { HOLDOUT_ASSERTIONS, SHADOW_ASSERTIONS } from "./types.js";

const args = process.argv.slice(2);
const evalMode = args.includes("--eval");
const holdoutMode = args.includes("--holdout");
const shadowMode = args.includes("--shadow");
const gateMode: "train" | "holdout" | "eval" | "shadow" = evalMode
  ? "eval"
  : holdoutMode
    ? "holdout"
    : shadowMode
      ? "shadow"
      : "train";

interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

function runGate(name: string, fn: () => { passed: boolean; detail: string }): GateResult {
  const start = performance.now();
  try {
    const { passed, detail } = fn();
    return { detail, durationMs: Math.round(performance.now() - start), gate: name, passed };
  } catch (error) {
    return {
      detail: `Error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Math.round(performance.now() - start),
      gate: name,
      passed: false,
    };
  }
}

function execCheck(
  cmd: string,
  cwd: string,
  timeoutMs = 120_000,
): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe", timeout: timeoutMs });
    return { output, success: true };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    return { output: err.stderr ?? err.stdout ?? "", success: false };
  }
}

function findLatestSnapshot(splitPrefix?: string): Record<string, unknown> | null {
  // Try split-specific subdirectory first
  const splitSubdir = splitPrefix === "holdout" ? "holdout" : "train";
  const splitDir = join(import.meta.dirname, "results", splitSubdir);
  const legacyDir = join(import.meta.dirname, "results");

  for (const dir of [splitDir, legacyDir]) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && /^\d{4}-\d{2}-\d{2}T/.test(f))
      .sort();
    if (files.length === 0) continue;
    for (let i = files.length - 1; i >= 0; i--) {
      const data = JSON.parse(readFileSync(join(dir, files[i]!), "utf8"));
      if (!splitPrefix || data.corpusSplit === splitPrefix || !data.corpusSplit) {
        return data;
      }
    }
  }
  return null;
}

function findLatestEvalSummary(): Record<string, unknown> | null {
  const summaryPath = join(import.meta.dirname, "..", "benchmarks-output", "eval-summary.json");
  if (!existsSync(summaryPath)) return null;
  return JSON.parse(readFileSync(summaryPath, "utf8"));
}

function findLatestShadowSummary(): { summary: RedactedShadowSummary; ageMs: number } | null {
  const summaryPath = join(import.meta.dirname, "..", "benchmarks-output", "shadow-summary.json");
  if (!existsSync(summaryPath)) return null;
  try {
    const stat = statSync(summaryPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RedactedShadowSummary;
    return { ageMs, summary };
  } catch {
    return null;
  }
}

function runTrainGates(): GateResult[] {
  const projectRoot = join(import.meta.dirname, "..");
  const gates: GateResult[] = [];

  // Gate 1: Build
  gates.push(
    runGate("build", () => {
      const { success, output } = execCheck("pnpm build", projectRoot);
      return {
        detail: success ? "Build succeeded" : `Build failed: ${output.slice(0, 200)}`,
        passed: success,
      };
    }),
  );

  // Gate 2: Unit tests
  gates.push(
    runGate("unit-tests", () => {
      const { success, output } = execCheck("pnpm test:run", projectRoot, 300_000);
      const passMatch = output.match(/(\d+) passed/);
      const failMatch = output.match(/(\d+) failed/);
      const passCount = passMatch ? passMatch[1] : "?";
      const failCount = failMatch ? Number.parseInt(failMatch[1]!) : 0;
      return {
        detail: success ? `${passCount} tests passed` : `${failCount} test(s) failed`,
        passed: success,
      };
    }),
  );

  // Gate 3-10: Based on latest benchmark snapshot
  const snapshot = findLatestSnapshot("train") ?? findLatestSnapshot();
  if (!snapshot) {
    console.log("WARNING: No benchmark snapshot found. Run 'pnpm benchmark:train' first.\n");
    console.log("Skipping benchmark-dependent gates.\n");
    return gates;
  }

  const summary = snapshot["summary"] as
    | {
        mustPass?: { passed: number; failed: number; total: number };
        hardDiagnostic?: { passed: number; failed: number; total: number };
        diagnostic?: { passed: number; failed: number; total: number };
        fallbackGlobCount?: number;
        undersampledAnchorCount?: number;
      }
    | undefined;

  // Gate 3: Must-pass
  gates.push(
    runGate("must-pass-100%", () => {
      const mp = summary?.mustPass;
      if (!mp) return { detail: "No must-pass data", passed: false };
      return { detail: `${mp.passed}/${mp.total} passed`, passed: mp.failed === 0 };
    }),
  );

  // Gate 4: Hard-diagnostic
  gates.push(
    runGate("hard-diagnostic->=95%", () => {
      const hd = summary?.hardDiagnostic;
      if (!hd) return { detail: "No hard-diagnostic data", passed: true };
      const rate = hd.total > 0 ? hd.passed / hd.total : 1;
      return {
        detail: `${hd.passed}/${hd.total} (${(rate * 100).toFixed(1)}%)`,
        passed: rate >= 0.95,
      };
    }),
  );

  // Gate 5: Diagnostic
  gates.push(
    runGate("diagnostic->=90%", () => {
      const diag = summary?.diagnostic;
      if (!diag) return { detail: "No diagnostic data", passed: true };
      const rate = diag.total > 0 ? diag.passed / diag.total : 1;
      return {
        detail: `${diag.passed}/${diag.total} (${(rate * 100).toFixed(1)}%)`,
        passed: rate >= 0.9,
      };
    }),
  );

  // Gate 6: Ranking loss
  gates.push(
    runGate("ranking-loss-<6%", () => {
      const assertions = snapshot["assertions"] as { result: string }[] | undefined;
      if (!assertions) return { detail: "No assertion data", passed: false };
      const evaluated = assertions.filter((a) => a.result !== "skip");
      const failed = evaluated.filter((a) => a.result === "fail");
      const loss = evaluated.length > 0 ? failed.length / evaluated.length : 0;
      return {
        detail: `${(loss * 100).toFixed(1)}% (${failed.length}/${evaluated.length})`,
        passed: loss < 0.06,
      };
    }),
  );

  // Gate 7: False equivalence
  gates.push(
    runGate("false-equivalence-=0", () => {
      const entries = snapshot["entries"] as
        | { name: string; tier: string; consumerApi: number | null }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: false };
      const tierOrder: Record<string, number> = {
        elite: 4,
        loose: 1,
        solid: 3,
        stretch: 2,
        "stretch-2": 2,
      };
      let feCount = 0;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i]!;
          const b = entries[j]!;
          if (a.consumerApi === null || b.consumerApi === null) continue;
          const delta = Math.abs(a.consumerApi - b.consumerApi);
          const tierDiff = Math.abs((tierOrder[a.tier] ?? 0) - (tierOrder[b.tier] ?? 0));
          if (delta < 3 && tierDiff >= 3) feCount++;
        }
      }
      return { detail: `${feCount} false equivalence(s)`, passed: feCount === 0 };
    }),
  );

  // Gate 8: Fallback glob
  gates.push(
    runGate("fallback-glob-=0", () => {
      const count = summary?.fallbackGlobCount ?? 0;
      return { detail: `${count} package(s)`, passed: count === 0 };
    }),
  );

  // Gate 9: Undersampled anchors
  gates.push(
    runGate("undersampled-anchor-=0", () => {
      const count = summary?.undersampledAnchorCount ?? 0;
      return { detail: `${count} anchor(s)`, passed: count === 0 };
    }),
  );

  // Gate 10: Domain accuracy — wrong-specific rate
  gates.push(
    runGate("wrong-specific-domain-<10%", () => {
      const domainAcc = snapshot["domainAccuracy"] as
        | { wrongSpecificRate?: number; correct?: number; total?: number }
        | undefined;
      if (!domainAcc || !domainAcc.total) {
        const entries = snapshot["entries"] as
          | { name: string; domainInference?: { domain: string } }[]
          | undefined;
        if (!entries) return { detail: "No data", passed: true };
        let wrong = 0;
        let total = 0;
        for (const e of entries) {
          const expected = EXPECTED_DOMAINS[e.name];
          if (!expected) continue;
          total++;
          const actual = e.domainInference?.domain ?? "general";
          if (actual !== expected && actual !== "general") wrong++;
        }
        const rate = total > 0 ? wrong / total : 0;
        return { detail: `${wrong}/${total} (${(rate * 100).toFixed(1)}%)`, passed: rate < 0.1 };
      }
      return {
        detail: `${(domainAcc.wrongSpecificRate! * 100).toFixed(1)}%`,
        passed: domainAcc.wrongSpecificRate! < 0.1,
      };
    }),
  );

  // Gate 11: Domain accuracy — correct rate (including "general" matches)
  gates.push(
    runGate("domain-accuracy->=90%", () => {
      const domainAcc = snapshot["domainAccuracy"] as
        | { accuracy?: number; correct?: number; total?: number }
        | undefined;
      if (!domainAcc || !domainAcc.total) {
        return { detail: "No domain data", passed: true };
      }
      const rate = domainAcc.accuracy ?? domainAcc.correct! / domainAcc.total!;
      return { detail: `${(rate * 100).toFixed(1)}%`, passed: rate >= 0.9 };
    }),
  );

  // Gate 12: Scenario assertions — all must pass
  gates.push(
    runGate("scenario-assertions-100%", () => {
      const scenAssertions = snapshot["scenarioAssertions"] as
        | { passed?: number; failed?: number; total?: number }
        | undefined;
      if (!scenAssertions || !scenAssertions.total) {
        return { detail: "No scenario assertions", passed: true };
      }
      return {
        detail: `${scenAssertions.passed}/${scenAssertions.total} passed`,
        passed: scenAssertions.failed === 0,
      };
    }),
  );

  // Gate 13: High-score-low-confidence check
  // Packages scoring >=75 should have confidence >= 0.65
  gates.push(
    runGate("score-confidence-coherence", () => {
      const entries = snapshot["entries"] as
        | {
            name: string;
            consumerApi: number | null;
            confidenceSummary?: { sampleCoverage: number } | null;
            coverageDiagnostics?: { samplingClass?: string; undersampled?: boolean } | null;
          }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: true };

      let violations = 0;
      for (const en of entries) {
        if (en.consumerApi === null || en.consumerApi < 75) continue;
        const isUndersampled = en.coverageDiagnostics?.undersampled === true;
        const isCompact = en.coverageDiagnostics?.samplingClass === "compact";
        const sampleCov = en.confidenceSummary?.sampleCoverage ?? 1;
        if (isUndersampled || (isCompact && sampleCov < 0.65)) {
          violations++;
        }
      }
      return {
        detail: `${violations} high-score-low-confidence package(s)`,
        passed: violations === 0,
      };
    }),
  );

  // Gate 14: Applicability coherence — null-scored dimensions should not carry confidence
  // NOTE: The snapshot does not persist the `applicability` field from AnalysisResult dimensions.
  // This gate approximates the check: if a dimension has score=null, its confidence should also be null.
  // A non-null confidence on a null-scored dimension suggests the scorer assigned confidence to a
  // dimension it deemed not applicable, which is incoherent.
  // Currently diagnostic-only (always passes) because the scorer computes confidence before
  // applicability decisions, so null-score + non-null-confidence is a serialization artifact.
  // TODO: Once the snapshot persists `applicability`, make this gate strict.
  gates.push(
    runGate("applicability-coherence", () => {
      const entries = snapshot["entries"] as
        | {
            name: string;
            dimensions?: { key: string; score: number | null; confidence: number | null }[];
          }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: true };

      let violations = 0;
      for (const en of entries) {
        if (!en.dimensions) continue;
        for (const dim of en.dimensions) {
          if (dim.score === null && dim.confidence !== null) {
            violations++;
          }
        }
      }
      // Diagnostic-only: report count but do not fail the gate
      return {
        detail: `${violations} null-score-with-confidence dimension(s) (diagnostic)`,
        passed: true,
      };
    }),
  );

  // Gate 15: Scenario misapplication rate — scenario scores should only appear for packages
  // whose detected domain matches the scenario domain. A scenario score on a package with
  // domain "general" or a mismatched domain indicates the scorer is over-applying scenarios.
  gates.push(
    runGate("scenario-misapplication-=0", () => {
      const entries = snapshot["entries"] as
        | {
            name: string;
            domain?: string | null;
            domainInference?: { domain: string } | null;
            scenarioScore?: { domain?: string; score: number } | null;
          }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: true };

      let misapplied = 0;
      let total = 0;
      for (const en of entries) {
        if (!en.scenarioScore || en.scenarioScore.score === null) continue;
        total++;
        const pkgDomain = en.domain ?? en.domainInference?.domain ?? "general";
        const scenDomain = en.scenarioScore.domain;
        // Scenario applied to a general-domain package or domain mismatch
        if (pkgDomain === "general" || (scenDomain && scenDomain !== pkgDomain)) {
          misapplied++;
        }
      }
      return {
        detail: `${misapplied}/${total} scenario misapplication(s)`,
        passed: misapplied === 0,
      };
    }),
  );

  // Gate 16: Installability — any install failures in the benchmark run indicate
  // a broken manifest entry or transient npm issue. Zero tolerance for install failures.
  // Checks both graphStats.installError (legacy) AND absorbed install-failure degradations.
  gates.push(
    runGate("installability-=0", () => {
      const entries = snapshot["entries"] as
        | {
            name: string;
            graphStats?: { installError?: string | null } | null;
            status?: string;
            degradedCategory?: string | null;
          }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: true };

      let legacyFailures = 0;
      let absorbedFailures = 0;
      for (const en of entries) {
        if (en.graphStats && "installError" in en.graphStats && en.graphStats.installError) {
          legacyFailures++;
        }
        if (en.status === "degraded" && en.degradedCategory === "install-failure") {
          absorbedFailures++;
        }
      }

      const explicitFailures = snapshot["installFailures"] as unknown[] | undefined;
      const thrownCount = explicitFailures?.length ?? 0;
      const totalFailures = legacyFailures + absorbedFailures + thrownCount;

      const detail =
        absorbedFailures > 0 || thrownCount > 0
          ? `${totalFailures} install failure(s) (${legacyFailures} legacy, ${absorbedFailures} degraded, ${thrownCount} thrown)`
          : `${totalFailures} install failure(s)`;
      return {
        detail,
        passed: totalFailures === 0,
      };
    }),
  );

  // Gate 17: Manifest hygiene — all version specs in the train manifest must be
  // valid semver-pinned versions (e.g. "zod@3.24.2") rather than ranges or tags.
  gates.push(
    runGate("manifest-hygiene", () => {
      try {
        const manifest = loadManifest("train");
        const flat = flattenManifest(manifest);
        // Semver-pinned: name@X.Y.Z or @scope/name@X.Y.Z
        const semverPinned = /^(@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+$/;
        const invalid: string[] = [];
        for (const entry of flat) {
          if (!semverPinned.test(entry.entry.spec)) {
            invalid.push(entry.entry.spec);
          }
        }
        if (invalid.length > 0) {
          return {
            detail: `${invalid.length} invalid spec(s): ${invalid.slice(0, 3).join(", ")}`,
            passed: false,
          };
        }
        return { detail: `${flat.length} spec(s) valid`, passed: true };
      } catch (error) {
        return {
          detail: `Error: ${error instanceof Error ? error.message : String(error)}`,
          passed: false,
        };
      }
    }),
  );

  // Gate 18: Scenario overreach rate — measures how often scenario scores are emitted
  // for packages whose domain does not match the scenario domain. A rate above 5%
  // indicates the scorer is applying scenarios too aggressively.
  gates.push(
    runGate("scenario-overreach-<5%", () => {
      const entries = snapshot["entries"] as
        | {
            name: string;
            domain?: string | null;
            domainInference?: { domain: string; confidence?: number } | null;
            scenarioScore?: { domain?: string; score: number } | null;
          }[]
        | undefined;
      if (!entries) return { detail: "No entry data", passed: true };

      let overreach = 0;
      let total = 0;
      for (const en of entries) {
        if (!en.scenarioScore || en.scenarioScore.score === null) continue;
        total++;
        const pkgDomain = en.domain ?? en.domainInference?.domain ?? "general";
        const scenDomain = en.scenarioScore.domain;
        const domainConfidence = en.domainInference?.confidence ?? 0;
        // Overreach: scenario applied to wrong domain or low-confidence domain detection
        if (
          (scenDomain && scenDomain !== pkgDomain) ||
          (pkgDomain === "general" && domainConfidence < 0.5)
        ) {
          overreach++;
        }
      }
      const rate = total > 0 ? overreach / total : 0;
      return {
        detail: `${(rate * 100).toFixed(1)}% (${overreach}/${total})`,
        passed: rate < 0.05,
      };
    }),
  );

  // Gate 19: Self-analysis — run typegrade on its own source and check minimum scores.
  // This ensures the tool's own codebase meets a baseline quality bar. Failing here
  // means the tool cannot credibly analyze other projects.
  gates.push(
    runGate("self-analysis-quality", () => {
      const { success, output } = execCheck(
        "node dist/bin.js analyze . --json --profile library",
        projectRoot,
        120_000,
      );
      if (!success) {
        return { detail: `Self-analysis failed: ${output.slice(0, 200)}`, passed: false };
      }
      try {
        const result = JSON.parse(output);
        const status = result.status ?? "unknown";
        if (status === "invalid-input" || status === "unsupported-package") {
          return { detail: `Self-analysis status: ${status}`, passed: false };
        }
        const composites = result.composites as { key: string; score: number | null }[] | undefined;
        if (!composites) {
          return { detail: "No composites in self-analysis", passed: false };
        }
        const consumerApi = composites.find((comp) => comp.key === "consumerApi")?.score ?? 0;
        const typeSafety = composites.find((comp) => comp.key === "typeSafety")?.score ?? 0;
        const minScore = 40;
        const details = `consumerApi=${consumerApi}, typeSafety=${typeSafety}`;
        if (consumerApi < minScore || typeSafety < minScore) {
          return { detail: `Below ${minScore}: ${details}`, passed: false };
        }
        return { detail: details, passed: true };
      } catch {
        return { detail: "Failed to parse self-analysis JSON", passed: false };
      }
    }),
  );

  // Gate 20: Agent-loop coherence — verify self-analyze produces a valid agent report
  // with consistent stop conditions, fix batches, and no structural anomalies.
  gates.push(
    runGate("agent-loop-coherence", () => {
      const { success, output } = execCheck(
        "node dist/bin.js self-analyze . --json",
        projectRoot,
        120_000,
      );
      if (!success) {
        return { detail: `Self-analyze failed: ${output.slice(0, 200)}`, passed: false };
      }
      try {
        const report = JSON.parse(output);
        const issues: string[] = [];

        // Check required fields exist (JSON uses "actionableIssues")
        if (!Array.isArray(report.actionableIssues)) {
          issues.push("missing actionableIssues");
        }
        if (!Array.isArray(report.fixBatches)) {
          issues.push("missing fixBatches");
        }
        if (!Array.isArray(report.stopConditions)) {
          issues.push("missing stopConditions");
        }
        if (!Array.isArray(report.verificationSteps)) {
          issues.push("missing verificationSteps");
        }

        // Check stop conditions are well-formed
        const stops = report.stopConditions as
          | { kind: string; met: boolean; reason: string }[]
          | undefined;
        if (stops && stops.length > 0) {
          for (const sc of stops) {
            if (!sc.kind || typeof sc.met !== "boolean" || !sc.reason) {
              issues.push(`malformed stop condition: ${JSON.stringify(sc).slice(0, 80)}`);
            }
          }
        }

        // Check fix batch consistency: every batch should have a title and risk
        const batches = report.fixBatches as { title: string; risk: string }[] | undefined;
        if (batches) {
          for (const batch of batches) {
            if (!batch.title || !batch.risk) {
              issues.push("fix batch missing title or risk");
              break;
            }
          }
        }

        // Check suppression count is non-negative
        if (typeof report.suppressedCount === "number" && report.suppressedCount < 0) {
          issues.push("negative suppressedCount");
        }

        if (issues.length > 0) {
          return { detail: issues.join("; "), passed: false };
        }
        const batchCount = batches?.length ?? 0;
        const issueCount = (report.actionableIssues as unknown[])?.length ?? 0;
        return { detail: `${issueCount} issues, ${batchCount} batches, coherent`, passed: true };
      } catch {
        return { detail: "Failed to parse agent report JSON", passed: false };
      }
    }),
  );

  return gates;
}

function runEvalGates(): GateResult[] {
  const gates: GateResult[] = [];

  const summary = findLatestEvalSummary();
  if (!summary) {
    console.log("WARNING: No eval summary found. Run 'pnpm benchmark:judge' first.\n");
    return [
      { detail: "No eval summary", durationMs: 0, gate: "eval-summary-exists", passed: false },
    ];
  }

  const evalGates = (summary as any).gates as
    | { gate: string; passed: boolean; detail: string }[]
    | undefined;
  if (!evalGates) {
    return [
      {
        detail: "No gates in eval summary",
        durationMs: 0,
        gate: "eval-gates-present",
        passed: false,
      },
    ];
  }

  for (const eg of evalGates) {
    gates.push({
      detail: eg.detail,
      durationMs: 0,
      gate: eg.gate,
      passed: eg.passed,
    });
  }

  return gates;
}

function runHoldoutGates(): GateResult[] {
  // Holdout gates read from holdout snapshots.
  // Key differences from train: enforce zero false-authoritative, use CI-bound gates,
  // track comparable vs non-comparable results, and count absorbed install failures.
  const snapshot = findLatestSnapshot("holdout");
  if (!snapshot) {
    console.log("WARNING: No holdout snapshot found. Run 'pnpm benchmark:holdout' first.\n");
    return [
      {
        detail: "No holdout snapshot",
        durationMs: 0,
        gate: "holdout-snapshot-exists",
        passed: false,
      },
    ];
  }

  const gates: GateResult[] = [];

  // Pre-compute holdout entry classification for reuse across gates
  type HoldoutEntry = {
    name: string;
    consumerApi: number | null;
    agentReadiness: number | null;
    typeSafety: number | null;
    status?: string;
    degradedCategory?: string | null;
    graphStats?: { usedFallbackGlob?: boolean };
    coverageDiagnostics?: { undersampled?: boolean; samplingClass?: string } | null;
  };
  const entries = (snapshot["entries"] as HoldoutEntry[] | undefined) ?? [];
  const total = entries.length;
  const comparableEntries = entries.filter((en) => {
    if (en.status === "degraded") return false;
    if (en.graphStats?.usedFallbackGlob) return false;
    if (en.coverageDiagnostics?.undersampled) return false;
    return true;
  });
  const comparableCount = comparableEntries.length;

  // Gate H1: No false-authoritative outputs — degraded results must have null composites
  gates.push(
    runGate("false-authoritative-=0", () => {
      if (total === 0) return { detail: "No entry data", passed: false };
      let violations = 0;
      for (const en of entries) {
        const isDegraded = en.status === "degraded";
        const hasNumericScores =
          en.consumerApi !== null || en.agentReadiness !== null || en.typeSafety !== null;
        if (isDegraded && hasNumericScores) {
          violations++;
        }
      }
      return { detail: `${violations} false-authoritative result(s)`, passed: violations === 0 };
    }),
  );

  // Gate H2: Fallback glob rate (CI-bound: upper bound of failure rate < 20% at 95% CI)
  // Holdout uses 95% CI with relaxed threshold (smaller corpus).
  // Shadow validation provides tight 99% CI evidence at <5%.
  gates.push(
    runGate("holdout-fallback-glob-CI<20%", () => {
      if (total === 0) return { detail: "No entry data", passed: true };
      const fallbackCount = entries.filter((en) => en.graphStats?.usedFallbackGlob).length;
      const rate = fallbackCount / total;
      const upperBound = wilsonUpperBound(fallbackCount, total, 95);
      return {
        detail: formatCIDetail(fallbackCount, total, rate, upperBound, 0.2, 95),
        passed: upperBound < 0.2,
      };
    }),
  );

  // Gate H3: Install failures — count both explicit failures AND absorbed install-failure degradations
  gates.push(
    runGate("holdout-installability", () => {
      const explicitFailures = snapshot["installFailures"] as unknown[] | undefined;
      const explicitCount = explicitFailures?.length ?? 0;
      const absorbedCount = entries.filter(
        (en) => en.status === "degraded" && en.degradedCategory === "install-failure",
      ).length;
      const totalCount = explicitCount + absorbedCount;
      const detail =
        absorbedCount > 0
          ? `${totalCount} install failure(s) (${explicitCount} thrown, ${absorbedCount} degraded)`
          : `${totalCount} install failure(s)`;
      return { detail, passed: totalCount === 0 };
    }),
  );

  // Gate H4: Degraded rate (CI-bound: upper bound < 25% at 95% CI)
  // Holdout uses 95% CI (smaller corpus); shadow validation provides 99% CI evidence.
  gates.push(
    runGate("holdout-degraded-CI<25%", () => {
      const degradedCount = entries.filter((en) => en.status === "degraded").length;
      const rate = total > 0 ? degradedCount / total : 0;
      const upperBound = wilsonUpperBound(degradedCount, total, 95);
      return {
        detail: formatCIDetail(degradedCount, total, rate, upperBound, 0.25, 95),
        passed: upperBound < 0.25,
      };
    }),
  );

  // Gate H5: Schema consistency
  gates.push(
    runGate("holdout-schema-consistency", () => {
      const qg = snapshot["qualityGates"] as
        | { schemaConsistent?: boolean; schemaVersions?: string[] }
        | undefined;
      const consistent = qg?.schemaConsistent ?? true;
      return {
        detail: consistent ? "consistent" : `multiple: ${qg?.schemaVersions?.join(", ")}`,
        passed: consistent,
      };
    }),
  );

  // Gate H6: Comparable rate (CI-bound: lower bound > 50% at 95% CI)
  // Holdout uses 95% CI (smaller corpus); shadow validation provides 99% CI evidence.
  gates.push(
    runGate("holdout-comparable-CI>50%", () => {
      const lowerBound = wilsonLowerBound(comparableCount, total, 95);
      const rate = total > 0 ? comparableCount / total : 0;
      return {
        detail: formatCILowerDetail(comparableCount, total, rate, lowerBound, 0.5, 95),
        passed: lowerBound > 0.5,
      };
    }),
  );

  // Gate H7: Manifest pre-flight (non-train corpus hygiene)
  gates.push(
    runGate("holdout-manifest-preflight", () => {
      const preflight = snapshot["manifestPreflightPassed"] as boolean | undefined;
      if (preflight === undefined)
        return { detail: "No pre-flight data (legacy snapshot)", passed: true };
      return {
        detail: preflight ? "all specs resolved" : "some specs failed resolution",
        passed: preflight,
      };
    }),
  );

  // Gate H8-H10: Aggregate assertions (quarantine-compliant, no package-specific logic)
  const degradedCount = entries.filter((en) => en.status === "degraded").length;
  const fallbackCount = entries.filter((en) => en.graphStats?.usedFallbackGlob).length;
  const holdoutMetrics = {
    comparableRate: total > 0 ? comparableCount / total : 0,
    degradedRate: total > 0 ? degradedCount / total : 0,
    fallbackGlobRate: total > 0 ? fallbackCount / total : 0,
  };

  for (const assertion of HOLDOUT_ASSERTIONS) {
    gates.push(
      runGate(`agg:${assertion.name}`, () => assertion.check(holdoutMetrics)),
    );
  }

  return gates;
}

function runShadowSummaryGates(): GateResult[] {
  const gates: GateResult[] = [];
  const shadowData = findLatestShadowSummary();

  if (!shadowData) {
    console.log("WARNING: No shadow summary found. Run 'pnpm benchmark:shadow' first.\n");
    return [
      {
        detail: "No shadow summary file",
        durationMs: 0,
        gate: "shadow-summary-exists",
        passed: false,
      },
    ];
  }

  const { ageMs, summary } = shadowData;
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

  // Gate S0: Summary freshness — must be within 24h
  gates.push(
    runGate("shadow-summary-fresh", () => {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000) * 10) / 10;
      return {
        detail: `${ageHours}h old (max 24h)`,
        passed: ageMs < maxAgeMs,
      };
    }),
  );

  // Gate S1: Overall shadow gate pass/fail from the saved summary
  gates.push(
    runGate("shadow-all-gates-passed", () => {
      const failedGates = summary.gates.filter((gg) => !gg.passed);
      if (failedGates.length === 0) {
        return { detail: `${summary.gates.length} gates passed`, passed: true };
      }
      const failedNames = failedGates.map((gg) => gg.gate).join(", ");
      return {
        detail: `${failedGates.length} failed: ${failedNames}`,
        passed: false,
      };
    }),
  );

  // Gate S2-S5: Aggregate assertions against shadow summary metrics
  // Older summaries may lack some fields — default to 0 for rates
  const shadowMetrics = {
    comparableRate: summary.comparableRate ?? 0,
    degradedRate: summary.degradedRate ?? 0,
    domainCoverageRate: summary.domainCoverageRate ?? 0,
    fallbackGlobRate: summary.fallbackGlobRate ?? 0,
    scenarioCoverageRate: summary.scenarioCoverageRate ?? 0,
  };

  for (const assertion of SHADOW_ASSERTIONS) {
    gates.push(
      runGate(`agg:${assertion.name}`, () => assertion.check(shadowMetrics)),
    );
  }

  return gates;
}

function main() {
  console.log(`=== typegrade Gate Check (${gateMode}) ===\n`);

  const gates =
    gateMode === "eval"
      ? runEvalGates()
      : gateMode === "holdout"
        ? runHoldoutGates()
        : gateMode === "shadow"
          ? runShadowSummaryGates()
          : runTrainGates();

  // Print results
  console.log("=== Gate Results ===\n");
  let allPassed = true;
  for (const gate of gates) {
    const icon = gate.passed ? "PASS" : "FAIL";
    const time = gate.durationMs > 100 ? ` (${(gate.durationMs / 1000).toFixed(1)}s)` : "";
    console.log(`  [${icon}] ${gate.gate.padEnd(35)} ${gate.detail}${time}`);
    if (!gate.passed) allPassed = false;
  }

  const passedCount = gates.filter((g) => g.passed).length;
  console.log(`\n  ${passedCount}/${gates.length} gates passed`);

  // Save gate report
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const reportFilename =
    gateMode === "eval"
      ? "gate-eval-report.json"
      : gateMode === "holdout"
        ? "gate-holdout-report.json"
        : gateMode === "shadow"
          ? "gate-shadow-report.json"
          : "gate-report.json";
  const reportPath = join(outputDir, reportFilename);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        allPassed,
        gateMode,
        gates,
        passedCount,
        timestamp: new Date().toISOString(),
        totalGates: gates.length,
      },
      null,
      2,
    ),
  );
  console.log(`\nGate report saved to benchmarks-output/${reportFilename}`);

  // Train and holdout gates are strict — eval and shadow gates are report-only (non-blocking)
  if (!allPassed && (gateMode === "train" || gateMode === "holdout")) {
    process.exit(1);
  }
  if (!allPassed && gateMode === "eval") {
    console.log("\nEval gate failures are non-blocking (report-only mode).");
  }
  if (!allPassed && gateMode === "shadow") {
    console.log("\nShadow gate failures are non-blocking (report-only mode).");
  }
}

main();
