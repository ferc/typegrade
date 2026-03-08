#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AnalysisResult, CoverageDiagnostics, DomainKey, ScenarioScore } from "../src/types.js";
import { EXPECTED_DOMAINS, PAIRWISE_ASSERTIONS, SCENARIO_ASSERTIONS } from "./assertions.js";
import { join } from "node:path";
import { scorePackage } from "../src/package-scorer.js";
import { flattenManifest, loadManifest, loadManifestByFilename, normalizeEntry, samplePool } from "./split-loader.js";
import type { BenchmarkSplit, ManifestEntry } from "./types.js";

// Parse CLI flags
const args = process.argv.slice(2);
const holdoutMode = args.includes("--holdout");
const evalMode = args.includes("--eval");
const poolSampleIdx = args.indexOf("--pool-sample");
const poolSampleCount = poolSampleIdx >= 0 ? Number.parseInt(args[poolSampleIdx + 1] ?? "5", 10) : 0;
const poolCountIdx = args.indexOf("--count");
const poolCount = poolCountIdx >= 0 ? Number.parseInt(args[poolCountIdx + 1] ?? "20", 10) : 0;
const seedIdx = args.indexOf("--seed");
const seed = seedIdx >= 0 ? Number.parseInt(args[seedIdx + 1] ?? "42", 10) : Date.now();
const manifestFlag = args.find((a) => a.startsWith("--manifest="));

// Determine corpus split
let corpusSplit: BenchmarkSplit | "holdout" | "pool" = "train";
if (holdoutMode) corpusSplit = "holdout";
else if (evalMode) corpusSplit = "eval-fixed";
else if (poolSampleCount > 0 || poolCount > 0) corpusSplit = poolCount > 0 ? "eval-pool" : "pool";

function resolveManifestFilename(): string {
  if (manifestFlag) return manifestFlag.split("=")[1]!;
  if (holdoutMode) return "manifest.holdout.json";
  if (evalMode) return "manifest.eval.fixed.json";
  if (poolCount > 0) return "manifest.eval.pool.json";
  return "manifest.train.json";
}

const manifestFilename = resolveManifestFilename();

interface ManifestEntryParsed {
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

function parseManifestEntry(entry: ManifestEntry): ManifestEntryParsed {
  if (typeof entry === "string") return { spec: entry };
  return entry;
}

function getCompositeScore(result: AnalysisResult, key: string): number | null {
  return result.composites.find((comp) => comp.key === key)?.score ?? null;
}

function main() {
  // Load manifest with split-aware loader
  let packages: { tier: string; entry: ManifestEntry }[] = [];

  if (poolCount > 0) {
    // Pool sampling mode — stratified sample from eval-pool
    const manifest = loadManifest("eval-pool");
    const { sampled, manifestHash } = samplePool(manifest, { count: poolCount, seed });
    packages = sampled.map((s) => ({ entry: s.entry as ManifestEntry, tier: s.tier }));
    console.log(`Pool sample: ${sampled.length} packages (seed=${seed}, manifestHash=${manifestHash})\n`);
  } else if (poolSampleCount > 0) {
    // Legacy pool-sample mode (from any manifest)
    const manifest = loadManifestByFilename(manifestFilename);
    const flat = flattenManifest(manifest);

    // Fisher-Yates shuffle with seeded PRNG
    const rng = mulberry32(seed);
    for (let i = flat.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [flat[i], flat[j]] = [flat[j]!, flat[i]!];
    }
    const sampled = flat.slice(0, Math.min(poolSampleCount, flat.length));
    packages = sampled.map((s) => ({ entry: s.entry as ManifestEntry, tier: s.tier }));
    console.log(`Pool sample: ${sampled.length} packages (seed=${seed})\n`);
  } else {
    const manifest = loadManifestByFilename(manifestFilename);
    packages = flattenManifest(manifest).map((f) => ({ entry: f.entry as ManifestEntry, tier: f.tier }));
  }

  console.log(`Corpus: ${corpusSplit} (manifest: ${manifestFilename})\n`);

  const entries: BenchmarkEntry[] = [];

  for (const { tier, entry } of packages) {
    const normalized = normalizeEntry(entry);
    const { spec, typesVersion } = normalized;
    const name = spec.replaceAll(/@[\d.]+$/g, "");
    console.log(`Scoring ${spec}...`);
    try {
      const result = scorePackage(spec, typesVersion ? { typesVersion } : undefined);
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

  // Run pairwise assertions (train split only)
  const isTrainSplit = corpusSplit === "train" || corpusSplit === "holdout";
  let mustPassPassed = 0;
  let mustPassFailed = 0;
  let diagnosticPassed = 0;
  let diagnosticFailed = 0;
  let hardDiagPassed = 0;
  let hardDiagFailed = 0;
  let scenarioAssertionPassed = 0;
  let scenarioAssertionFailed = 0;

  const assertionResults: {
    assertion: string;
    class: string;
    delta?: number | null;
    higherScore?: number | null;
    lowerScore?: number | null;
    minDelta?: number;
    result: "pass" | "fail" | "skip";
  }[] = [];

  if (isTrainSplit) {
    console.log("\n=== Pairwise Assertions ===\n");
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

      if (assertion.class === "ambiguous") {
        const statusLabel = passes ? "OK" : "NOTE";
        console.log(`${statusLabel} (ambiguous): ${assertion.higher} (${higherScore}) vs ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
        assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: passes ? "pass" : "skip" });
        continue;
      }

      if (passes) {
        let label = `PASS (${assertion.class})`;
        if (assertion.class === "must-pass") label = "PASS";
        else if (assertion.class === "hard-diagnostic") label = "PASS (hard)";
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
        if (assertion.class === "must-pass") mustPassPassed++;
        else if (assertion.class === "hard-diagnostic") hardDiagPassed++;
        else diagnosticPassed++;
        assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "pass" });
      } else {
        if (meetsMinDelta || higherScore === null || lowerScore === null || higherScore <= lowerScore) {
          let label = `WARN (${assertion.class})`;
          if (assertion.class === "must-pass") label = "FAIL";
          else if (assertion.class === "hard-diagnostic") label = "FAIL (hard)";
          console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
        } else {
          let label = `MARGIN (${assertion.class})`;
          if (assertion.class === "must-pass") label = "MARGIN";
          console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) but delta ${delta} < minDelta ${assertion.minDelta} [${assertion.composite}]`);
        }
        if (assertion.class === "must-pass") mustPassFailed++;
        else if (assertion.class === "hard-diagnostic") hardDiagFailed++;
        else diagnosticFailed++;
        assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "fail" });
      }
    }

    // Run scenario assertions
    console.log("\n=== Scenario Assertions ===\n");
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
  }

  const totalMustPass = mustPassPassed + mustPassFailed;
  const totalDiagnostic = diagnosticPassed + diagnosticFailed;
  const totalHardDiag = hardDiagPassed + hardDiagFailed;
  const totalScenarioAssertions = scenarioAssertionPassed + scenarioAssertionFailed;

  if (isTrainSplit) {
    console.log("\n=== Summary ===\n");
    console.log(`Must-pass: ${mustPassPassed}/${totalMustPass} passed`);
    console.log(`Hard-diagnostic: ${hardDiagPassed}/${totalHardDiag} passed`);
    console.log(`Diagnostic: ${diagnosticPassed}/${totalDiagnostic} passed (warnings only)`);
    console.log(`Scenario assertions: ${scenarioAssertionPassed}/${totalScenarioAssertions} passed`);
  }

  // Check fallback glob usage
  const fallbackPackages = entries.filter((en) => en.result.graphStats.usedFallbackGlob);
  if (fallbackPackages.length > 0) {
    console.log(`\nWARNING: ${fallbackPackages.length} package(s) used fallback glob:`);
    for (const pkg of fallbackPackages) {
      console.log(`  - ${pkg.name}`);
    }
  }

  // Domain accuracy
  console.log("\n=== Domain Accuracy ===\n");
  let domainCorrect = 0;
  let domainIncorrect = 0;
  let domainAbstained = 0;
  const domainConfusion: { name: string; expected: string; actual: string }[] = [];

  for (const entry of entries) {
    const expected = EXPECTED_DOMAINS[entry.name];
    if (!expected) continue;
    const actual = entry.result.domainInference?.domain ?? "general";
    if (actual === expected) {
      domainCorrect++;
      console.log(`  OK: ${entry.name.padEnd(25)} expected=${expected.padEnd(12)} actual=${actual}`);
    } else if (actual === "general" && expected !== "general") {
      domainAbstained++;
      console.log(`  ABSTAIN: ${entry.name.padEnd(21)} expected=${expected.padEnd(12)} actual=${actual}`);
    } else {
      domainIncorrect++;
      domainConfusion.push({ actual, expected, name: entry.name });
      console.log(`  WRONG: ${entry.name.padEnd(22)} expected=${expected.padEnd(12)} actual=${actual}`);
    }
  }

  const domainTotal = domainCorrect + domainIncorrect + domainAbstained;
  const domainAccuracy = domainTotal > 0 ? domainCorrect / domainTotal : 0;
  const wrongSpecificRate = domainTotal > 0 ? domainIncorrect / domainTotal : 0;
  console.log(`\n  Correct: ${domainCorrect}/${domainTotal} (${(domainAccuracy * 100).toFixed(1)}%)`);
  console.log(`  Abstained: ${domainAbstained}/${domainTotal}`);
  console.log(`  Wrong-specific: ${domainIncorrect}/${domainTotal} (${(wrongSpecificRate * 100).toFixed(1)}%)`);

  // Check for undersampled packages used as must-pass anchors
  const mustPassPackages = new Set<string>();
  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.class === "must-pass") {
      mustPassPackages.add(assertion.higher);
      mustPassPackages.add(assertion.lower);
    }
  }

  const undersampledAnchors: { name: string; reasons: string[] }[] = [];
  for (const entry of entries) {
    const coverage = entry.result.coverageDiagnostics;
    if (coverage?.undersampled && mustPassPackages.has(entry.name)) {
      undersampledAnchors.push({ name: entry.name, reasons: coverage.undersampledReasons });
    }
  }

  if (undersampledAnchors.length > 0) {
    console.log("\n=== Undersampled Must-Pass Anchors (WARNING) ===\n");
    for (const anchor of undersampledAnchors) {
      console.log(`  ${anchor.name}: ${anchor.reasons.join("; ")}`);
    }
    console.log("\n  NOTE: Undersampled packages should not act as must-pass anchors without an explicit waiver.");
  }

  // Print coverage diagnostics
  console.log("\n=== Coverage Diagnostics ===\n");
  console.log(
    `${"Package".padEnd(25)}${"Source".padEnd(10)}${"Reachable".padEnd(12)}${"Positions".padEnd(12)}${"Decls".padEnd(8)}${"XPkgRefs".padEnd(10)}Undersampled`,
  );
  console.log("-".repeat(95));
  for (const entry of entries) {
    const cov = entry.result.coverageDiagnostics;
    const xrefs = entry.result.graphStats.crossPackageTypeRefs ?? 0;
    if (cov) {
      const undersampledStr = cov.undersampled ? `YES (${cov.undersampledReasons.length} reason(s))` : "no";
      console.log(
        `${entry.name.padEnd(25)}${cov.typesSource.padEnd(10)}${String(cov.reachableFiles).padEnd(12)}${String(cov.measuredPositions).padEnd(12)}${String(cov.measuredDeclarations).padEnd(8)}${String(xrefs).padEnd(10)}${undersampledStr}`,
      );
    } else {
      console.log(`${entry.name.padEnd(25)}${"n/a".padEnd(10)}${"n/a".padEnd(12)}${"n/a".padEnd(12)}${"n/a".padEnd(8)}${"n/a".padEnd(10)}n/a`);
    }
  }

  // Determine output directory based on split
  const isEvalSplit = corpusSplit === "eval-fixed" || corpusSplit === "eval-pool";
  const resultsBaseDir = isEvalSplit
    ? join(import.meta.dirname, "..", "benchmarks-output", "eval-raw")
    : join(import.meta.dirname, "results");

  if (!existsSync(resultsBaseDir)) {
    mkdirSync(resultsBaseDir, { recursive: true });
  }

  const snapshot = {
    assertions: assertionResults,
    entries: entries.map((en) => ({
      agentReadiness: en.agentReadiness,
      caveats: en.result.caveats,
      confidenceSummary: en.result.confidenceSummary ?? null,
      consumerApi: en.consumerApi,
      coverageDiagnostics: en.result.coverageDiagnostics ?? null,
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
      undersampledAnchorCount: undersampledAnchors.length,
      undersampledAnchors: undersampledAnchors.map((a) => a.name),
    },
    corpusSplit,
    domainAccuracy: {
      abstained: domainAbstained,
      accuracy: Math.round(domainAccuracy * 1000) / 1000,
      confusion: domainConfusion,
      correct: domainCorrect,
      total: domainTotal,
      wrongSpecificRate: Math.round(wrongSpecificRate * 1000) / 1000,
    },
    manifestSource: manifestFilename,
    seed: (poolSampleCount > 0 || poolCount > 0) ? seed : undefined,
    timestamp: new Date().toISOString(),
  };

  const filename = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  writeFileSync(join(resultsBaseDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nResults saved to ${isEvalSplit ? "benchmarks-output/eval-raw" : "benchmarks/results"}/${filename}`);

  // Exit code 1 only on must-pass failures in train mode
  if (mustPassFailed > 0 && corpusSplit === "train") {
    process.exit(1);
  }
}

// Seeded PRNG for reproducible pool sampling
function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main();
