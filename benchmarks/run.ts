#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AnalysisResult, DomainKey, ScenarioScore } from "../src/types.js";
import { PAIRWISE_ASSERTIONS, SCENARIO_ASSERTIONS } from "./assertions.js";
import { join } from "node:path";
import { scorePackage } from "../src/package-scorer.js";

const manifestPath = join(import.meta.dirname, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

interface ManifestEntry {
  spec: string;
  typesVersion?: string;
}

interface BenchmarkEntry {
  agentReadiness: number | null;
  consumerApi: number | null;
  domainFitScore: number | null;
  name: string;
  result: AnalysisResult;
  scenarioScore: ScenarioScore | null;
  tier: string;
  typeSafety: number | null;
}

function parseManifestEntry(entry: string | { spec: string; typesVersion?: string }): ManifestEntry {
  if (typeof entry === "string") {
    return { spec: entry };
  }
  return entry;
}

function getCompositeScore(result: AnalysisResult, key: string): number | null {
  return result.composites.find((comp) => comp.key === key)?.score ?? null;
}

function main() {
  const entries: BenchmarkEntry[] = [];

  for (const [tier, packages] of Object.entries(manifest.packages) as [string, (string | { spec: string; typesVersion?: string })[]][]) {
    for (const pkg of packages) {
      const { spec, typesVersion } = parseManifestEntry(pkg);
      const name = spec.replaceAll(/@[\d.]+$/g, "");
      console.log(`Scoring ${spec}...`);
      try {
        const result = scorePackage(spec, typesVersion ? { typesVersion } : undefined);

        // Extract domain and scenario scores (now computed inside analyzer with actual surface)
        const domainFitScore = result.domainScore?.score ?? null;
        const scenarioScore: ScenarioScore | null = result.scenarioScore ?? null;

        entries.push({
          agentReadiness: getCompositeScore(result, "agentReadiness"),
          consumerApi: getCompositeScore(result, "consumerApi"),
          domainFitScore,
          name,
          result,
          scenarioScore,
          tier,
          typeSafety: getCompositeScore(result, "typeSafety"),
        });
        const domainStr = domainFitScore !== null ? ` | domainFit: ${domainFitScore}` : "";
        const scenStr = scenarioScore ? ` | scenario: ${scenarioScore.score}(${scenarioScore.passedScenarios}/${scenarioScore.totalScenarios})` : "";
        const fallbackStr = result.graphStats.usedFallbackGlob ? " [FALLBACK]" : "";
        console.log(`  consumerApi: ${getCompositeScore(result, "consumerApi")} | agentReadiness: ${getCompositeScore(result, "agentReadiness")} | typeSafety: ${getCompositeScore(result, "typeSafety")}${domainStr}${scenStr}${fallbackStr}`);
      } catch (error) {
        console.error(`  FAILED: ${error}`);
      }
    }
  }

  // Print ranking table
  console.log("\n=== Benchmark Results ===\n");
  console.log(`${"Package".padEnd(25)}${"Tier".padEnd(12)}${"ConsumerAPI".padEnd(14)}${"AgentReady".padEnd(14)}${"TypeSafety".padEnd(14)}${"DomainFit".padEnd(14)}${"Scenario".padEnd(14)}Fallback`);
  console.log("-".repeat(121));

  const sorted = entries.toSorted((lhs, rhs) => (rhs.consumerApi ?? 0) - (lhs.consumerApi ?? 0));
  for (const entry of sorted) {
    const scenarioStr = entry.scenarioScore
      ? `${entry.scenarioScore.score} (${entry.scenarioScore.passedScenarios}/${entry.scenarioScore.totalScenarios})`
      : "n/a";
    const fallbackStr = entry.result.graphStats.usedFallbackGlob ? "YES" : "no";
    console.log(
      `${entry.name.padEnd(25)}${entry.tier.padEnd(12)}${String(entry.consumerApi ?? "n/a").padEnd(14)}${String(entry.agentReadiness ?? "n/a").padEnd(14)}${String(entry.typeSafety ?? "n/a").padEnd(14)}${String(entry.domainFitScore ?? "n/a").padEnd(14)}${scenarioStr.padEnd(14)}${fallbackStr}`,
    );
  }

  // Run pairwise assertions
  console.log("\n=== Pairwise Assertions ===\n");
  let mustPassPassed = 0;
  let mustPassFailed = 0;
  let diagnosticPassed = 0;
  let diagnosticFailed = 0;
  let hardDiagPassed = 0;
  let hardDiagFailed = 0;

  const assertionResults: {
    assertion: string;
    class: string;
    delta?: number | null;
    higherScore?: number | null;
    lowerScore?: number | null;
    minDelta?: number;
    result: "pass" | "fail" | "skip";
  }[] = [];

  for (const assertion of PAIRWISE_ASSERTIONS) {
    const higher = entries.find((en) => en.name === assertion.higher);
    const lower = entries.find((en) => en.name === assertion.lower);

    if (!higher || !lower) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} (missing data)`);
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, result: "skip" });
      continue;
    }

    let higherScore: number | null = undefined as unknown as number | null;
    let lowerScore: number | null = undefined as unknown as number | null;

    if (assertion.composite === "consumerApi") {
      higherScore = higher.consumerApi;
      lowerScore = lower.consumerApi;
    } else if (assertion.composite === "agentReadiness") {
      higherScore = higher.agentReadiness;
      lowerScore = lower.agentReadiness;
    } else {
      higherScore = higher.typeSafety;
      lowerScore = lower.typeSafety;
    }

    const delta = (higherScore ?? 0) - (lowerScore ?? 0);
    const meetsMinDelta = assertion.minDelta ? delta >= assertion.minDelta : true;
    const passes = higherScore !== null && lowerScore !== null && higherScore > lowerScore && meetsMinDelta;

    // Ambiguous assertions are informational only — never counted as pass/fail
    if (assertion.class === "ambiguous") {
      const statusLabel = passes ? "OK" : "NOTE";
      console.log(`${statusLabel} (ambiguous): ${assertion.higher} (${higherScore}) vs ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: passes ? "pass" : "skip" });
      continue;
    }

    if (passes) {
      let label = `PASS (${assertion.class})`;
      if (assertion.class === "must-pass") {
        label = "PASS";
      } else if (assertion.class === "hard-diagnostic") {
        label = "PASS (hard)";
      }
      console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
      if (assertion.class === "must-pass") {
        mustPassPassed++;
      } else if (assertion.class === "hard-diagnostic") {
        hardDiagPassed++;
      } else {
        diagnosticPassed++;
      }
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "pass" });
    } else {
      if (meetsMinDelta || higherScore === null || lowerScore === null || higherScore <= lowerScore) {
        let label = `WARN (${assertion.class})`;
        if (assertion.class === "must-pass") {
          label = "FAIL";
        } else if (assertion.class === "hard-diagnostic") {
          label = "FAIL (hard)";
        }
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
      } else {
        let label = `MARGIN (${assertion.class})`;
        if (assertion.class === "must-pass") {
          label = "MARGIN";
        }
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) but delta ${delta} < minDelta ${assertion.minDelta} [${assertion.composite}]`);
      }
      if (assertion.class === "must-pass") {
        mustPassFailed++;
      } else if (assertion.class === "hard-diagnostic") {
        hardDiagFailed++;
      } else {
        diagnosticFailed++;
      }
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "fail" });
    }
  }

  // Run scenario assertions
  console.log("\n=== Scenario Assertions ===\n");
  let scenarioAssertionPassed = 0;
  let scenarioAssertionFailed = 0;

  for (const assertion of SCENARIO_ASSERTIONS) {
    const higher = entries.find((en) => en.name === assertion.higher);
    const lower = entries.find((en) => en.name === assertion.lower);

    if (!higher || !lower) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} on ${assertion.domain} ${assertion.scoreType} (missing data)`);
      continue;
    }

    let higherScore: number | null = null;
    let lowerScore: number | null = null;

    if (assertion.scoreType === "scenarioScore") {
      higherScore = higher.scenarioScore?.score ?? null;
      lowerScore = lower.scenarioScore?.score ?? null;
    } else if (assertion.scoreType === "domainFitScore") {
      higherScore = higher.domainFitScore;
      lowerScore = lower.domainFitScore;
    } else if (assertion.scoreType === "agentReadiness") {
      higherScore = higher.agentReadiness;
      lowerScore = lower.agentReadiness;
    }

    if (higherScore === null || lowerScore === null) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} on ${assertion.domain} ${assertion.scoreType} (no score)`);
      continue;
    }

    const delta = higherScore - lowerScore;
    const meetsMinDelta = assertion.minDelta !== undefined ? delta >= assertion.minDelta : delta > 0;

    if (meetsMinDelta) {
      console.log(`PASS (${assertion.class}): ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.domain} ${assertion.scoreType}]`);
      scenarioAssertionPassed++;
    } else {
      console.log(`FAIL (${assertion.class}): ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.domain} ${assertion.scoreType}]`);
      scenarioAssertionFailed++;
    }
  }

  const totalMustPass = mustPassPassed + mustPassFailed;
  const totalDiagnostic = diagnosticPassed + diagnosticFailed;
  const totalHardDiag = hardDiagPassed + hardDiagFailed;
  const totalScenarioAssertions = scenarioAssertionPassed + scenarioAssertionFailed;

  console.log("\n=== Summary ===\n");
  console.log(`Must-pass: ${mustPassPassed}/${totalMustPass} passed`);
  console.log(`Hard-diagnostic: ${hardDiagPassed}/${totalHardDiag} passed`);
  console.log(`Diagnostic: ${diagnosticPassed}/${totalDiagnostic} passed (warnings only)`);
  console.log(`Scenario assertions: ${scenarioAssertionPassed}/${totalScenarioAssertions} passed`);

  // Check fallback glob usage
  const fallbackPackages = entries.filter((en) => en.result.graphStats.usedFallbackGlob);
  if (fallbackPackages.length > 0) {
    console.log(`\nWARNING: ${fallbackPackages.length} package(s) used fallback glob:`);
    for (const pkg of fallbackPackages) {
      console.log(`  - ${pkg.name}`);
    }
  }

  // Persist results to JSON
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const snapshot = {
    assertions: assertionResults,
    entries: entries.map((en) => ({
      agentReadiness: en.agentReadiness,
      caveats: en.result.caveats,
      confidenceSummary: en.result.confidenceSummary ?? null,
      consumerApi: en.consumerApi,
      dedupStats: en.result.dedupStats,
      dimensions: en.result.dimensions.map((dim) => ({
        confidence: dim.confidence ?? null,
        key: dim.key,
        metrics: dim.metrics,
        score: dim.score,
      })),
      domain: en.result.domainInference?.domain ?? null,
      domainFitScore: en.domainFitScore,
      domainInference: en.result.domainInference ?? null,
      explainability: en.result.explainability ?? null,
      graphStats: en.result.graphStats,
      name: en.name,
      scenarioDiagnostics: en.result.scenarioDiagnostics ?? null,
      scenarioScore: en.scenarioScore ?? null,
      tier: en.tier,
      topIssues: en.result.topIssues.slice(0, 5),
      typeSafety: en.typeSafety,
    })),
    scenarioAssertions: {
      failed: scenarioAssertionFailed,
      passed: scenarioAssertionPassed,
      total: totalScenarioAssertions,
    },
    summary: {
      diagnostic: { failed: diagnosticFailed, passed: diagnosticPassed, total: totalDiagnostic },
      fallbackGlobCount: fallbackPackages.length,
      hardDiagnostic: { failed: hardDiagFailed, passed: hardDiagPassed, total: totalHardDiag },
      mustPass: { failed: mustPassFailed, passed: mustPassPassed, total: totalMustPass },
    },
    timestamp: new Date().toISOString(),
  };

  const filename = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  writeFileSync(join(resultsDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nResults saved to benchmarks/results/${filename}`);

  // Exit code 1 only on must-pass failures
  if (mustPassFailed > 0) {
    process.exit(1);
  }
}

main();
