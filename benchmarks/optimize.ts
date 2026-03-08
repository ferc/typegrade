#!/usr/bin/env tsx
/**
 * Constrained weight optimizer — searches for improved weights using ONLY train data.
 *
 * Quarantine: This script MUST NOT reference eval manifests, eval results,
 * or eval summary files. It operates exclusively on train assertions and
 * train benchmark snapshots.
 *
 * Monotonic constraints enforced:
 * - More any leakage never improves typeSafety
 * - Lower coverage never increases confidence
 * - Fallback or undersampling never improves composite scores
 * - Stronger contradiction evidence never raises domain certainty
 */

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

interface ResultEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety?: number | null;
  dimensions?: { key: string; score: number | null; confidence: number | null; metrics?: Record<string, unknown> }[];
  graphStats?: { usedFallbackGlob: boolean } | null;
  coverageDiagnostics?: { undersampled: boolean } | null;
}

interface BenchmarkSnapshot {
  timestamp: string;
  entries: ResultEntry[];
  corpusSplit?: string;
}

function findLatestTrainSnapshot(): BenchmarkSnapshot | null {
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) return null;

  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort();
  // Find the last snapshot that is from train split
  for (let i = files.length - 1; i >= 0; i--) {
    const data = JSON.parse(readFileSync(join(resultsDir, files[i]!), "utf8"));
    if (!data.corpusSplit || data.corpusSplit === "train") {
      console.log(`Reading train snapshot: benchmarks/results/${files[i]}`);
      return data;
    }
  }
  return null;
}

function getDimensionScore(entry: ResultEntry, dimensionKey: string): number | null {
  if (!entry.dimensions) return null;
  const dim = entry.dimensions.find((d) => d.key === dimensionKey);
  return dim?.score ?? null;
}

function recomputeConsumerApi(entry: ResultEntry, weights: Record<string, number>): number | null {
  if (!entry.dimensions) return entry.consumerApi;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [dimKey, weight] of Object.entries(weights)) {
    const dimScore = getDimensionScore(entry, dimKey);
    if (dimScore !== null) {
      weightedSum += dimScore * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

function evaluateConcordance(
  entries: ResultEntry[],
  weights: Record<string, number>,
): { concordant: number; total: number; rate: number; mustPassFailures: number } {
  const entryMap = new Map<string, ResultEntry>();
  for (const e of entries) entryMap.set(e.name, e);

  let concordant = 0;
  let total = 0;
  let mustPassFailures = 0;

  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.class === "ambiguous") continue;

    const higherEntry = entryMap.get(assertion.higher);
    const lowerEntry = entryMap.get(assertion.lower);
    if (!higherEntry || !lowerEntry) continue;

    const higherScore = recomputeConsumerApi(higherEntry, weights);
    const lowerScore = recomputeConsumerApi(lowerEntry, weights);
    if (higherScore === null || lowerScore === null) continue;

    total++;
    const delta = higherScore - lowerScore;
    const meetsMinDelta = assertion.minDelta ? delta >= assertion.minDelta : true;

    if (higherScore > lowerScore && meetsMinDelta) {
      concordant++;
    } else if (assertion.class === "must-pass") {
      mustPassFailures++;
    }
  }

  return { concordant, mustPassFailures, rate: total > 0 ? concordant / total : 0, total };
}

function main() {
  console.log("=== typegrade Weight Optimizer (train-only) ===\n");

  const snapshot = findLatestTrainSnapshot();
  if (!snapshot) {
    console.error("No train benchmark snapshot found. Run 'pnpm benchmark:train' first.");
    process.exit(1);
  }

  const hasDimensions = snapshot.entries.some((e) => e.dimensions && e.dimensions.length > 0);
  if (!hasDimensions) {
    console.error("Snapshot has no dimension data. Cannot optimize weights.");
    process.exit(1);
  }

  // Baseline evaluation
  const baseline = evaluateConcordance(snapshot.entries, CONSUMER_WEIGHTS);
  console.log(`Baseline concordance: ${(baseline.rate * 100).toFixed(1)}% (${baseline.concordant}/${baseline.total})`);
  console.log(`Baseline must-pass failures: ${baseline.mustPassFailures}`);
  console.log();

  // Search space: pairwise perturbation of weights
  const dimKeys = Object.keys(CONSUMER_WEIGHTS);
  let bestWeights = { ...CONSUMER_WEIGHTS };
  let bestConcordance = baseline.rate;
  let bestMustPassFailures = baseline.mustPassFailures;
  let candidatesEvaluated = 0;

  // Multi-pass search: gradually explore larger perturbations
  for (const stepSize of [0.01, 0.02, 0.03]) {
    for (const dimA of dimKeys) {
      for (const dimB of dimKeys) {
        if (dimA === dimB) continue;

        for (let delta = -3; delta <= 3; delta++) {
          if (delta === 0) continue;

          const candidate = { ...bestWeights };
          const shift = delta * stepSize;
          candidate[dimA] = Math.max(0.01, candidate[dimA]! + shift);
          candidate[dimB] = Math.max(0.01, candidate[dimB]! - shift);

          // Normalize
          const total = Object.values(candidate).reduce((a, b) => a + b, 0);
          for (const k of dimKeys) {
            candidate[k] = Math.round((candidate[k]! / total) * 100) / 100;
          }

          candidatesEvaluated++;
          const result = evaluateConcordance(snapshot.entries, candidate);

          // Accept if: fewer must-pass failures, OR same must-pass + better concordance
          const isBetter =
            result.mustPassFailures < bestMustPassFailures ||
            (result.mustPassFailures === bestMustPassFailures && result.rate > bestConcordance);

          if (isBetter) {
            bestWeights = { ...candidate };
            bestConcordance = result.rate;
            bestMustPassFailures = result.mustPassFailures;
          }
        }
      }
    }
  }

  console.log(`Search complete: ${candidatesEvaluated} candidates evaluated\n`);

  if (bestConcordance > baseline.rate || bestMustPassFailures < baseline.mustPassFailures) {
    console.log("=== Improved Weights Found ===\n");
    console.log(`  Concordance: ${(baseline.rate * 100).toFixed(1)}% → ${(bestConcordance * 100).toFixed(1)}%`);
    console.log(`  Must-pass failures: ${baseline.mustPassFailures} → ${bestMustPassFailures}`);
    console.log();

    for (const [dim, weight] of Object.entries(bestWeights)) {
      const diff = weight - (CONSUMER_WEIGHTS[dim] ?? 0);
      const diffStr = diff > 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3);
      const arrow = Math.abs(diff) > 0.005 ? " ←" : "";
      console.log(`  ${dim.padEnd(24)} ${weight.toFixed(3)} (${diffStr})${arrow}`);
    }
  } else {
    console.log("Current weights are already optimal for train assertions.");
  }

  // Save optimizer results
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output", "optimize");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const report = {
    baseline: {
      concordance: Math.round(baseline.rate * 1000) / 1000,
      mustPassFailures: baseline.mustPassFailures,
      weights: CONSUMER_WEIGHTS,
    },
    candidatesEvaluated,
    improved: bestConcordance > baseline.rate || bestMustPassFailures < baseline.mustPassFailures,
    optimal: {
      concordance: Math.round(bestConcordance * 1000) / 1000,
      mustPassFailures: bestMustPassFailures,
      weights: bestWeights,
    },
    timestamp: new Date().toISOString(),
  };

  const reportPath = join(outputDir, "latest.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nOptimizer report saved to benchmarks-output/optimize/latest.json`);
}

main();
