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
  metrics?: Record<string, unknown>;
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
  falsePositiveRisk?: number;
  matchedRules?: string[];
}

interface ResultEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety?: number | null;
  dimensions?: DimensionSnapshot[];
  graphStats?: GraphStatsSnapshot | null;
  domainInference?: DomainInferenceSnapshot | null;
  topIssues?: unknown[];
  explainability?: unknown;
  dedupStats?: { groups: number; filesRemoved: number } | null;
  caveats?: string[];
}

interface BenchmarkSnapshot {
  timestamp: string;
  entries: ResultEntry[];
  assertions: { assertion: string; class: string; result: string; higherScore?: number | null; lowerScore?: number | null; delta?: number | null; minDelta?: number }[];
  summary: {
    mustPass: { passed: number; failed: number; total: number };
    hardDiagnostic?: { passed: number; failed: number; total: number };
    diagnostic: { passed: number; failed: number; total: number };
  };
}

interface AssertionEval {
  assertion: string;
  class: string;
  result: "pass" | "fail" | "skip";
  higherScore: number | null;
  lowerScore: number | null;
  delta: number | null;
  minDelta?: number;
  composite?: string;
}

function findLatestResults(): BenchmarkSnapshot | null {
  // Try split-specific train subdirectory first, then legacy flat directory
  const trainDir = join(import.meta.dirname, "results", "train");
  const legacyDir = join(import.meta.dirname, "results");

  for (const dir of [trainDir, legacyDir]) {
    if (!existsSync(dir)) {
      continue;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && /^\d{4}-\d{2}-\d{2}T/.test(f))
      .sort();
    if (files.length === 0) {
      continue;
    }
    const latestFile = files[files.length - 1];
    console.log(`Reading latest results: ${dir}/${latestFile}\n`);
    return JSON.parse(readFileSync(join(dir, latestFile), "utf8"));
  }
  return null;
}

function getScoreForComposite(entry: ResultEntry, composite: string): number | null {
  if (composite === "consumerApi") return entry.consumerApi;
  if (composite === "agentReadiness") return entry.agentReadiness;
  if (composite === "typeSafety") return entry.typeSafety ?? null;
  return null;
}

function evaluateAssertions(snapshot: BenchmarkSnapshot): AssertionEval[] {
  const entryMap = new Map<string, ResultEntry>();
  for (const entry of snapshot.entries) {
    entryMap.set(entry.name, entry);
  }

  return PAIRWISE_ASSERTIONS.map((a) => {
    const higherEntry = entryMap.get(a.higher);
    const lowerEntry = entryMap.get(a.lower);

    if (!higherEntry || !lowerEntry) {
      return {
        assertion: `${a.higher} > ${a.lower}`,
        class: a.class,
        composite: a.composite,
        delta: null,
        higherScore: null,
        lowerScore: null,
        minDelta: a.minDelta,
        result: "skip" as const,
      };
    }

    const higherScore = getScoreForComposite(higherEntry, a.composite);
    const lowerScore = getScoreForComposite(lowerEntry, a.composite);

    if (higherScore === null || lowerScore === null) {
      return {
        assertion: `${a.higher} > ${a.lower}`,
        class: a.class,
        composite: a.composite,
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
      composite: a.composite,
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
        `${pkg} (${tier}, score=${score}) is scored TOO HIGH — appears as the wrongly-higher side in ${counts.tooHigh} failed assertion(s).`,
      );
    }
    if (counts.tooLow > 1) {
      suggestions.push(
        `${pkg} (${tier}, score=${score}) is scored TOO LOW — appears as the wrongly-lower side in ${counts.tooLow} failed assertion(s).`,
      );
    }
  }

  if (suggestions.length === 0) {
    suggestions.push("No single package dominates the failures.");
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

  const hasDimensions = snapshot.entries.some((e) => e.dimensions && e.dimensions.length > 0);

  if (hasDimensions) {
    const dimensionKeys = new Set<string>();
    for (const entry of snapshot.entries) {
      if (entry.dimensions) {
        for (const d of entry.dimensions) {
          dimensionKeys.add(d.key);
        }
      }
    }

    for (const dimKey of dimensionKeys) {
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

  // Overall concordance
  let overallConcordant = 0;
  let overallDiscordant = 0;
  let overallTotal = 0;

  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.composite !== "consumerApi") continue;
    const higherEntry = entryMap.get(assertion.higher);
    const lowerEntry = entryMap.get(assertion.lower);
    if (!higherEntry || !lowerEntry) continue;
    const higherScore = higherEntry.consumerApi;
    const lowerScore = lowerEntry.consumerApi;
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

function computeFalseEquivalence(entries: ResultEntry[]): Array<{ pkgA: string; pkgB: string; tierA: string; tierB: string; scoreA: number; scoreB: number }> {
  const falseEquivs: Array<{ pkgA: string; pkgB: string; tierA: string; tierB: string; scoreA: number; scoreB: number }> = [];
  const tierOrder: Record<string, number> = { elite: 4, solid: 3, loose: 1, stretch: 2, "stretch-2": 2 };

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.consumerApi === null || b.consumerApi === null) continue;
      const delta = Math.abs(a.consumerApi - b.consumerApi);
      if (delta < 3) {
        const tierDiff = Math.abs((tierOrder[a.tier] ?? 0) - (tierOrder[b.tier] ?? 0));
        if (tierDiff >= 3) {
          falseEquivs.push({
            pkgA: a.name,
            pkgB: b.name,
            scoreA: a.consumerApi,
            scoreB: b.consumerApi,
            tierA: a.tier,
            tierB: b.tier,
          });
        }
      }
    }
  }

  return falseEquivs;
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
      for (const direction of [1.2, 0.8] as const) {
        const perturbedWeights = { ...CONSUMER_WEIGHTS };
        perturbedWeights[dim] = weight * direction;

        const perturbedScores = new Map<string, number | null>();
        for (const entry of snapshot.entries) {
          perturbedScores.set(entry.name, recomputeConsumerApi(entry, perturbedWeights));
        }

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

function computeDeltaHistogram(evals: AssertionEval[]): { bucket: string; count: number; mustPass: number; diagnostic: number; hardDiagnostic: number }[] {
  const buckets: { key: string; count: number; mustPass: number; diagnostic: number; hardDiagnostic: number }[] = [
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "< 0 (fail)", mustPass: 0 },
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "0-5", mustPass: 0 },
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "5-10", mustPass: 0 },
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "10-20", mustPass: 0 },
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "20-30", mustPass: 0 },
    { count: 0, diagnostic: 0, hardDiagnostic: 0, key: "30+", mustPass: 0 },
  ];

  for (const ev of evals) {
    if (ev.delta === null) continue;

    let idx: number;
    if (ev.delta < 0) {idx = 0;}
    else if (ev.delta <= 5) {idx = 1;}
    else if (ev.delta <= 10) {idx = 2;}
    else if (ev.delta <= 20) {idx = 3;}
    else if (ev.delta <= 30) {idx = 4;}
    else {idx = 5;}

    buckets[idx].count++;
    if (ev.class === "must-pass") {buckets[idx].mustPass++;}
    else if (ev.class === "hard-diagnostic") {buckets[idx].hardDiagnostic++;}
    else {buckets[idx].diagnostic++;}
  }

  return buckets.map((b) => ({ bucket: b.key, count: b.count, diagnostic: b.diagnostic, hardDiagnostic: b.hardDiagnostic, mustPass: b.mustPass }));
}

function computeTopMisranked(evals: AssertionEval[], entries: ResultEntry[]): Array<{ pkg: string; tier: string; score: number | null; failsAsHigher: number; failsAsLower: number }> {
  const failMap = new Map<string, { failsAsHigher: number; failsAsLower: number }>();

  for (const ev of evals) {
    if (ev.result !== "fail") continue;
    const [higher, lower] = ev.assertion.split(" > ");

    const h = failMap.get(higher) ?? { failsAsHigher: 0, failsAsLower: 0 };
    h.failsAsLower++;
    failMap.set(higher, h);

    const l = failMap.get(lower) ?? { failsAsHigher: 0, failsAsLower: 0 };
    l.failsAsHigher++;
    failMap.set(lower, l);
  }

  return [...failMap.entries()]
    .map(([pkg, data]) => {
      const entry = entries.find((e) => e.name === pkg);
      return { pkg, tier: entry?.tier ?? "unknown", score: entry?.consumerApi ?? null, ...data };
    })
    .sort((a, b) => (b.failsAsHigher + b.failsAsLower) - (a.failsAsHigher + a.failsAsLower))
    .slice(0, 5);
}

function main() {
  const snapshot = findLatestResults();
  if (!snapshot) {
    console.error("No benchmark results found in benchmarks/results/. Run benchmarks first.");
    process.exit(1);
  }

  // 1. Print scores sorted by consumerApi
  console.log("=== Current Scores (sorted by consumerApi) ===\n");
  console.log("Package".padEnd(25) + "Tier".padEnd(12) + "ConsumerAPI".padEnd(14) + "AgentReady".padEnd(14) + "TypeSafety");
  console.log("-".repeat(79));

  const sorted = [...snapshot.entries].sort((a, b) => (b.consumerApi ?? 0) - (a.consumerApi ?? 0));
  for (const entry of sorted) {
    console.log(
      entry.name.padEnd(25) +
      entry.tier.padEnd(12) +
      String(entry.consumerApi ?? "n/a").padEnd(14) +
      String(entry.agentReadiness ?? "n/a").padEnd(14) +
      String(entry.typeSafety ?? "n/a"),
    );
  }

  // 2. Evaluate assertions
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
    const classLabel = ev.class === "must-pass" ? "" : ` (${ev.class})`;
    const compositeLabel = ev.composite && ev.composite !== "consumerApi" ? ` [${ev.composite}]` : "";
    console.log(`${icon}${classLabel}: ${ev.assertion} ${detail}${minDeltaNote}${compositeLabel}`);
  }

  const evaluated = passed.length + failed.length;
  const rankingLoss = evaluated > 0 ? failed.length / evaluated : 0;

  const mustPassEvals = evals.filter((e) => e.class === "must-pass" && e.result !== "skip");
  const mustPassPassed = mustPassEvals.filter((e) => e.result === "pass").length;
  const mustPassFailed = mustPassEvals.filter((e) => e.result === "fail").length;
  const hardDiagEvals = evals.filter((e) => e.class === "hard-diagnostic" && e.result !== "skip");
  const hardDiagPassed = hardDiagEvals.filter((e) => e.result === "pass").length;
  const hardDiagFailed = hardDiagEvals.filter((e) => e.result === "fail").length;
  const diagnosticEvals = evals.filter((e) => e.class === "diagnostic" && e.result !== "skip");
  const diagnosticPassed = diagnosticEvals.filter((e) => e.result === "pass").length;
  const diagnosticFailed = diagnosticEvals.filter((e) => e.result === "fail").length;

  console.log(`\n=== Summary ===\n`);
  console.log(`Assertions evaluated: ${evaluated} (${skipped.length} skipped)`);
  console.log(`Must-pass: ${mustPassPassed}/${mustPassPassed + mustPassFailed} passed`);
  console.log(`Hard-diagnostic: ${hardDiagPassed}/${hardDiagPassed + hardDiagFailed} passed`);
  console.log(`Diagnostic: ${diagnosticPassed}/${diagnosticPassed + diagnosticFailed} passed`);
  console.log(`Overall passed: ${passed.length}`);
  console.log(`Overall failed: ${failed.length}`);
  console.log(`Ranking loss: ${(rankingLoss * 100).toFixed(1)}%`);

  // 3. Per-dimension concordance
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

  // 5. False equivalence analysis
  console.log("\n=== False Equivalence (delta < 3, tier gap >= 2) ===\n");
  const falseEquivs = computeFalseEquivalence(snapshot.entries);
  if (falseEquivs.length === 0) {
    console.log("No false equivalences found.");
  } else {
    for (const fe of falseEquivs) {
      console.log(`  ${fe.pkgA}(${fe.tierA},${fe.scoreA}) ~ ${fe.pkgB}(${fe.tierB},${fe.scoreB})`);
    }
  }

  // 6. Margin analysis
  console.log("\n=== Margin Analysis (must-pass with delta < 5) ===\n");
  const margins = computeMarginAnalysis(evals);
  if (margins.length === 0) {
    console.log("No uncomfortably-narrow must-pass margins found.");
  } else {
    for (const m of margins) {
      console.log(`  ${m.assertion}  delta=${m.delta}`);
    }
  }

  // 7. Weight sensitivity
  console.log("\n=== Weight Sensitivity Analysis ===\n");
  const sensitivity = computeWeightSensitivity(snapshot);
  for (const s of sensitivity) {
    console.log(`  ${s.dimension.padEnd(22)} w=${s.currentWeight}  ${s.sensitivity}`);
  }

  // 8. Delta histogram
  console.log("\n=== Delta Histogram ===\n");
  const histogram = computeDeltaHistogram(evals);
  for (const { bucket, count, diagnostic, hardDiagnostic, mustPass } of histogram) {
    const bar = "#".repeat(count);
    console.log(`  ${bucket.padEnd(14)} ${bar} (${count}: must-pass=${mustPass}, hard-diag=${hardDiagnostic}, diagnostic=${diagnostic})`);
  }

  // 9. Top misranked packages
  console.log("\n=== Top Misranked Packages ===\n");
  const topMisranked = computeTopMisranked(evals, snapshot.entries);
  if (topMisranked.length === 0) {
    console.log("No misranked packages.");
  } else {
    for (const m of topMisranked) {
      console.log(`  ${m.pkg.padEnd(25)} tier=${m.tier.padEnd(10)} score=${String(m.score ?? "n/a").padEnd(6)} failsAsHigher=${m.failsAsHigher} failsAsLower=${m.failsAsLower}`);
    }
  }

  // 10. Suggest adjustments
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
  } else {
    console.log("\nRanking loss is within acceptable range (<= 10%).");
  }

  // 11. Calibration targets check
  console.log("\n=== Calibration Targets ===\n");
  // Check for undersampled must-pass anchors
  const mustPassPkgs = new Set<string>();
  for (const a of PAIRWISE_ASSERTIONS) {
    if (a.class === "must-pass") {
      mustPassPkgs.add(a.higher);
      mustPassPkgs.add(a.lower);
    }
  }
  const undersampledAnchorCount = snapshot.entries.filter(
    (e: ResultEntry) => mustPassPkgs.has(e.name) && (e as any).coverageDiagnostics?.undersampled,
  ).length;

  const targets = [
    { name: "must-pass = 100%", met: mustPassFailed === 0, actual: `${mustPassPassed}/${mustPassPassed + mustPassFailed}` },
    { name: "hard-diagnostic >= 95%", met: hardDiagEvals.length === 0 || hardDiagPassed / hardDiagEvals.length >= 0.95, actual: hardDiagEvals.length > 0 ? `${(hardDiagPassed / hardDiagEvals.length * 100).toFixed(1)}%` : "n/a" },
    { name: "diagnostic >= 90%", met: diagnosticEvals.length === 0 || diagnosticPassed / diagnosticEvals.length >= 0.90, actual: diagnosticEvals.length > 0 ? `${(diagnosticPassed / diagnosticEvals.length * 100).toFixed(1)}%` : "n/a" },
    { name: "global ranking loss < 6%", met: rankingLoss < 0.06, actual: `${(rankingLoss * 100).toFixed(1)}%` },
    { name: "false equivalence = 0", met: falseEquivs.length === 0, actual: `${falseEquivs.length}` },
    { name: "fallbackGlob = 0", met: !snapshot.entries.some((e: ResultEntry) => e.graphStats?.usedFallbackGlob), actual: `${snapshot.entries.filter((e: ResultEntry) => e.graphStats?.usedFallbackGlob).length}` },
    { name: "undersampled-anchor = 0", met: undersampledAnchorCount === 0, actual: `${undersampledAnchorCount}` },
  ];

  for (const t of targets) {
    const icon = t.met ? "OK" : "MISS";
    console.log(`  [${icon}] ${t.name.padEnd(30)} actual: ${t.actual}`);
  }

  // 12. Constrained weight optimization
  console.log("\n=== Constrained Weight Search ===\n");
  const hasDimensions = snapshot.entries.some((e) => e.dimensions && e.dimensions.length > 0);
  let optimalWeights: Record<string, number> | null = null;
  let optimalConcordance = 0;

  if (hasDimensions) {
    const dimKeys = Object.keys(CONSUMER_WEIGHTS);
    const steps = 5; // 5% increments
    let bestWeights = { ...CONSUMER_WEIGHTS };
    let bestConcordance = 0;
    let candidatesEvaluated = 0;

    // Build entry map for weight optimization
    const optimEntryMap = new Map<string, ResultEntry>();
    for (const entry of snapshot.entries) {
      optimEntryMap.set(entry.name, entry);
    }

    // Compute current concordance baseline
    const currentConcordance = concordance["composite"]?.rate ?? 0;
    bestConcordance = currentConcordance;

    // Generate candidate weight vectors via pairwise perturbation
    // Instead of full grid search, perturb one dimension at a time relative to current
    for (const dimA of dimKeys) {
      for (const dimB of dimKeys) {
        if (dimA === dimB) continue;
        for (let delta = -3; delta <= 3; delta++) {
          if (delta === 0) continue;
          const candidate = { ...CONSUMER_WEIGHTS };
          const shift = delta * 0.01 * steps;
          candidate[dimA] = Math.max(0.01, candidate[dimA]! + shift);
          candidate[dimB] = Math.max(0.01, candidate[dimB]! - shift);

          // Normalize
          const total = Object.values(candidate).reduce((a, b) => a + b, 0);
          for (const k of dimKeys) {
            candidate[k] = Math.round((candidate[k]! / total) * 100) / 100;
          }

          // Evaluate concordance with these weights
          let concordant = 0;
          let evalTotal = 0;
          for (const assertion of PAIRWISE_ASSERTIONS) {
            if (assertion.composite !== "consumerApi") continue;
            const higherEntry = optimEntryMap.get(assertion.higher);
            const lowerEntry = optimEntryMap.get(assertion.lower);
            if (!higherEntry || !lowerEntry) continue;

            const higherScore = recomputeConsumerApi(higherEntry, candidate);
            const lowerScore = recomputeConsumerApi(lowerEntry, candidate);
            if (higherScore === null || lowerScore === null) continue;

            evalTotal++;
            if (higherScore > lowerScore) concordant++;
          }

          candidatesEvaluated++;
          const rate = evalTotal > 0 ? concordant / evalTotal : 0;
          if (rate > bestConcordance) {
            bestConcordance = rate;
            bestWeights = { ...candidate };
          }
        }
      }
    }

    if (bestConcordance > currentConcordance) {
      optimalWeights = bestWeights;
      optimalConcordance = bestConcordance;
      console.log(`  Found improved weights (${candidatesEvaluated} candidates evaluated):`);
      console.log(`  Current concordance: ${(currentConcordance * 100).toFixed(1)}%`);
      console.log(`  Optimal concordance: ${(bestConcordance * 100).toFixed(1)}%`);
      for (const [dim, weight] of Object.entries(bestWeights)) {
        const diff = weight - (CONSUMER_WEIGHTS[dim] ?? 0);
        const diffStr = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
        console.log(`    ${dim.padEnd(22)} ${weight.toFixed(2)} (${diffStr})`);
      }
    } else {
      console.log(`  Current weights are already optimal (${candidatesEvaluated} candidates evaluated)`);
      console.log(`  Concordance: ${(currentConcordance * 100).toFixed(1)}%`);
    }
  } else {
    console.log("  No dimension data available for weight optimization");
  }

  // 13. Domain accuracy from snapshot
  console.log("\n=== Domain Accuracy ===\n");
  const domainAccuracy: { correct: number; wrong: number; abstained: number; total: number } = { abstained: 0, correct: 0, total: 0, wrong: 0 };
  const { EXPECTED_DOMAINS: expectedDomains } = await import("./assertions.js");
  for (const entry of snapshot.entries) {
    const expected = expectedDomains[entry.name as keyof typeof expectedDomains];
    if (!expected) continue;
    domainAccuracy.total++;
    const actual = entry.domainInference?.domain ?? "general";
    if (actual === expected) {
      domainAccuracy.correct++;
    } else if (actual === "general" && expected !== "general") {
      domainAccuracy.abstained++;
    } else {
      domainAccuracy.wrong++;
    }
  }
  if (domainAccuracy.total > 0) {
    const accuracy = domainAccuracy.correct / domainAccuracy.total;
    const wrongRate = domainAccuracy.wrong / domainAccuracy.total;
    console.log(`  Correct: ${domainAccuracy.correct}/${domainAccuracy.total} (${(accuracy * 100).toFixed(1)}%)`);
    console.log(`  Abstained: ${domainAccuracy.abstained}/${domainAccuracy.total}`);
    console.log(`  Wrong-specific: ${domainAccuracy.wrong}/${domainAccuracy.total} (${(wrongRate * 100).toFixed(1)}%)`);
  }

  // Save calibration report
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
    ranking: sorted.map((e) => ({
      name: e.name,
      tier: e.tier,
      consumerApi: e.consumerApi,
      agentReadiness: e.agentReadiness,
      typeSafety: e.typeSafety ?? null,
    })),
    assertions: evals,
    concordance,
    ties,
    falseEquivalences: falseEquivs,
    margins,
    weightSensitivity: sensitivity,
    deltaHistogram: histogram,
    topMisranked,
    summary: {
      evaluated,
      mustPass: { passed: mustPassPassed, failed: mustPassFailed },
      hardDiagnostic: { passed: hardDiagPassed, failed: hardDiagFailed },
      diagnostic: { passed: diagnosticPassed, failed: diagnosticFailed },
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      rankingLoss: Math.round(rankingLoss * 1000) / 1000,
    },
    weightSuggestions: rankingLoss > 0.1 ? suggestWeightAdjustments(evals, snapshot.entries) : [],
    calibrationTargets: targets.map((t) => ({ name: t.name, met: t.met, actual: t.actual })),
    falseEquivalenceCount: falseEquivs.length,
    optimalWeights: optimalWeights ?? null,
    optimalConcordance: optimalWeights ? Math.round(optimalConcordance * 1000) / 1000 : null,
    domainAccuracy,
  };

  const reportPath = join(reportDir, "calibration.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nCalibration report saved to benchmarks-output/${folderName}/calibration.json`);
}

main();
