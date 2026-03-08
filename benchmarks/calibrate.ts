#!/usr/bin/env tsx
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIMENSION_CONFIGS } from "../src/constants.js";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";

// Build consumer weights dynamically from DIMENSION_CONFIGS
const CONSUMER_WEIGHTS: Record<string, number> = {};
for (const cfg of DIMENSION_CONFIGS) {
  if (cfg.weights.consumerApi) {
    CONSUMER_WEIGHTS[cfg.key] = cfg.weights.consumerApi;
  }
}

interface DimensionSnapshot {
  key: string;
  score: number | null;
  confidence: number | null;
}

interface GraphStatsSnapshot {
  totalEntrypoints: number;
  totalReachable: number;
  totalAfterDedup: number;
  filesDeduped: number;
  dedupByStrategy: Record<string, number>;
  usedFallbackGlob: boolean;
}

interface DomainInferenceSnapshot {
  domain: string;
  confidence: number;
  signals: string[];
}

interface ResultEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  dimensions?: DimensionSnapshot[];
  graphStats?: GraphStatsSnapshot | null;
  domainInference?: DomainInferenceSnapshot | null;
  caveats?: string[];
}

interface BenchmarkSnapshot {
  timestamp: string;
  entries: ResultEntry[];
  assertions: { assertion: string; class: string; result: string; higherScore?: number | null; lowerScore?: number | null; delta?: number | null; minDelta?: number }[];
  summary: {
    mustPass: { passed: number; failed: number; total: number };
    diagnostic: { passed: number; failed: number; total: number };
  };
}

interface AssertionEval {
  assertion: string;
  class: "must-pass" | "diagnostic";
  result: "pass" | "fail" | "skip";
  higherScore: number | null;
  lowerScore: number | null;
  delta: number | null;
  minDelta?: number;
}

function findLatestResults(): BenchmarkSnapshot | null {
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    return null;
  }

  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    return null;
  }

  const latestFile = files[files.length - 1];
  console.log(`Reading latest results: benchmarks/results/${latestFile}\n`);
  return JSON.parse(readFileSync(join(resultsDir, latestFile), "utf8"));
}

function evaluateAssertions(snapshot: BenchmarkSnapshot): AssertionEval[] {
  const scoreMap = new Map<string, number | null>();
  for (const entry of snapshot.entries) {
    scoreMap.set(entry.name, entry.consumerApi);
  }

  return PAIRWISE_ASSERTIONS.map((a) => {
    const higherScore = scoreMap.get(a.higher) ?? null;
    const lowerScore = scoreMap.get(a.lower) ?? null;

    if (higherScore === null || lowerScore === null) {
      return {
        assertion: `${a.higher} > ${a.lower}`,
        class: a.class,
        delta: null,
        higherScore,
        lowerScore,
        minDelta: a.minDelta,
        result: "skip" as const,
      };
    }

    const delta = higherScore - lowerScore;
    const meetsMinDelta = a.minDelta ? delta >= a.minDelta : true;
    const passes = delta > 0 && meetsMinDelta;

    return {
      assertion: `${a.higher} > ${a.lower}`,
      class: a.class,
      delta,
      higherScore,
      lowerScore,
      minDelta: a.minDelta,
      result: passes ? ("pass" as const) : ("fail" as const),
    };
  });
}

function suggestWeightAdjustments(evals: AssertionEval[], entries: ResultEntry[]): string[] {
  const suggestions: string[] = [];

  // Identify packages that appear disproportionately in failures
  const failCounts = new Map<string, { tooHigh: number; tooLow: number }>();

  for (const ev of evals) {
    if (ev.result !== "fail") continue;
    const [higher, lower] = ev.assertion.split(" > ");

    const hEntry = failCounts.get(higher) ?? { tooHigh: 0, tooLow: 0 };
    hEntry.tooLow++;
    failCounts.set(higher, hEntry);

    const lEntry = failCounts.get(lower) ?? { tooHigh: 0, tooLow: 0 };
    lEntry.tooHigh++;
    failCounts.set(lower, lEntry);
  }

  for (const [pkg, counts] of failCounts) {
    const entry = entries.find((e) => e.name === pkg);
    const tier = entry?.tier ?? "unknown";
    const score = entry?.consumerApi ?? "n/a";

    if (counts.tooHigh > 1) {
      suggestions.push(
        `${pkg} (${tier}, score=${score}) is scored TOO HIGH — appears as the wrongly-higher side in ${counts.tooHigh} failed assertion(s). ` +
          `Check if apiSpecificity is over-rewarding broad/simple type patterns.`,
      );
    }
    if (counts.tooLow > 1) {
      suggestions.push(
        `${pkg} (${tier}, score=${score}) is scored TOO LOW — appears as the wrongly-lower side in ${counts.tooLow} failed assertion(s). ` +
          `Check if feature-vector bonuses (branded, discriminated-union, etc.) are under-rewarding this package.`,
      );
    }
  }

  if (suggestions.length === 0) {
    suggestions.push(
      "No single package dominates the failures. Consider reviewing individual assertion pairs for edge cases.",
    );
  }

  return suggestions;
}

function getDimensionScore(entry: ResultEntry, dimensionKey: string): number | null {
  if (!entry.dimensions) return null;
  const dim = entry.dimensions.find((d) => d.key === dimensionKey);
  return dim?.score ?? null;
}

function computePerDimensionConcordance(
  snapshot: BenchmarkSnapshot,
): Record<string, { concordant: number; discordant: number; total: number; rate: number }> {
  const results: Record<string, { concordant: number; discordant: number; total: number; rate: number }> = {};

  const entryMap = new Map<string, ResultEntry>();
  for (const entry of snapshot.entries) {
    entryMap.set(entry.name, entry);
  }

  // Check if dimension data is available
  const hasDimensions = snapshot.entries.some((e) => e.dimensions && e.dimensions.length > 0);

  if (hasDimensions) {
    // Per-dimension concordance: for each dimension, check how many pairwise
    // assertions would pass if scoring was based on that dimension alone
    const dimensionKeys = new Set<string>();
    for (const entry of snapshot.entries) {
      if (entry.dimensions) {
        for (const d of entry.dimensions) {
          dimensionKeys.add(d.key);
        }
      }
    }

    for (const dimKey of dimensionKeys) {
      // Only check consumer dimensions
      if (!CONSUMER_WEIGHTS[dimKey]) continue;

      let concordant = 0;
      let discordant = 0;
      let total = 0;

      for (const assertion of PAIRWISE_ASSERTIONS) {
        if (assertion.composite !== "consumerApi") continue;

        const higherEntry = entryMap.get(assertion.higher);
        const lowerEntry = entryMap.get(assertion.lower);
        if (!higherEntry || !lowerEntry) continue;

        const higherDimScore = getDimensionScore(higherEntry, dimKey);
        const lowerDimScore = getDimensionScore(lowerEntry, dimKey);
        if (higherDimScore === null || lowerDimScore === null) continue;

        total++;
        if (higherDimScore > lowerDimScore) {
          concordant++;
        } else {
          discordant++;
        }
      }

      results[dimKey] = {
        concordant,
        discordant,
        rate: total > 0 ? concordant / total : 0,
        total,
      };
    }
  }

  // Overall concordance based on composite scores
  const scoreMap = new Map<string, number | null>();
  for (const entry of snapshot.entries) {
    scoreMap.set(entry.name, entry.consumerApi);
  }

  let overallConcordant = 0;
  let overallDiscordant = 0;
  let overallTotal = 0;

  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.composite !== "consumerApi") continue;
    const higherScore = scoreMap.get(assertion.higher) ?? null;
    const lowerScore = scoreMap.get(assertion.lower) ?? null;
    if (higherScore === null || lowerScore === null) continue;

    overallTotal++;
    if (higherScore > lowerScore) {
      overallConcordant++;
    } else {
      overallDiscordant++;
    }
  }

  results["composite"] = {
    concordant: overallConcordant,
    discordant: overallDiscordant,
    rate: overallTotal > 0 ? overallConcordant / overallTotal : 0,
    total: overallTotal,
  };

  return results;
}

function computeTieAnalysis(entries: ResultEntry[]): Array<{ pkgA: string; pkgB: string; scoreA: number; scoreB: number; delta: number }> {
  const ties: Array<{ pkgA: string; pkgB: string; scoreA: number; scoreB: number; delta: number }> = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.consumerApi === null || b.consumerApi === null) continue;

      const delta = Math.abs(a.consumerApi - b.consumerApi);
      if (delta < 2) {
        ties.push({
          delta,
          pkgA: a.name,
          pkgB: b.name,
          scoreA: a.consumerApi,
          scoreB: b.consumerApi,
        });
      }
    }
  }

  return ties.sort((a, b) => a.delta - b.delta);
}

function computeMarginAnalysis(evals: AssertionEval[]): Array<{ assertion: string; class: string; delta: number }> {
  return evals
    .filter((ev) => ev.result !== "skip" && ev.delta !== null && ev.delta > 0 && ev.delta < 5 && ev.class === "must-pass")
    .map((ev) => ({
      assertion: ev.assertion,
      class: ev.class,
      delta: ev.delta!,
    }))
    .sort((a, b) => a.delta - b.delta);
}

function recomputeConsumerApi(entry: ResultEntry, weightOverrides: Record<string, number>): number | null {
  if (!entry.dimensions) return entry.consumerApi;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [dimKey, weight] of Object.entries(weightOverrides)) {
    const dimScore = getDimensionScore(entry, dimKey);
    if (dimScore !== null) {
      weightedSum += dimScore * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

function computeWeightSensitivity(
  snapshot: BenchmarkSnapshot,
): Array<{ dimension: string; currentWeight: number; sensitivity: string; assertionsAffectedUp: number; assertionsAffectedDown: number }> {
  const sensitivity: Array<{ dimension: string; currentWeight: number; sensitivity: string; assertionsAffectedUp: number; assertionsAffectedDown: number }> = [];

  const hasDimensions = snapshot.entries.some((e) => e.dimensions && e.dimensions.length > 0);

  const entryMap = new Map<string, ResultEntry>();
  for (const entry of snapshot.entries) {
    entryMap.set(entry.name, entry);
  }

  for (const [dim, weight] of Object.entries(CONSUMER_WEIGHTS)) {
    const totalWeight = Object.values(CONSUMER_WEIGHTS).reduce((a, b) => a + b, 0);
    const proportion = weight / totalWeight;
    const proportionStr = `${(proportion * 100).toFixed(1)}% of total`;

    let assertionsAffectedUp = 0;
    let assertionsAffectedDown = 0;

    if (hasDimensions) {
      // Simulate ±20% perturbation
      for (const direction of [1.2, 0.8] as const) {
        const perturbedWeights = { ...CONSUMER_WEIGHTS };
        perturbedWeights[dim] = weight * direction;

        // Re-compute composite scores with perturbed weights
        const perturbedScores = new Map<string, number | null>();
        for (const entry of snapshot.entries) {
          perturbedScores.set(entry.name, recomputeConsumerApi(entry, perturbedWeights));
        }

        // Check which assertions change outcome
        let changed = 0;
        for (const assertion of PAIRWISE_ASSERTIONS) {
          if (assertion.composite !== "consumerApi") continue;

          const origHigher = entryMap.get(assertion.higher)?.consumerApi ?? null;
          const origLower = entryMap.get(assertion.lower)?.consumerApi ?? null;
          const origPasses = origHigher !== null && origLower !== null && origHigher > origLower;

          const pertHigher = perturbedScores.get(assertion.higher) ?? null;
          const pertLower = perturbedScores.get(assertion.lower) ?? null;
          const pertPasses = pertHigher !== null && pertLower !== null && pertHigher > pertLower;

          if (origPasses !== pertPasses) {
            changed++;
          }
        }

        if (direction > 1) {
          assertionsAffectedUp = changed;
        } else {
          assertionsAffectedDown = changed;
        }
      }
    }

    // Classify sensitivity
    let level: string;
    if (weight >= 0.3) {
      level = "HIGH — score changes here dominate the composite";
    } else if (weight >= 0.1) {
      level = "MODERATE — meaningful impact on composite";
    } else {
      level = "LOW — limited impact on composite";
    }

    const perturbNote = hasDimensions
      ? ` | +20%: ${assertionsAffectedUp} assertions flip, -20%: ${assertionsAffectedDown} assertions flip`
      : "";

    sensitivity.push({
      assertionsAffectedDown,
      assertionsAffectedUp,
      currentWeight: weight,
      dimension: dim,
      sensitivity: `${proportionStr}, ${level}${perturbNote}`,
    });
  }

  return sensitivity;
}

function computeDeltaHistogram(evals: AssertionEval[]): { bucket: string; count: number; mustPass: number; diagnostic: number }[] {
  const buckets: { key: string; count: number; mustPass: number; diagnostic: number }[] = [
    { count: 0, diagnostic: 0, key: "< 0 (fail)", mustPass: 0 },
    { count: 0, diagnostic: 0, key: "0-5", mustPass: 0 },
    { count: 0, diagnostic: 0, key: "5-10", mustPass: 0 },
    { count: 0, diagnostic: 0, key: "10-20", mustPass: 0 },
    { count: 0, diagnostic: 0, key: "20-30", mustPass: 0 },
    { count: 0, diagnostic: 0, key: "30+", mustPass: 0 },
  ];

  for (const ev of evals) {
    if (ev.delta === null) continue;

    let idx: number;
    if (ev.delta < 0) {
      idx = 0;
    } else if (ev.delta <= 5) {
      idx = 1;
    } else if (ev.delta <= 10) {
      idx = 2;
    } else if (ev.delta <= 20) {
      idx = 3;
    } else if (ev.delta <= 30) {
      idx = 4;
    } else {
      idx = 5;
    }

    buckets[idx].count++;
    if (ev.class === "must-pass") {
      buckets[idx].mustPass++;
    } else {
      buckets[idx].diagnostic++;
    }
  }

  return buckets.map((b) => ({ bucket: b.key, count: b.count, diagnostic: b.diagnostic, mustPass: b.mustPass }));
}

function main() {
  const snapshot = findLatestResults();
  if (!snapshot) {
    console.error("No benchmark results found in benchmarks/results/. Run benchmarks first.");
    process.exit(1);
  }

  // 1. Print scores sorted by consumerApi
  console.log("=== Current Scores (sorted by consumerApi) ===\n");
  console.log("Package".padEnd(20) + "Tier".padEnd(10) + "ConsumerAPI");
  console.log("-".repeat(42));

  const sorted = [...snapshot.entries].sort((a, b) => (b.consumerApi ?? 0) - (a.consumerApi ?? 0));
  for (const entry of sorted) {
    console.log(
      entry.name.padEnd(20) +
        entry.tier.padEnd(10) +
        String(entry.consumerApi ?? "n/a"),
    );
  }

  // 2. Evaluate all current assertions against latest results
  const evals = evaluateAssertions(snapshot);

  console.log("\n=== Assertion Results ===\n");

  const passed = evals.filter((e) => e.result === "pass");
  const failed = evals.filter((e) => e.result === "fail");
  const skipped = evals.filter((e) => e.result === "skip");

  for (const ev of evals) {
    const icon = ev.result === "pass" ? "PASS" : ev.result === "fail" ? "FAIL" : "SKIP";
    const detail =
      ev.result === "skip"
        ? "(missing data)"
        : `(${ev.higherScore} vs ${ev.lowerScore}, delta=${ev.delta})`;
    const minDeltaNote = ev.minDelta ? ` [minDelta=${ev.minDelta}]` : "";
    const classLabel = ev.class === "must-pass" ? "" : " (diag)";
    console.log(`${icon}${classLabel}: ${ev.assertion} ${detail}${minDeltaNote}`);
  }

  const evaluated = passed.length + failed.length;
  const rankingLoss = evaluated > 0 ? failed.length / evaluated : 0;

  const mustPassEvals = evals.filter((e) => e.class === "must-pass" && e.result !== "skip");
  const mustPassPassed = mustPassEvals.filter((e) => e.result === "pass").length;
  const mustPassFailed = mustPassEvals.filter((e) => e.result === "fail").length;
  const diagnosticEvals = evals.filter((e) => e.class === "diagnostic" && e.result !== "skip");
  const diagnosticPassed = diagnosticEvals.filter((e) => e.result === "pass").length;
  const diagnosticFailed = diagnosticEvals.filter((e) => e.result === "fail").length;

  console.log(`\n=== Summary ===\n`);
  console.log(`Assertions evaluated: ${evaluated} (${skipped.length} skipped)`);
  console.log(`Must-pass: ${mustPassPassed}/${mustPassPassed + mustPassFailed} passed`);
  console.log(`Diagnostic: ${diagnosticPassed}/${diagnosticPassed + diagnosticFailed} passed`);
  console.log(`Overall passed: ${passed.length}`);
  console.log(`Overall failed: ${failed.length}`);
  console.log(`Ranking loss: ${(rankingLoss * 100).toFixed(1)}%`);

  // 3. Per-dimension concordance analysis
  console.log("\n=== Concordance Analysis ===\n");
  const concordance = computePerDimensionConcordance(snapshot);
  for (const [dim, stats] of Object.entries(concordance)) {
    console.log(
      `${dim.padEnd(24)} concordant=${String(stats.concordant).padEnd(4)} discordant=${String(stats.discordant).padEnd(4)} rate=${(stats.rate * 100).toFixed(1)}%`,
    );
  }

  // 4. Tie analysis
  console.log("\n=== Tie Analysis (delta < 2) ===\n");
  const ties = computeTieAnalysis(snapshot.entries);
  if (ties.length === 0) {
    console.log("No near-ties found.");
  } else {
    for (const tie of ties) {
      console.log(`  ${tie.pkgA} (${tie.scoreA}) ~ ${tie.pkgB} (${tie.scoreB})  delta=${tie.delta}`);
    }
  }

  // 5. Margin analysis
  console.log("\n=== Margin Analysis (must-pass with delta < 5) ===\n");
  const margins = computeMarginAnalysis(evals);
  if (margins.length === 0) {
    console.log("No uncomfortably-narrow must-pass margins found.");
  } else {
    for (const m of margins) {
      console.log(`  ${m.assertion}  delta=${m.delta}`);
    }
  }

  // 6. Weight sensitivity analysis
  console.log("\n=== Weight Sensitivity Analysis ===\n");
  const sensitivity = computeWeightSensitivity(snapshot);
  for (const s of sensitivity) {
    console.log(`  ${s.dimension.padEnd(22)} w=${s.currentWeight}  ${s.sensitivity}`);
  }

  // 7. Delta histogram with class breakdown
  console.log("\n=== Delta Histogram ===\n");
  const histogram = computeDeltaHistogram(evals);
  for (const { bucket, count, diagnostic, mustPass } of histogram) {
    const bar = "#".repeat(count);
    console.log(`  ${bucket.padEnd(14)} ${bar} (${count}: must-pass=${mustPass}, diagnostic=${diagnostic})`);
  }

  // 8. Suggest weight adjustments if ranking loss > 10%
  if (rankingLoss > 0.1) {
    console.log(`\n=== Weight Adjustment Suggestions (ranking loss > 10%) ===\n`);
    const suggestions = suggestWeightAdjustments(evals, snapshot.entries);
    for (const s of suggestions) {
      console.log(`  - ${s}`);
    }

    console.log("\nCurrent consumer-API weights (from DIMENSION_CONFIGS):");
    for (const [dim, weight] of Object.entries(CONSUMER_WEIGHTS)) {
      console.log(`  ${dim.padEnd(22)} ${weight}`);
    }
    console.log("\nConsider adjusting apiSpecificity feature-vector bonuses or dimension weights.");
  } else {
    console.log("\nRanking loss is within acceptable range (<= 10%). No weight adjustments suggested.");
  }

  // 9. Save calibration report
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const now = new Date();
  const folderName = now.toISOString().slice(0, 19).replace(/:/g, "-");
  const reportDir = join(outputDir, folderName);
  mkdirSync(reportDir, { recursive: true });

  const report = {
    timestamp: now.toISOString(),
    sourceResults: snapshot.timestamp,
    ranking: sorted.map((e) => ({ name: e.name, tier: e.tier, consumerApi: e.consumerApi })),
    assertions: evals,
    concordance,
    ties,
    margins,
    weightSensitivity: sensitivity,
    deltaHistogram: histogram,
    summary: {
      evaluated,
      mustPass: { passed: mustPassPassed, failed: mustPassFailed },
      diagnostic: { passed: diagnosticPassed, failed: diagnosticFailed },
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      rankingLoss: Math.round(rankingLoss * 1000) / 1000,
    },
    weightSuggestions: rankingLoss > 0.1 ? suggestWeightAdjustments(evals, snapshot.entries) : [],
  };

  const reportPath = join(reportDir, "calibration.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nCalibration report saved to benchmarks-output/${folderName}/calibration.json`);
}

main();
