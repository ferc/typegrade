#!/usr/bin/env tsx
/**
 * Eval judge — runs evaluation benchmarks and produces redacted summaries.
 *
 * This script:
 * 1. Reads raw eval results from benchmarks-output/eval-raw/
 * 2. Computes unlabeled evaluation metrics
 * 3. Emits only a RedactedEvalSummary to benchmarks-output/eval-summary.json
 * 4. Raw eval details are NOT exposed to the builder agent
 *
 * Quarantine: This script may read eval manifests and raw eval output.
 * It must NOT modify scoring code or calibration weights.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANALYSIS_SCHEMA_VERSION } from "../src/types.js";
import type {
  ParetoViolation,
  RawBenchmarkSnapshotV2,
  RedactedEvalSummary,
  UnlabeledEvalMetrics,
} from "./types.js";
import { wilsonUpperBound } from "./stats.js";

const args = process.argv.slice(2);
const auditMode = args.includes("--audit");

interface EvalEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety: number | null;
  domainFitScore: number | null;
  domainInference: { domain: string; confidence: number } | null;
  scenarioScore: { score: number } | null;
  graphStats: { usedFallbackGlob: boolean; totalReachable?: number } | null;
  coverageDiagnostics: {
    typesSource: string;
    reachableFiles: number;
    measuredPositions: number;
    measuredDeclarations: number;
    undersampled: boolean;
    undersampledReasons: string[];
    samplingClass?: "complete" | "compact" | "undersampled";
  } | null;
  dimensions: { key: string; score: number | null; confidence: number | null }[];
}

interface EvalSnapshot {
  timestamp: string;
  corpusSplit: string;
  seed?: number;
  manifestSource?: string;
  manifestHash?: string;
  sampleCount?: number;
  sampledHashes?: string[];
  entries: EvalEntry[];
  /** Install failures recorded during benchmarking */
  installFailures?: { spec: string; tier: string; error: string }[];
}

/** Metrics computed per seed for multi-seed aggregation */
interface PerSeedMetrics {
  seed: number;
  undersampledRate: number;
  domainOverreachRate: number;
  scenarioOverreachRate: number;
}

/** Multi-seed aggregate result before inclusion in the summary */
interface MultiSeedResult {
  seedCount: number;
  wrongSpecificP50: number;
  wrongSpecificP90: number;
  undersampledP50: number;
  undersampledP90: number;
  scenarioOverreachP50: number;
  scenarioOverreachP90: number;
  perFamilyScoreVariance: number;
}

/** Baseline comparison delta for a single metric */
interface MetricDelta {
  metric: string;
  baseline: number;
  current: number;
}

function findLatestEvalSnapshot(): EvalSnapshot | null {
  const evalDir = join(import.meta.dirname, "..", "benchmarks-output", "eval-raw");
  if (!existsSync(evalDir)) {
    return null;
  }

  const files = readdirSync(evalDir)
    .filter((fn) => fn.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }

  const latestFile = files[files.length - 1]!;
  return JSON.parse(readFileSync(join(evalDir, latestFile), "utf8"));
}

function loadAllEvalSnapshots(): EvalSnapshot[] {
  const evalDir = join(import.meta.dirname, "..", "benchmarks-output", "eval-raw");
  if (!existsSync(evalDir)) {
    return [];
  }

  const files = readdirSync(evalDir)
    .filter((fn) => fn.endsWith(".json"))
    .sort();
  const snapshots: EvalSnapshot[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(evalDir, file), "utf8")) as EvalSnapshot;
      snapshots.push(parsed);
    } catch {
      // Skip malformed snapshot files
    }
  }
  return snapshots;
}

/**
 * Compute the expected manifest hash for the eval-pool manifest.
 * Used to validate that random-eval artifacts were produced from
 * the current eval-pool manifest, not an outdated or wrong one.
 */
function computeEvalPoolManifestHash(): string | null {
  const poolPath = join(import.meta.dirname, "..", "benchmarks", "manifest.eval.pool.json");
  if (!existsSync(poolPath)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(poolPath, "utf8"));
  const packages = raw.packages ?? raw;
  return createHash("sha256").update(JSON.stringify(packages)).digest("hex").slice(0, 16);
}

/**
 * Validate that a random-eval snapshot was produced from the current
 * eval-pool manifest. Rejects stale or cross-manifest artifacts.
 */
function validateSnapshotManifest(
  snapshot: EvalSnapshot,
  expectedHash: string | null,
): { valid: boolean; reason?: string } {
  // Fixed eval snapshots don't need manifest hash validation
  if (snapshot.corpusSplit === "eval-fixed") {
    return { valid: true };
  }

  // Pool-sampled snapshots must have a manifest hash
  if (!snapshot.manifestHash) {
    return { reason: "missing manifestHash on pool-sampled artifact", valid: false };
  }

  if (expectedHash && snapshot.manifestHash !== expectedHash) {
    return {
      reason: `manifest hash mismatch: artifact=${snapshot.manifestHash}, current=${expectedHash}`,
      valid: false,
    };
  }

  return { valid: true };
}

/**
 * Compute seed robustness by comparing consumerApi scores across snapshots
 * with different seeds. A package is "unstable" if its consumerApi score
 * varies by more than 5 points across different seeds.
 *
 * Returns the rate of unstable packages (unstable / total seen across seeds),
 * or undefined if fewer than 2 distinct seeds are available.
 */
function computeSeedRobustness(snapshots: EvalSnapshot[]): number | undefined {
  // Group snapshots by seed, ignoring those without a seed
  const bySeed = new Map<number, EvalSnapshot[]>();
  for (const snap of snapshots) {
    if (snap.seed === undefined) {
      continue;
    }
    const group = bySeed.get(snap.seed);
    if (group) {
      group.push(snap);
    } else {
      bySeed.set(snap.seed, [snap]);
    }
  }

  const seedKeys = [...bySeed.keys()];
  if (seedKeys.length < 2) {
    return undefined;
  }

  // Build per-package score map: packageName -> Map<seed, consumerApi>
  // When multiple snapshots share the same seed, use the latest (last) one
  const packageScores = new Map<string, Map<number, number>>();
  for (const [seed, seedSnapshots] of bySeed) {
    // Use the last snapshot for each seed (latest by file sort order)
    const latest = seedSnapshots[seedSnapshots.length - 1]!;
    for (const entry of latest.entries) {
      if (entry.consumerApi === null) {
        continue;
      }
      let seedMap = packageScores.get(entry.name);
      if (!seedMap) {
        seedMap = new Map<number, number>();
        packageScores.set(entry.name, seedMap);
      }
      seedMap.set(seed, entry.consumerApi);
    }
  }

  // Only consider packages that appear in at least 2 different seeds
  let totalPackages = 0;
  let unstablePackages = 0;

  for (const [, seedMap] of packageScores) {
    if (seedMap.size < 2) {
      continue;
    }
    totalPackages++;
    const scores = [...seedMap.values()];
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    if (maxScore - minScore > 5) {
      unstablePackages++;
    }
  }

  if (totalPackages === 0) {
    return undefined;
  }

  return Math.round((unstablePackages / totalPackages) * 1000) / 1000;
}

/**
 * Find the latest train snapshot from benchmarks/results/.
 * Mirrors the logic in optimize.ts: scan .json files in reverse sort order,
 * return the first where corpusSplit is "train" or missing.
 */
function findLatestTrainSnapshot(): RawBenchmarkSnapshotV2 | null {
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    return null;
  }

  const files = readdirSync(resultsDir)
    .filter((fl) => fl.endsWith(".json"))
    .sort();
  for (let idx = files.length - 1; idx >= 0; idx--) {
    try {
      const data = JSON.parse(
        readFileSync(join(resultsDir, files[idx]!), "utf8"),
      ) as RawBenchmarkSnapshotV2;
      if (!data.corpusSplit || data.corpusSplit === "train") {
        return data;
      }
    } catch {
      // Skip malformed files
    }
  }
  return null;
}

/**
 * Compute distribution drift between train and eval consumerApi scores.
 *
 * Drift = |trainMedian - evalMedian| / avgStdDev
 * where avgStdDev = (trainStdDev + evalStdDev) / 2
 *
 * Returns null if train data is unavailable or either split has fewer than 3 scores.
 * Returns 0 when distributions are identical, >1 when substantially different.
 */
function computeTrainEvalDrift(evalEntries: EvalEntry[]): number | null {
  const trainSnapshot = findLatestTrainSnapshot();
  if (!trainSnapshot) {
    return null;
  }

  // Extract valid consumerApi scores from each split
  const trainScores = trainSnapshot.entries
    .map((en) => en.consumerApi)
    .filter((sc): sc is number => sc !== null && sc > 0);
  const evalScores = evalEntries
    .map((en) => en.consumerApi)
    .filter((sc): sc is number => sc !== null && sc > 0);

  // Need at least 3 scores in each split for meaningful statistics
  if (trainScores.length < 3 || evalScores.length < 3) {
    return null;
  }

  const computeMedian = (arr: number[]): number => {
    const sorted = [...arr].sort((aa, bb) => aa - bb);
    return sorted[Math.floor(sorted.length / 2)]!;
  };

  const computeMean = (arr: number[]): number => {
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
  };

  const computeStdDev = (arr: number[]): number => {
    const mn = computeMean(arr);
    const variance = arr.reduce((sum, val) => sum + (val - mn) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  };

  const trainMedian = computeMedian(trainScores);
  const evalMedian = computeMedian(evalScores);
  const trainStdDev = computeStdDev(trainScores);
  const evalStdDev = computeStdDev(evalScores);

  const avgStdDev = (trainStdDev + evalStdDev) / 2;

  // Guard against zero variance (all scores identical in both splits)
  if (avgStdDev === 0) {
    return trainMedian === evalMedian ? 0 : Infinity;
  }

  const drift = Math.abs(trainMedian - evalMedian) / avgStdDev;
  return Math.round(drift * 1000) / 1000;
}

function computeUnlabeledMetrics(entries: EvalEntry[]): UnlabeledEvalMetrics {
  const total = entries.length;
  if (total === 0) {
    return {
      coverageConfidenceViolations: 0,
      domainOverreachRate: 0,
      fallbackGlobRate: 0,
      paretoViolationCount: 0,
      scenarioOverreachRate: 0,
      scoreCompressionRate: 0,
      undersampledRate: 0,
    };
  }

  // Undersampled rate
  const undersampledCount = entries.filter((en) => en.coverageDiagnostics?.undersampled).length;
  const undersampledRate = undersampledCount / total;

  // Fallback glob rate
  const fallbackCount = entries.filter((en) => en.graphStats?.usedFallbackGlob).length;
  const fallbackGlobRate = fallbackCount / total;

  // Coverage-confidence violations: high score + low coverage
  let coverageConfidenceViolations = 0;
  for (const entry of entries) {
    const score = entry.consumerApi ?? 0;
    const cov = entry.coverageDiagnostics;
    if (score >= 70 && cov?.undersampled) {
      coverageConfidenceViolations++;
    }
  }

  // Pareto violations
  const paretoViolations = detectParetoViolations(entries);
  const paretoViolationCount = paretoViolations.length;

  // Score compression: % of packages within a 10-point band
  const scores = entries.map((en) => en.consumerApi ?? 0).filter((sc) => sc > 0);
  const scoreCompressionRate = computeScoreCompression(scores);

  // Domain overreach: predicting specific domain without strong evidence
  let domainOverreachCount = 0;
  for (const entry of entries) {
    if (
      entry.domainInference &&
      entry.domainInference.domain !== "general" &&
      entry.domainInference.confidence < 0.7
    ) {
      domainOverreachCount++;
    }
  }
  const domainOverreachRate = domainOverreachCount / total;

  // Scenario overreach: scenario scores emitted without sufficient domain confidence
  let scenarioOverreachCount = 0;
  for (const entry of entries) {
    if (entry.scenarioScore && (!entry.domainInference || entry.domainInference.confidence < 0.7)) {
      scenarioOverreachCount++;
    }
  }
  const scenarioOverreachRate = scenarioOverreachCount / total;

  // Compact package rate
  const compactCount = entries.filter(
    (en) => en.coverageDiagnostics?.samplingClass === "compact",
  ).length;
  const compactRate = compactCount / total;

  // Confidence moderation rate — packages with compositeConfidenceReasons mentioning moderation
  // Approximated by: high score + low confidence (score >= 70 + fewer than 10 positions)
  let moderatedCount = 0;
  for (const entry of entries) {
    const cov = entry.coverageDiagnostics;
    const score = entry.consumerApi ?? 0;
    if (score >= 60 && cov && (cov.undersampled || cov.samplingClass === "compact")) {
      moderatedCount++;
    }
  }
  const confidenceModerationRate = moderatedCount / total;

  // Train-vs-eval distribution drift
  const driftValue = computeTrainEvalDrift(entries);

  const result: UnlabeledEvalMetrics = {
    compactRate: Math.round(compactRate * 1000) / 1000,
    confidenceModerationRate: Math.round(confidenceModerationRate * 1000) / 1000,
    coverageConfidenceViolations,
    domainOverreachRate: Math.round(domainOverreachRate * 1000) / 1000,
    fallbackGlobRate: Math.round(fallbackGlobRate * 1000) / 1000,
    paretoViolationCount,
    scenarioOverreachRate: Math.round(scenarioOverreachRate * 1000) / 1000,
    scoreCompressionRate: Math.round(scoreCompressionRate * 1000) / 1000,
    undersampledRate: Math.round(undersampledRate * 1000) / 1000,
  };

  if (driftValue !== null) {
    result.trainEvalDrift = driftValue;
  }

  return result;
}

function detectParetoViolations(entries: EvalEntry[]): ParetoViolation[] {
  const violations: ParetoViolation[] = [];
  const coreDimensions = ["apiSpecificity", "apiSafety", "semanticLift", "specializationPower"];

  for (let ii = 0; ii < entries.length; ii++) {
    for (let jj = ii + 1; jj < entries.length; jj++) {
      const aa = entries[ii]!;
      const bb = entries[jj]!;

      if (aa.consumerApi === null || bb.consumerApi === null) {
        continue;
      }

      // Check if A dominates B on core dimensions
      const aDominates = checkDominance(aa, bb, coreDimensions);
      const bDominates = checkDominance(bb, aa, coreDimensions);

      if (aDominates.dominates && aa.consumerApi < bb.consumerApi) {
        violations.push({
          dominant: aa.name,
          dominantComposite: aa.consumerApi,
          dominantDimensions: aDominates.dimensions,
          dominated: bb.name,
          dominatedComposite: bb.consumerApi,
        });
      }

      if (bDominates.dominates && bb.consumerApi < aa.consumerApi) {
        violations.push({
          dominant: bb.name,
          dominantComposite: bb.consumerApi,
          dominantDimensions: bDominates.dimensions,
          dominated: aa.name,
          dominatedComposite: aa.consumerApi,
        });
      }
    }
  }

  return violations;
}

function checkDominance(
  aa: EvalEntry,
  bb: EvalEntry,
  dimensions: string[],
): { dominates: boolean; dimensions: string[] } {
  const dominantDims: string[] = [];
  let anyWorse = false;

  for (const dim of dimensions) {
    const aScore = aa.dimensions.find((dd) => dd.key === dim)?.score ?? null;
    const bScore = bb.dimensions.find((dd) => dd.key === dim)?.score ?? null;
    if (aScore === null || bScore === null) {
      continue;
    }

    if (aScore > bScore + 3) {
      dominantDims.push(dim);
    } else if (bScore > aScore + 3) {
      anyWorse = true;
      break;
    }
  }

  return {
    dimensions: dominantDims,
    dominates: !anyWorse && dominantDims.length >= 3,
  };
}

function computeScoreCompression(scores: number[]): number {
  if (scores.length < 3) {
    return 0;
  }

  const sorted = scores.toSorted((aa, bb) => aa - bb);
  const med = sorted[Math.floor(sorted.length / 2)]!;

  // Count how many scores are within +/-5 of the median
  const compressed = scores.filter((sc) => Math.abs(sc - med) <= 5).length;
  return compressed / scores.length;
}

// ─── Percentile Helpers ───────────────────────────────────────────────────

/** Compute the p-th percentile from a sorted array of numbers (0-100 scale) */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const rank = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower]!;
  }
  const fraction = rank - lower;
  return sorted[lower]! + fraction * (sorted[upper]! - sorted[lower]!);
}

/** Round a number to 3 decimal places */
function round3(val: number): number {
  return Math.round(val * 1000) / 1000;
}

// ─── Multi-Seed Aggregation ───────────────────────────────────────────────

/**
 * Compute per-seed metrics from valid snapshots.
 * Groups snapshots by seed, uses the latest per seed, and computes
 * the same unlabeled metrics for each seed.
 */
function computePerSeedMetrics(snapshots: EvalSnapshot[]): PerSeedMetrics[] {
  const bySeed = new Map<number, EvalSnapshot>();
  for (const snap of snapshots) {
    if (snap.seed === undefined) {
      continue;
    }
    // Later snapshots overwrite earlier ones (latest wins)
    bySeed.set(snap.seed, snap);
  }

  const results: PerSeedMetrics[] = [];
  for (const [seed, snap] of bySeed) {
    const total = snap.entries.length;
    if (total === 0) {
      continue;
    }

    const undersampledCount = snap.entries.filter(
      (en) => en.coverageDiagnostics?.undersampled,
    ).length;

    let domainOverreachCount = 0;
    for (const entry of snap.entries) {
      if (
        entry.domainInference &&
        entry.domainInference.domain !== "general" &&
        entry.domainInference.confidence < 0.7
      ) {
        domainOverreachCount++;
      }
    }

    let scenarioOverreachCount = 0;
    for (const entry of snap.entries) {
      if (
        entry.scenarioScore &&
        (!entry.domainInference || entry.domainInference.confidence < 0.7)
      ) {
        scenarioOverreachCount++;
      }
    }

    results.push({
      domainOverreachRate: domainOverreachCount / total,
      scenarioOverreachRate: scenarioOverreachCount / total,
      seed,
      undersampledRate: undersampledCount / total,
    });
  }

  return results;
}

/**
 * Compute per-family (tier) score variance across seeds.
 * Groups entries by tier across seeds, computes median consumerApi per tier per seed,
 * then computes the variance of those medians across seeds.
 * Returns the maximum variance across all families.
 */
function computePerFamilyScoreVariance(snapshots: EvalSnapshot[]): number {
  const bySeed = new Map<number, EvalSnapshot>();
  for (const snap of snapshots) {
    if (snap.seed === undefined) {
      continue;
    }
    bySeed.set(snap.seed, snap);
  }

  if (bySeed.size < 2) {
    return 0;
  }

  // Collect all tiers across all seeds
  const allTiers = new Set<string>();
  for (const [, snap] of bySeed) {
    for (const entry of snap.entries) {
      allTiers.add(entry.tier);
    }
  }

  const medianOf = (arr: number[]): number => {
    const sorted = [...arr].sort((aa, bb) => aa - bb);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };

  const varianceOf = (arr: number[]): number => {
    if (arr.length < 2) {
      return 0;
    }
    const mean = arr.reduce((sum, val) => sum + val, 0) / arr.length;
    return arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
  };

  // For each tier, compute median consumerApi per seed, then variance of those medians
  let maxVariance = 0;
  for (const tier of allTiers) {
    const mediansBySeed: number[] = [];
    for (const [, snap] of bySeed) {
      const tierScores = snap.entries
        .filter((en) => en.tier === tier && en.consumerApi !== null)
        .map((en) => en.consumerApi as number);
      if (tierScores.length > 0) {
        mediansBySeed.push(medianOf(tierScores));
      }
    }
    if (mediansBySeed.length >= 2) {
      const tierVariance = varianceOf(mediansBySeed);
      if (tierVariance > maxVariance) {
        maxVariance = tierVariance;
      }
    }
  }

  return round3(maxVariance);
}

/**
 * Compute multi-seed aggregate metrics from valid snapshots.
 * Returns null if fewer than 2 distinct seeds are available.
 */
function computeMultiSeedMetrics(snapshots: EvalSnapshot[]): MultiSeedResult | null {
  const perSeed = computePerSeedMetrics(snapshots);
  if (perSeed.length < 2) {
    return null;
  }

  // Sort each metric array for percentile computation
  const domainOverreachRates = perSeed
    .map((ps) => ps.domainOverreachRate)
    .sort((aa, bb) => aa - bb);
  const undersampledRates = perSeed.map((ps) => ps.undersampledRate).sort((aa, bb) => aa - bb);
  const scenarioRates = perSeed.map((ps) => ps.scenarioOverreachRate).sort((aa, bb) => aa - bb);

  // Domain overreach rate is used as a proxy for wrong-specific rate
  // (eval entries lack ground-truth labels, so domain overreach is the best signal)
  const familyVariance = computePerFamilyScoreVariance(snapshots);

  return {
    perFamilyScoreVariance: familyVariance,
    scenarioOverreachP50: round3(percentile(scenarioRates, 50)),
    scenarioOverreachP90: round3(percentile(scenarioRates, 90)),
    seedCount: perSeed.length,
    undersampledP50: round3(percentile(undersampledRates, 50)),
    undersampledP90: round3(percentile(undersampledRates, 90)),
    wrongSpecificP50: round3(percentile(domainOverreachRates, 50)),
    wrongSpecificP90: round3(percentile(domainOverreachRates, 90)),
  };
}

// ─── Baseline Comparison ──────────────────────────────────────────────────

/** Metrics to compare between baseline and current summary */
const BASELINE_METRICS = [
  "undersampledRate",
  "fallbackGlobRate",
  "domainOverreachRate",
  "scenarioOverreachRate",
  "scoreCompressionRate",
  "paretoViolationCount",
  "coverageConfidenceViolations",
] as const;

/**
 * Load the approved baseline from disk if it exists.
 * Returns null if no baseline file is found or it cannot be parsed.
 */
function loadApprovedBaseline(): RedactedEvalSummary | null {
  const baselinePath = join(import.meta.dirname, "baselines", "approved-baseline.json");
  if (!existsSync(baselinePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8")) as RedactedEvalSummary;
  } catch {
    // Baseline file is malformed
    return null;
  }
}

/**
 * Compare current metrics against an approved baseline.
 * A regression means the current value is worse (higher for rates/counts).
 * An improvement means the current value is better (lower for rates/counts).
 * Returns null if no baseline is available.
 */
function compareWithBaseline(currentMetrics: RedactedEvalSummary["metrics"]): {
  baselineTimestamp: string;
  regressions: MetricDelta[];
  improvements: MetricDelta[];
} | null {
  const baseline = loadApprovedBaseline();
  if (!baseline) {
    return null;
  }

  const regressions: MetricDelta[] = [];
  const improvements: MetricDelta[] = [];

  for (const key of BASELINE_METRICS) {
    const baseVal = baseline.metrics[key];
    const currVal = currentMetrics[key];

    // Skip if either value is undefined
    if (baseVal === undefined || currVal === undefined) {
      continue;
    }

    // For all these metrics, lower is better
    const diff = currVal - baseVal;
    const threshold = 0.001;

    if (diff > threshold) {
      regressions.push({ baseline: baseVal, current: currVal, metric: key });
    } else if (diff < -threshold) {
      improvements.push({ baseline: baseVal, current: currVal, metric: key });
    }
  }

  return {
    baselineTimestamp: baseline.timestamp,
    improvements,
    regressions,
  };
}

// ─── Gate Builders ────────────────────────────────────────────────────────

function buildEvalGates(
  metrics: UnlabeledEvalMetrics,
  totalEntries: number,
): { gate: string; passed: boolean; detail: string }[] {
  // CI-bound helpers: compute Wilson upper bounds for failure rates
  const overreachCount = Math.round(metrics.domainOverreachRate * totalEntries);
  const undersampledCount = Math.round(metrics.undersampledRate * totalEntries);
  const fallbackCount = Math.round(metrics.fallbackGlobRate * totalEntries);
  const scenarioCount = Math.round(metrics.scenarioOverreachRate * totalEntries);

  const overreachUB = wilsonUpperBound(overreachCount, totalEntries);
  const undersampledUB = wilsonUpperBound(undersampledCount, totalEntries);
  const fallbackUB = wilsonUpperBound(fallbackCount, totalEntries);
  const scenarioUB = wilsonUpperBound(scenarioCount, totalEntries);

  return [
    {
      detail: `${(metrics.domainOverreachRate * 100).toFixed(1)}%, 99%CI upper: ${(overreachUB * 100).toFixed(1)}%`,
      gate: "eval-wrong-specific-rate-CI<=10%",
      passed: overreachUB <= 0.1,
    },
    {
      detail: `${metrics.coverageConfidenceViolations} violation(s)`,
      gate: "eval-coverage-confidence-=0",
      passed: metrics.coverageConfidenceViolations === 0,
    },
    {
      detail: `${(metrics.undersampledRate * 100).toFixed(1)}%, 99%CI upper: ${(undersampledUB * 100).toFixed(1)}%`,
      gate: "eval-undersampled-rate-CI<=15%",
      passed: undersampledUB <= 0.15,
    },
    {
      detail: `${(metrics.scenarioOverreachRate * 100).toFixed(1)}%, 99%CI upper: ${(scenarioUB * 100).toFixed(1)}%`,
      gate: "eval-scenario-overreach-CI<=15%",
      passed: scenarioUB <= 0.15,
    },
    {
      detail: `${(metrics.fallbackGlobRate * 100).toFixed(1)}%, 99%CI upper: ${(fallbackUB * 100).toFixed(1)}%`,
      gate: "eval-fallback-rate-CI<=5%",
      passed: fallbackUB <= 0.05,
    },
    {
      detail: `${metrics.paretoViolationCount} violation(s)`,
      gate: "eval-pareto-violations-<3",
      passed: metrics.paretoViolationCount < 3,
    },
    {
      detail: `${(metrics.scoreCompressionRate * 100).toFixed(1)}%`,
      gate: "eval-score-compression-<60%",
      passed: metrics.scoreCompressionRate < 0.6,
    },
    {
      detail:
        metrics.seedInstabilityRate !== undefined
          ? `${(metrics.seedInstabilityRate * 100).toFixed(1)}%`
          : "n/a (insufficient seeds)",
      gate: "eval-seed-instability-<10%",
      passed: metrics.seedInstabilityRate === undefined || metrics.seedInstabilityRate < 0.1,
    },
    {
      detail: `${(metrics.domainOverreachRate * 100).toFixed(1)}%`,
      gate: "eval-domain-overreach-<15%",
      passed: metrics.domainOverreachRate < 0.15,
    },
    {
      detail:
        metrics.trainEvalDrift !== undefined
          ? `${metrics.trainEvalDrift.toFixed(3)}`
          : "n/a (no train data)",
      gate: "eval-train-drift-<2.0",
      passed: metrics.trainEvalDrift === undefined || metrics.trainEvalDrift < 2.0,
    },
    {
      detail:
        metrics.confidenceModerationRate !== undefined
          ? `${(metrics.confidenceModerationRate * 100).toFixed(1)}%`
          : "n/a",
      gate: "eval-confidence-moderation-<20%",
      passed:
        metrics.confidenceModerationRate === undefined || metrics.confidenceModerationRate < 0.2,
    },
  ];
}

/**
 * Build multi-seed gates from aggregate metrics.
 * Only called when multiSeedMetrics is available.
 */
function buildMultiSeedGates(
  multiSeed: MultiSeedResult,
): { gate: string; passed: boolean; detail: string }[] {
  return [
    {
      detail: `p50=${(multiSeed.wrongSpecificP50 * 100).toFixed(1)}%`,
      gate: "multi-seed-wrong-specific-p50-<=8%",
      passed: multiSeed.wrongSpecificP50 <= 0.08,
    },
    {
      detail: `p90=${(multiSeed.wrongSpecificP90 * 100).toFixed(1)}%`,
      gate: "multi-seed-wrong-specific-p90-<=12%",
      passed: multiSeed.wrongSpecificP90 <= 0.12,
    },
    {
      detail: `p50=${(multiSeed.undersampledP50 * 100).toFixed(1)}%`,
      gate: "multi-seed-undersampled-p50-<=10%",
      passed: multiSeed.undersampledP50 <= 0.1,
    },
    {
      detail: `p90=${(multiSeed.undersampledP90 * 100).toFixed(1)}%`,
      gate: "multi-seed-undersampled-p90-<=15%",
      passed: multiSeed.undersampledP90 <= 0.15,
    },
    {
      detail: `p50=${(multiSeed.scenarioOverreachP50 * 100).toFixed(1)}%`,
      gate: "multi-seed-scenario-overreach-p50-<=10%",
      passed: multiSeed.scenarioOverreachP50 <= 0.1,
    },
    {
      detail: `p90=${(multiSeed.scenarioOverreachP90 * 100).toFixed(1)}%`,
      gate: "multi-seed-scenario-overreach-p90-<=15%",
      passed: multiSeed.scenarioOverreachP90 <= 0.15,
    },
    {
      detail: `variance=${multiSeed.perFamilyScoreVariance.toFixed(2)}`,
      gate: "multi-seed-family-variance-<=5",
      passed: multiSeed.perFamilyScoreVariance <= 5,
    },
  ];
}

// ─── Console Output Helpers ───────────────────────────────────────────────

function printMetrics(metrics: UnlabeledEvalMetrics): void {
  console.log("=== Eval Metrics ===\n");
  console.log(`  Undersampled rate:          ${(metrics.undersampledRate * 100).toFixed(1)}%`);
  console.log(`  Fallback glob rate:         ${(metrics.fallbackGlobRate * 100).toFixed(1)}%`);
  console.log(`  Coverage-confidence viols:  ${metrics.coverageConfidenceViolations}`);
  console.log(`  Pareto violations:          ${metrics.paretoViolationCount}`);
  console.log(`  Score compression:          ${(metrics.scoreCompressionRate * 100).toFixed(1)}%`);
  const seedLabel =
    metrics.seedInstabilityRate !== undefined
      ? `${(metrics.seedInstabilityRate * 100).toFixed(1)}%`
      : "n/a (insufficient seeds)";
  console.log(`  Seed instability rate:      ${seedLabel}`);
  console.log(`  Domain overreach rate:      ${(metrics.domainOverreachRate * 100).toFixed(1)}%`);
  console.log(`  Scenario overreach rate:    ${(metrics.scenarioOverreachRate * 100).toFixed(1)}%`);
  const driftLabel =
    metrics.trainEvalDrift !== undefined
      ? metrics.trainEvalDrift.toFixed(3)
      : "n/a (no train data)";
  console.log(`  Train-eval drift:           ${driftLabel}`);
  const compactLabel =
    metrics.compactRate !== undefined ? `${(metrics.compactRate * 100).toFixed(1)}%` : "n/a";
  console.log(`  Compact package rate:       ${compactLabel}`);
  const moderationLabel =
    metrics.confidenceModerationRate !== undefined
      ? `${(metrics.confidenceModerationRate * 100).toFixed(1)}%`
      : "n/a";
  console.log(`  Confidence moderation rate: ${moderationLabel}`);
}

function printGates(gates: { gate: string; passed: boolean; detail: string }[]): void {
  console.log("\n=== Eval Gates ===\n");
  for (const gate of gates) {
    const icon = gate.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${gate.gate.padEnd(45)} ${gate.detail}`);
  }
  const passedCount = gates.filter((gg) => gg.passed).length;
  console.log(`\n  ${passedCount}/${gates.length} eval gates passed`);
}

function printMultiSeedMetrics(multiSeed: MultiSeedResult): void {
  console.log("\n=== Multi-Seed Aggregate Metrics ===\n");
  console.log(`  Seeds:                      ${multiSeed.seedCount}`);
  console.log(`  Wrong-specific p50:         ${(multiSeed.wrongSpecificP50 * 100).toFixed(1)}%`);
  console.log(`  Wrong-specific p90:         ${(multiSeed.wrongSpecificP90 * 100).toFixed(1)}%`);
  console.log(`  Undersampled p50:           ${(multiSeed.undersampledP50 * 100).toFixed(1)}%`);
  console.log(`  Undersampled p90:           ${(multiSeed.undersampledP90 * 100).toFixed(1)}%`);
  console.log(
    `  Scenario-overreach p50:     ${(multiSeed.scenarioOverreachP50 * 100).toFixed(1)}%`,
  );
  console.log(
    `  Scenario-overreach p90:     ${(multiSeed.scenarioOverreachP90 * 100).toFixed(1)}%`,
  );
  console.log(`  Per-family score variance:  ${multiSeed.perFamilyScoreVariance.toFixed(2)}`);
}

function printBaselineComparison(comparison: {
  baselineTimestamp: string;
  regressions: MetricDelta[];
  improvements: MetricDelta[];
}): void {
  console.log("\n=== Baseline Comparison ===\n");
  console.log(`  Baseline from: ${comparison.baselineTimestamp}`);

  if (comparison.regressions.length > 0) {
    console.log("\n  Regressions:");
    for (const reg of comparison.regressions) {
      console.log(`    ${reg.metric}: ${reg.baseline} -> ${reg.current}`);
    }
  }

  if (comparison.improvements.length > 0) {
    console.log("\n  Improvements:");
    for (const imp of comparison.improvements) {
      console.log(`    ${imp.metric}: ${imp.baseline} -> ${imp.current}`);
    }
  }

  if (comparison.regressions.length === 0 && comparison.improvements.length === 0) {
    console.log("  No significant changes from baseline.");
  }
}

function printAuditDetails(snapshot: EvalSnapshot): void {
  console.log("\n=== AUDIT: Per-Package Details (not for builder consumption) ===\n");
  const sorted = [...snapshot.entries].sort(
    (aa, bb) => (bb.consumerApi ?? 0) - (aa.consumerApi ?? 0),
  );
  console.log(
    `${"Package".padEnd(30)}${"ConsumerApi".padEnd(14)}${"AgentReady".padEnd(14)}${"TypeSafety".padEnd(14)}${"Domain".padEnd(14)}Undersampled`,
  );
  console.log("-".repeat(100));
  for (const en of sorted) {
    const domain = en.domainInference?.domain ?? "n/a";
    const undersampled = en.coverageDiagnostics?.undersampled ? "YES" : "no";
    console.log(
      `${en.name.padEnd(30)}${String(en.consumerApi ?? "n/a").padEnd(14)}${String(en.agentReadiness ?? "n/a").padEnd(14)}${String(en.typeSafety ?? "n/a").padEnd(14)}${domain.padEnd(14)}${undersampled}`,
    );
  }

  // Print Pareto violations
  const violations = detectParetoViolations(snapshot.entries);
  if (violations.length > 0) {
    console.log("\n=== AUDIT: Pareto Violations ===\n");
    for (const vv of violations) {
      console.log(
        `  ${vv.dominant} (${vv.dominantComposite}) dominates ${vv.dominated} (${vv.dominatedComposite}) on [${vv.dominantDimensions.join(", ")}] but ranks lower`,
      );
    }
  }
}

// ─── Confidence Calibration ───────────────────────────────────────────────

/** Band definition for confidence calibration */
interface CalibrationBand {
  band: string;
  lower: number;
  upper: number;
}

/** Predefined confidence bands */
const CONFIDENCE_BANDS: CalibrationBand[] = [
  { band: "[0-0.3)", lower: 0, upper: 0.3 },
  { band: "[0.3-0.5)", lower: 0.3, upper: 0.5 },
  { band: "[0.5-0.7)", lower: 0.5, upper: 0.7 },
  { band: "[0.7-0.85)", lower: 0.7, upper: 0.85 },
  { band: "[0.85-1.0]", lower: 0.85, upper: 1.01 },
];

/** Calibration result per band — tracks failure modes that matter for trust claims */
interface CalibrationBandResult {
  band: string;
  count: number;
  meanConfidence: number;
  reasonableRate: number;
  /** Rate of entries that are undersampled in this confidence band */
  undersampledRate: number;
  /** Rate of entries using fallback-glob resolution in this band */
  fallbackRate: number;
  /** Rate of entries with low-confidence domain overreach in this band */
  domainOverreachRate: number;
  /** Rate of entries that are degraded in this band */
  degradedRate: number;
  /** Composite failure rate: any of undersampled, fallback, overreach, or degraded */
  failureModeRate: number;
}

/**
 * Compute confidence calibration across eval entries.
 * Groups entries into confidence bands and measures failure mode rates
 * that matter for non-train trust claims: wrong-specific, undersampling,
 * domain overreach, fallback resolution.
 *
 * A well-calibrated system should have decreasing failure mode rates as
 * confidence increases. If high-confidence bands still show failures,
 * the confidence signal is not aligned with actual quality.
 */
function computeConfidenceCalibration(entries: EvalEntry[]): CalibrationBandResult[] {
  const results: CalibrationBandResult[] = [];

  for (const bandDef of CONFIDENCE_BANDS) {
    // Find entries whose average dimension confidence falls in this band
    const bandEntries: {
      confidence: number;
      consumerApi: number | null;
      undersampled: boolean;
      usedFallback: boolean;
      domainOverreach: boolean;
      isDegraded: boolean;
    }[] = [];

    for (const entry of entries) {
      const dimConfs = entry.dimensions
        .filter((dd) => dd.confidence !== null)
        .map((dd) => dd.confidence as number);
      if (dimConfs.length === 0) {
        continue;
      }
      const avgConf = dimConfs.reduce((sum, val) => sum + val, 0) / dimConfs.length;
      if (avgConf >= bandDef.lower && avgConf < bandDef.upper) {
        bandEntries.push({
          confidence: avgConf,
          consumerApi: entry.consumerApi,
          domainOverreach: !!(
            entry.domainInference &&
            entry.domainInference.domain !== "general" &&
            entry.domainInference.confidence < 0.7
          ),
          isDegraded:
            entry.consumerApi === null &&
            entry.agentReadiness === null &&
            entry.typeSafety === null,
          undersampled: !!entry.coverageDiagnostics?.undersampled,
          usedFallback: !!entry.graphStats?.usedFallbackGlob,
        });
      }
    }

    const count = bandEntries.length;
    if (count === 0) {
      results.push({
        band: bandDef.band,
        count: 0,
        degradedRate: 0,
        domainOverreachRate: 0,
        failureModeRate: 0,
        fallbackRate: 0,
        meanConfidence: 0,
        reasonableRate: 0,
        undersampledRate: 0,
      });
      continue;
    }

    const meanConfidence = round3(bandEntries.reduce((sum, be) => sum + be.confidence, 0) / count);
    const reasonableCount = bandEntries.filter((be) => {
      const score = be.consumerApi ?? 0;
      return score >= 40 && score <= 80;
    }).length;

    const undersampledCount = bandEntries.filter((be) => be.undersampled).length;
    const fallbackCount = bandEntries.filter((be) => be.usedFallback).length;
    const overreachCount = bandEntries.filter((be) => be.domainOverreach).length;
    const degradedCount = bandEntries.filter((be) => be.isDegraded).length;
    const failureModeCount = bandEntries.filter(
      (be) => be.undersampled || be.usedFallback || be.domainOverreach || be.isDegraded,
    ).length;

    results.push({
      band: bandDef.band,
      count,
      degradedRate: round3(degradedCount / count),
      domainOverreachRate: round3(overreachCount / count),
      failureModeRate: round3(failureModeCount / count),
      fallbackRate: round3(fallbackCount / count),
      meanConfidence,
      reasonableRate: round3(reasonableCount / count),
      undersampledRate: round3(undersampledCount / count),
    });
  }

  return results;
}

function printCalibration(calibration: CalibrationBandResult[]): void {
  console.log("\n=== Confidence Calibration ===\n");
  console.log(
    `  ${"Band".padEnd(16)}${"Count".padEnd(8)}${"MeanConf".padEnd(10)}${"Reasonable".padEnd(12)}${"FailMode".padEnd(10)}${"Unsamp".padEnd(9)}${"Fallbk".padEnd(9)}${"Overrch".padEnd(9)}Degraded`,
  );
  console.log(`  ${"-".repeat(92)}`);
  for (const entry of calibration) {
    console.log(
      `  ${entry.band.padEnd(16)}${String(entry.count).padEnd(8)}${entry.meanConfidence.toFixed(3).padEnd(10)}${((entry.reasonableRate * 100).toFixed(1) + "%").padEnd(12)}${((entry.failureModeRate * 100).toFixed(1) + "%").padEnd(10)}${((entry.undersampledRate * 100).toFixed(1) + "%").padEnd(9)}${((entry.fallbackRate * 100).toFixed(1) + "%").padEnd(9)}${((entry.domainOverreachRate * 100).toFixed(1) + "%").padEnd(9)}${(entry.degradedRate * 100).toFixed(1)}%`,
    );
  }
}

// ─── Family Metrics & Examples ────────────────────────────────────────────

/** Per-family score aggregation for the summary */
interface FamilyMetric {
  family: string;
  meanScore: number;
  variance: number;
  count: number;
}

/**
 * Compute per-family (tier) score metrics from entries.
 * For each unique tier, calculates mean consumerApi, variance, and count.
 */
function computeFamilyMetrics(entries: EvalEntry[]): FamilyMetric[] {
  const byFamily = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.consumerApi === null) {
      continue;
    }
    const scores = byFamily.get(entry.tier);
    if (scores) {
      scores.push(entry.consumerApi);
    } else {
      byFamily.set(entry.tier, [entry.consumerApi]);
    }
  }

  const results: FamilyMetric[] = [];
  for (const [family, scores] of byFamily) {
    const mean = scores.reduce((sum, val) => sum + val, 0) / scores.length;
    const variance =
      scores.length > 1
        ? scores.reduce((sum, val) => sum + (val - mean) ** 2, 0) / scores.length
        : 0;
    results.push({
      count: scores.length,
      family,
      meanScore: round3(mean),
      variance: round3(variance),
    });
  }

  // Sort by family name for consistent output
  results.sort((aa, bb) => aa.family.localeCompare(bb.family));
  return results;
}

/**
 * Compute normalized family variance as the median coefficient of variation
 * across all families with at least 2 members.
 *
 * Coefficient of variation = stdDev / mean (dimensionless ratio).
 * Returns 0 when no families have enough members.
 */
function computeNormalizedFamilyVariance(familyMetrics: FamilyMetric[]): number {
  const coefficients: number[] = [];
  for (const fm of familyMetrics) {
    if (fm.count < 2 || fm.meanScore === 0) {
      continue;
    }
    const cv = Math.sqrt(fm.variance) / fm.meanScore;
    coefficients.push(cv);
  }

  if (coefficients.length === 0) {
    return 0;
  }

  coefficients.sort((aa, bb) => aa - bb);
  const mid = Math.floor(coefficients.length / 2);
  const medianCv =
    coefficients.length % 2 === 0
      ? (coefficients[mid - 1]! + coefficients[mid]!) / 2
      : coefficients[mid]!;
  return round3(medianCv);
}

/**
 * Collect wrong-specific domain examples, redacted to family (tier) only.
 * An entry is wrong-specific when its domain is neither "general" nor matching
 * what one would expect — approximated here by low-confidence specific domain.
 */
function collectWrongSpecificExamples(
  entries: EvalEntry[],
): { family: string; expected: string; actual: string }[] {
  const examples: { family: string; expected: string; actual: string }[] = [];
  for (const entry of entries) {
    if (
      entry.domainInference &&
      entry.domainInference.domain !== "general" &&
      entry.domainInference.confidence < 0.7
    ) {
      examples.push({
        actual: entry.domainInference.domain,
        expected: "general (low confidence)",
        family: entry.tier,
      });
    }
  }
  return examples;
}

/**
 * Collect fallback-glob examples, redacted to family (tier) only.
 */
function collectFallbackExamples(entries: EvalEntry[]): { family: string; reason: string }[] {
  const examples: { family: string; reason: string }[] = [];
  for (const entry of entries) {
    if (entry.graphStats?.usedFallbackGlob) {
      examples.push({
        family: entry.tier,
        reason: "used fallback glob resolution",
      });
    }
  }
  return examples;
}

/**
 * Collect undersampled examples, redacted to family (tier) only.
 */
function collectUndersampledExamples(
  entries: EvalEntry[],
): { family: string; reasons: string[] }[] {
  const examples: { family: string; reasons: string[] }[] = [];
  for (const entry of entries) {
    if (entry.coverageDiagnostics?.undersampled) {
      examples.push({
        family: entry.tier,
        reasons: entry.coverageDiagnostics.undersampledReasons ?? [],
      });
    }
  }
  return examples;
}

// ─── Main ─────────────────────────────────────────────────────────────────

function main() {
  console.log("=== typegrade Eval Judge ===\n");

  const snapshot = findLatestEvalSnapshot();
  if (!snapshot) {
    console.error("No eval results found. Run 'pnpm benchmark:eval' first.");
    process.exit(1);
  }

  console.log(`Evaluating ${snapshot.entries.length} packages from ${snapshot.corpusSplit} split`);
  if (snapshot.seed !== undefined) {
    console.log(`Seed: ${snapshot.seed}`);
  }
  console.log();

  // Validate manifest hash for pool-sampled artifacts
  const expectedPoolHash = computeEvalPoolManifestHash();
  const validation = validateSnapshotManifest(snapshot, expectedPoolHash);
  if (!validation.valid) {
    console.error(`Manifest validation FAILED: ${validation.reason}`);
    console.error(
      "The eval artifact was produced from a different manifest than the current eval pool.",
    );
    console.error("Re-run the eval benchmark with the current manifest.");
    process.exit(1);
  }

  // Compute unlabeled metrics (includes trainEvalDrift when train data exists)
  const metrics = computeUnlabeledMetrics(snapshot.entries);

  // Compute seed robustness across all available snapshots
  // Also validate each snapshot against the current manifest
  const allSnapshots = loadAllEvalSnapshots();
  const validSnapshots = allSnapshots.filter((snap) => {
    const check = validateSnapshotManifest(snap, expectedPoolHash);
    if (!check.valid) {
      console.log(`Skipping stale snapshot (${snap.timestamp}): ${check.reason}`);
    }
    return check.valid;
  });
  const seedInstabilityRate = computeSeedRobustness(validSnapshots);
  if (seedInstabilityRate !== undefined) {
    metrics.seedInstabilityRate = seedInstabilityRate;
  }

  // Compute multi-seed aggregate metrics
  const multiSeedMetrics = computeMultiSeedMetrics(validSnapshots);

  // Compute score statistics for summary
  const consumerApis = snapshot.entries.map((en) => en.consumerApi ?? 0).filter((sc) => sc > 0);
  const agentReadinesses = snapshot.entries
    .map((en) => en.agentReadiness ?? 0)
    .filter((sc) => sc > 0);
  const typeSafeties = snapshot.entries.map((en) => en.typeSafety ?? 0).filter((sc) => sc > 0);

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((aa, bb) => aa - bb);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  const stdDev = (arr: number[]) => {
    if (arr.length < 2) {
      return 0;
    }
    const mean = arr.reduce((aa, bb) => aa + bb, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  };

  // Build gates (core + multi-seed when available)
  const coreGates = buildEvalGates(metrics, snapshot.entries.length);
  const multiSeedGates = multiSeedMetrics ? buildMultiSeedGates(multiSeedMetrics) : [];
  const gates = [...coreGates, ...multiSeedGates];
  const allGatesPassed = gates.every((gg) => gg.passed);

  // Compute confidence calibration
  const calibration = computeConfidenceCalibration(snapshot.entries);

  // Print results
  printMetrics(metrics);
  if (multiSeedMetrics) {
    printMultiSeedMetrics(multiSeedMetrics);
  }
  printCalibration(calibration);
  printGates(gates);

  // Compute baseline comparison
  const summaryMetrics: RedactedEvalSummary["metrics"] = {
    coverageConfidenceViolations: metrics.coverageConfidenceViolations,
    domainOverreachRate: metrics.domainOverreachRate,
    fallbackGlobRate: metrics.fallbackGlobRate,
    medianAgentReadiness: median(agentReadinesses),
    medianConsumerApi: median(consumerApis),
    medianTypeSafety: median(typeSafeties),
    paretoViolationCount: metrics.paretoViolationCount,
    scenarioOverreachRate: metrics.scenarioOverreachRate,
    scoreCompressionRate: metrics.scoreCompressionRate,
    scoreStdDev: Math.round(stdDev(consumerApis) * 10) / 10,
    ...(metrics.seedInstabilityRate !== undefined && {
      seedInstabilityRate: metrics.seedInstabilityRate,
    }),
    ...(metrics.trainEvalDrift !== undefined && {
      trainEvalDrift: metrics.trainEvalDrift,
    }),
    ...(metrics.compactRate !== undefined && {
      compactRate: metrics.compactRate,
    }),
    ...(metrics.confidenceModerationRate !== undefined && {
      confidenceModerationRate: metrics.confidenceModerationRate,
    }),
    undersampledRate: metrics.undersampledRate,
  };

  const baselineComparison = compareWithBaseline(summaryMetrics);
  if (baselineComparison) {
    printBaselineComparison(baselineComparison);
  }

  // Compute family metrics and examples
  const familyMetrics = computeFamilyMetrics(snapshot.entries);
  const normalizedFamilyVariance = computeNormalizedFamilyVariance(familyMetrics);
  const wrongSpecificExamples = collectWrongSpecificExamples(snapshot.entries);
  const fallbackExamples = collectFallbackExamples(snapshot.entries);
  const undersampledExamples = collectUndersampledExamples(snapshot.entries);

  // Build redacted summary (no package names, no per-package scores)
  const summary: RedactedEvalSummary = {
    allGatesPassed,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    gates,
    metrics: summaryMetrics,
    packageCount: snapshot.entries.length,
    seed: snapshot.seed,
    split: snapshot.corpusSplit as "eval-fixed" | "eval-pool",
    timestamp: new Date().toISOString(),
  };

  // Include family metrics
  if (familyMetrics.length > 0) {
    summary.familyMetrics = familyMetrics;
    summary.normalizedFamilyVariance = normalizedFamilyVariance;
  }

  // Include redacted examples
  if (wrongSpecificExamples.length > 0) {
    summary.wrongSpecificExamples = wrongSpecificExamples;
  }
  if (fallbackExamples.length > 0) {
    summary.fallbackExamples = fallbackExamples;
  }
  if (undersampledExamples.length > 0) {
    summary.undersampledExamples = undersampledExamples;
  }

  // Include install failures from snapshot (redacted to family only)
  if (snapshot.installFailures && snapshot.installFailures.length > 0) {
    summary.installabilityFailures = snapshot.installFailures.map((ff) => ({
      error: ff.error,
      family: ff.tier,
    }));
  }

  // Include confidence calibration
  if (calibration.length > 0) {
    summary.calibration = calibration;
  }

  // Include multi-seed metrics if available
  if (multiSeedMetrics) {
    summary.multiSeedMetrics = multiSeedMetrics;
  }

  // Include baseline comparison if available
  if (baselineComparison) {
    summary.baselineComparison = {
      baselineTimestamp: baselineComparison.baselineTimestamp,
      improvements: baselineComparison.improvements,
      regressions: baselineComparison.regressions,
    };
  }

  // Write redacted summary
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(join(outputDir, "eval-summary.json"), JSON.stringify(summary, null, 2));
  console.log("\nRedacted eval summary saved to benchmarks-output/eval-summary.json");

  // Audit mode: print per-package details (NOT visible to builder agent by default)
  if (auditMode) {
    printAuditDetails(snapshot);
  }

  if (!allGatesPassed) {
    console.log("\nEval judge gate failures are non-blocking (report-only mode).");
  }
}

main();
