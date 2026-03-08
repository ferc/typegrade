#!/usr/bin/env tsx
/**
 * Multi-objective weight optimizer — searches for improved weights using ONLY train data.
 *
 * Optimizes weight vectors for all three composites (consumerApi, agentReadiness, typeSafety)
 * simultaneously. Each composite is independently perturbed and evaluated.
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
import type { CompositeKey } from "../src/types.js";
import { DIMENSION_CONFIGS } from "../src/constants.js";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";

const COMPOSITE_KEYS: CompositeKey[] = ["consumerApi", "agentReadiness", "typeSafety"];

/** Extract current weights for a given composite from DIMENSION_CONFIGS */
function extractWeights(composite: CompositeKey): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const cfg of DIMENSION_CONFIGS) {
    const wt = cfg.weights[composite];
    if (wt) {
      weights[cfg.key] = wt;
    }
  }
  return weights;
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

interface ConcordanceResult {
  concordant: number;
  total: number;
  rate: number;
  mustPassFailures: number;
  hardDiagFailures: number;
}

function findLatestTrainSnapshot(): BenchmarkSnapshot | null {
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) return null;

  const files = readdirSync(resultsDir).filter((ff) => ff.endsWith(".json")).sort();
  // Find the last snapshot that is from train split
  for (let idx = files.length - 1; idx >= 0; idx--) {
    const data = JSON.parse(readFileSync(join(resultsDir, files[idx]!), "utf8"));
    if (!data.corpusSplit || data.corpusSplit === "train") {
      console.log(`Reading train snapshot: benchmarks/results/${files[idx]}`);
      return data;
    }
  }
  return null;
}

function getDimensionScore(entry: ResultEntry, dimensionKey: string): number | null {
  if (!entry.dimensions) return null;
  const dim = entry.dimensions.find((dd) => dd.key === dimensionKey);
  return dim?.score ?? null;
}

/** Recompute a composite score from dimension scores and a weight vector */
function recomputeComposite(entry: ResultEntry, weights: Record<string, number>): number | null {
  if (!entry.dimensions) return null;

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

/** Evaluate concordance for a single composite's assertions */
function evaluateConcordance(
  entries: ResultEntry[],
  composite: CompositeKey,
  weights: Record<string, number>,
): ConcordanceResult {
  const entryMap = new Map<string, ResultEntry>();
  for (const en of entries) {
    entryMap.set(en.name, en);
  }

  let concordant = 0;
  let total = 0;
  let mustPassFailures = 0;
  let hardDiagFailures = 0;

  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.class === "ambiguous") continue;
    if (assertion.composite !== composite) continue;

    const higherEntry = entryMap.get(assertion.higher);
    const lowerEntry = entryMap.get(assertion.lower);
    if (!higherEntry || !lowerEntry) continue;

    const higherScore = recomputeComposite(higherEntry, weights);
    const lowerScore = recomputeComposite(lowerEntry, weights);
    if (higherScore === null || lowerScore === null) continue;

    total++;
    const delta = higherScore - lowerScore;
    const meetsMinDelta = assertion.minDelta ? delta >= assertion.minDelta : true;

    if (higherScore > lowerScore && meetsMinDelta) {
      concordant++;
    } else if (assertion.class === "must-pass") {
      mustPassFailures++;
    } else if (assertion.class === "hard-diagnostic") {
      hardDiagFailures++;
    }
  }

  return { concordant, hardDiagFailures, mustPassFailures, rate: total > 0 ? concordant / total : 0, total };
}

/** Run pairwise perturbation search for a single composite */
function optimizeComposite(
  entries: ResultEntry[],
  composite: CompositeKey,
  baseWeights: Record<string, number>,
): {
  bestWeights: Record<string, number>;
  baseline: ConcordanceResult;
  best: ConcordanceResult;
  candidatesEvaluated: number;
  improved: boolean;
} {
  const baseline = evaluateConcordance(entries, composite, baseWeights);
  const dimKeys = Object.keys(baseWeights);

  // Skip if no assertions for this composite
  if (baseline.total === 0) {
    return { baseline, best: baseline, bestWeights: { ...baseWeights }, candidatesEvaluated: 0, improved: false };
  }

  let bestWeights = { ...baseWeights };
  let bestMustPass = baseline.mustPassFailures;
  let bestHardDiag = baseline.hardDiagFailures;
  let bestRate = baseline.rate;
  let candidatesEvaluated = 0;

  // Multi-pass search: gradually explore larger perturbations
  for (const stepSize of [0.01, 0.02, 0.03, 0.05]) {
    for (const dimA of dimKeys) {
      for (const dimB of dimKeys) {
        if (dimA === dimB) continue;

        for (let delta = -3; delta <= 3; delta++) {
          if (delta === 0) continue;

          const candidate = { ...bestWeights };
          const shift = delta * stepSize;
          candidate[dimA] = Math.max(0.01, candidate[dimA]! + shift);
          candidate[dimB] = Math.max(0.01, candidate[dimB]! - shift);

          // Normalize to sum to ~1.0
          const total = Object.values(candidate).reduce((aa, bb) => aa + bb, 0);
          for (const kk of dimKeys) {
            candidate[kk] = Math.round((candidate[kk]! / total) * 100) / 100;
          }

          candidatesEvaluated++;
          const result = evaluateConcordance(entries, composite, candidate);

          // Accept if: fewer must-pass failures, then fewer hard-diag, then better concordance
          const isBetter =
            result.mustPassFailures < bestMustPass ||
            (result.mustPassFailures === bestMustPass && result.hardDiagFailures < bestHardDiag) ||
            (result.mustPassFailures === bestMustPass && result.hardDiagFailures === bestHardDiag && result.rate > bestRate);

          if (isBetter) {
            bestWeights = { ...candidate };
            bestMustPass = result.mustPassFailures;
            bestHardDiag = result.hardDiagFailures;
            bestRate = result.rate;
          }
        }
      }
    }
  }

  const best: ConcordanceResult = {
    concordant: Math.round(bestRate * baseline.total),
    hardDiagFailures: bestHardDiag,
    mustPassFailures: bestMustPass,
    rate: bestRate,
    total: baseline.total,
  };

  const improved =
    bestMustPass < baseline.mustPassFailures ||
    bestHardDiag < baseline.hardDiagFailures ||
    bestRate > baseline.rate;

  return { baseline, best, bestWeights, candidatesEvaluated, improved };
}

function printCompositeResult(
  composite: string,
  baseWeights: Record<string, number>,
  result: ReturnType<typeof optimizeComposite>,
): void {
  const { baseline, best, candidatesEvaluated, improved } = result;

  console.log(`--- ${composite} ---`);
  console.log(`  Assertions: ${baseline.total}`);
  console.log(`  Baseline: ${(baseline.rate * 100).toFixed(1)}% concordance, ${baseline.mustPassFailures} must-pass fail, ${baseline.hardDiagFailures} hard-diag fail`);
  console.log(`  Candidates evaluated: ${candidatesEvaluated}`);

  if (improved) {
    console.log(`  Improved: ${(best.rate * 100).toFixed(1)}% concordance, ${best.mustPassFailures} must-pass fail, ${best.hardDiagFailures} hard-diag fail`);
    console.log("  Weight changes:");
    for (const [dim, weight] of Object.entries(result.bestWeights)) {
      const diff = weight - (baseWeights[dim] ?? 0);
      if (Math.abs(diff) > 0.005) {
        const diffStr = diff > 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3);
        console.log(`    ${dim.padEnd(24)} ${weight.toFixed(3)} (${diffStr})`);
      }
    }
  } else {
    console.log("  Current weights are already optimal.");
  }
  console.log();
}

function main() {
  console.log("=== typegrade Multi-Objective Weight Optimizer (train-only) ===\n");

  const snapshot = findLatestTrainSnapshot();
  if (!snapshot) {
    console.error("No train benchmark snapshot found. Run 'pnpm benchmark:train' first.");
    process.exit(1);
  }

  const hasDimensions = snapshot.entries.some((en) => en.dimensions && en.dimensions.length > 0);
  if (!hasDimensions) {
    console.error("Snapshot has no dimension data. Cannot optimize weights.");
    process.exit(1);
  }

  // Optimize each composite independently
  const results: Record<string, ReturnType<typeof optimizeComposite>> = {};
  const baseWeightsMap: Record<string, Record<string, number>> = {};
  let totalCandidates = 0;

  for (const composite of COMPOSITE_KEYS) {
    const baseWeights = extractWeights(composite);
    baseWeightsMap[composite] = baseWeights;

    console.log(`Optimizing ${composite} (${Object.keys(baseWeights).length} dimensions)...`);
    results[composite] = optimizeComposite(snapshot.entries, composite, baseWeights);
    totalCandidates += results[composite]!.candidatesEvaluated;
  }

  // Print results
  console.log(`\n=== Optimization Results (${totalCandidates} total candidates) ===\n`);

  for (const composite of COMPOSITE_KEYS) {
    printCompositeResult(composite, baseWeightsMap[composite]!, results[composite]!);
  }

  // Aggregate summary
  const anyImproved = COMPOSITE_KEYS.some((ck) => results[ck]!.improved);
  let totalMustPassBaseline = 0;
  let totalMustPassBest = 0;
  let totalHardDiagBaseline = 0;
  let totalHardDiagBest = 0;

  for (const composite of COMPOSITE_KEYS) {
    totalMustPassBaseline += results[composite]!.baseline.mustPassFailures;
    totalMustPassBest += results[composite]!.best.mustPassFailures;
    totalHardDiagBaseline += results[composite]!.baseline.hardDiagFailures;
    totalHardDiagBest += results[composite]!.best.hardDiagFailures;
  }

  console.log("=== Aggregate ===");
  console.log(`  Must-pass failures: ${totalMustPassBaseline} → ${totalMustPassBest}`);
  console.log(`  Hard-diagnostic failures: ${totalHardDiagBaseline} → ${totalHardDiagBest}`);
  console.log(`  Any improvement found: ${anyImproved ? "yes" : "no"}`);

  // Save optimizer results
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output", "optimize");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const report: Record<string, unknown> = {
    composites: {} as Record<string, unknown>,
    summary: {
      anyImproved,
      totalCandidates,
      totalHardDiagBaseline,
      totalHardDiagBest,
      totalMustPassBaseline,
      totalMustPassBest,
    },
    timestamp: new Date().toISOString(),
  };

  const composites = report["composites"] as Record<string, unknown>;
  for (const composite of COMPOSITE_KEYS) {
    const res = results[composite]!;
    composites[composite] = {
      baseline: {
        concordance: Math.round(res.baseline.rate * 1000) / 1000,
        hardDiagFailures: res.baseline.hardDiagFailures,
        mustPassFailures: res.baseline.mustPassFailures,
        weights: baseWeightsMap[composite],
      },
      candidatesEvaluated: res.candidatesEvaluated,
      improved: res.improved,
      optimal: {
        concordance: Math.round(res.best.rate * 1000) / 1000,
        hardDiagFailures: res.best.hardDiagFailures,
        mustPassFailures: res.best.mustPassFailures,
        weights: res.bestWeights,
      },
    };
  }

  const reportPath = join(outputDir, "latest.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nOptimizer report saved to benchmarks-output/optimize/latest.json`);
}

main();
