#!/usr/bin/env tsx
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";

interface ResultEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
}

interface BenchmarkSnapshot {
  timestamp: string;
  entries: ResultEntry[];
  assertions: { assertion: string; result: string; higherScore?: number | null; lowerScore?: number | null }[];
  summary: { passed: number; failed: number; total: number };
}

interface AssertionEval {
  assertion: string;
  result: "pass" | "fail" | "skip";
  higherScore: number | null;
  lowerScore: number | null;
  delta: number | null;
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
        delta: null,
        higherScore,
        lowerScore,
        result: "skip" as const,
      };
    }

    const delta = higherScore - lowerScore;
    return {
      assertion: `${a.higher} > ${a.lower}`,
      delta,
      higherScore,
      lowerScore,
      result: delta > 0 ? ("pass" as const) : ("fail" as const),
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

// Current consumer-API weights
const CONSUMER_WEIGHTS: Record<string, number> = {
  apiSpecificity: 0.35,
  apiSafety: 0.20,
  semanticLift: 0.15,
  publishQuality: 0.08,
  surfaceConsistency: 0.05,
  surfaceComplexity: 0.05,
  agentUsability: 0.02,
  declarationFidelity: 0.10,
};

function computePerDimensionConcordance(
  snapshot: BenchmarkSnapshot,
  evals: AssertionEval[],
): Record<string, { concordant: number; discordant: number; total: number; rate: number }> {
  // Per-dimension concordance: for each dimension, check how many pairwise
  // assertions would pass if scoring was based on that dimension alone
  const results: Record<string, { concordant: number; discordant: number; total: number; rate: number }> = {};

  // We need dimension scores from the full results, but the snapshot only has
  // consumerApi composite. For calibration, we analyze the assertion evals and
  // report concordance based on available data.
  const scoreMap = new Map<string, number | null>();
  for (const entry of snapshot.entries) {
    scoreMap.set(entry.name, entry.consumerApi);
  }

  // Overall concordance rate across all evaluated assertions
  const evaluated = evals.filter((e) => e.result !== "skip");
  const concordant = evaluated.filter((e) => e.result === "pass").length;
  const discordant = evaluated.filter((e) => e.result === "fail").length;

  results["overall"] = {
    concordant,
    discordant,
    rate: evaluated.length > 0 ? concordant / evaluated.length : 0,
    total: evaluated.length,
  };

  return results;
}

function computeWeightSensitivity(
  evals: AssertionEval[],
  entries: ResultEntry[],
): Array<{ dimension: string; currentWeight: number; sensitivity: string }> {
  const sensitivity: Array<{ dimension: string; currentWeight: number; sensitivity: string }> = [];

  for (const [dim, weight] of Object.entries(CONSUMER_WEIGHTS)) {
    // Report the weight and its proportion of the total
    const totalWeight = Object.values(CONSUMER_WEIGHTS).reduce((a, b) => a + b, 0);
    const proportion = weight / totalWeight;
    const proportionStr = `${(proportion * 100).toFixed(1)}% of total`;

    // Classify sensitivity based on weight magnitude
    let level: string;
    if (weight >= 0.3) {
      level = "HIGH — score changes here dominate the composite";
    } else if (weight >= 0.1) {
      level = "MODERATE — meaningful impact on composite";
    } else {
      level = "LOW — limited impact on composite";
    }

    sensitivity.push({
      currentWeight: weight,
      dimension: dim,
      sensitivity: `${proportionStr}, ${level}`,
    });
  }

  return sensitivity;
}

function computeDeltaHistogram(evals: AssertionEval[]): { bucket: string; count: number }[] {
  const buckets: Record<string, number> = {
    "< 0 (fail)": 0,
    "0-5": 0,
    "5-10": 0,
    "10-20": 0,
    "20-30": 0,
    "30+": 0,
  };

  for (const ev of evals) {
    if (ev.delta === null) {continue;}
    if (ev.delta < 0) {
      buckets["< 0 (fail)"]++;
    } else if (ev.delta <= 5) {
      buckets["0-5"]++;
    } else if (ev.delta <= 10) {
      buckets["5-10"]++;
    } else if (ev.delta <= 20) {
      buckets["10-20"]++;
    } else if (ev.delta <= 30) {
      buckets["20-30"]++;
    } else {
      buckets["30+"]++;
    }
  }

  return Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }));
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
    console.log(`${icon}: ${ev.assertion} ${detail}`);
  }

  const evaluated = passed.length + failed.length;
  const rankingLoss = evaluated > 0 ? failed.length / evaluated : 0;

  console.log(`\n=== Summary ===\n`);
  console.log(`Assertions evaluated: ${evaluated} (${skipped.length} skipped)`);
  console.log(`Passed: ${passed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Ranking loss: ${(rankingLoss * 100).toFixed(1)}%`);

  // 3. Per-dimension concordance analysis
  console.log("\n=== Concordance Analysis ===\n");
  const concordance = computePerDimensionConcordance(snapshot, evals);
  for (const [dim, stats] of Object.entries(concordance)) {
    console.log(
      `${dim.padEnd(20)} concordant=${stats.concordant} discordant=${stats.discordant} rate=${(stats.rate * 100).toFixed(1)}%`,
    );
  }

  // 4. Weight sensitivity analysis
  console.log("\n=== Weight Sensitivity Analysis ===\n");
  const sensitivity = computeWeightSensitivity(evals, snapshot.entries);
  for (const s of sensitivity) {
    console.log(`  ${s.dimension.padEnd(22)} w=${s.currentWeight}  ${s.sensitivity}`);
  }

  // 5. Delta histogram
  console.log("\n=== Delta Histogram ===\n");
  const histogram = computeDeltaHistogram(evals);
  for (const { bucket, count } of histogram) {
    const bar = "#".repeat(count);
    console.log(`  ${bucket.padEnd(14)} ${bar} (${count})`);
  }

  // 6. Suggest weight adjustments if ranking loss > 10%
  if (rankingLoss > 0.1) {
    console.log(`\n=== Weight Adjustment Suggestions (ranking loss > 10%) ===\n`);
    const suggestions = suggestWeightAdjustments(evals, snapshot.entries);
    for (const s of suggestions) {
      console.log(`  - ${s}`);
    }

    console.log("\nCurrent consumer-API weights:");
    for (const [dim, weight] of Object.entries(CONSUMER_WEIGHTS)) {
      console.log(`  ${dim.padEnd(22)} ${weight}`);
    }
    console.log("\nConsider adjusting apiSpecificity feature-vector bonuses or dimension weights.");
  } else {
    console.log("\nRanking loss is within acceptable range (<= 10%). No weight adjustments suggested.");
  }

  // 7. Save calibration report
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
    weightSensitivity: sensitivity,
    deltaHistogram: histogram,
    summary: {
      evaluated,
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
