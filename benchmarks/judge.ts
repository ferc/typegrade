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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParetoViolation,
  RawBenchmarkSnapshotV2,
  RedactedEvalSummary,
  UnlabeledEvalMetrics,
} from "./types.js";

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
  } | null;
  dimensions: { key: string; score: number | null; confidence: number | null }[];
}

interface EvalSnapshot {
  timestamp: string;
  corpusSplit: string;
  seed?: number;
  entries: EvalEntry[];
}

function findLatestEvalSnapshot(): EvalSnapshot | null {
  const evalDir = join(import.meta.dirname, "..", "benchmarks-output", "eval-raw");
  if (!existsSync(evalDir)) {
    return null;
  }

  const files = readdirSync(evalDir).filter((f) => f.endsWith(".json")).sort();
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

  const files = readdirSync(evalDir).filter((f) => f.endsWith(".json")).sort();
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

  const files = readdirSync(resultsDir).filter((fl) => fl.endsWith(".json")).sort();
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
  const undersampledCount = entries.filter((e) => e.coverageDiagnostics?.undersampled).length;
  const undersampledRate = undersampledCount / total;

  // Fallback glob rate
  const fallbackCount = entries.filter((e) => e.graphStats?.usedFallbackGlob).length;
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
  const scores = entries.map((e) => e.consumerApi ?? 0).filter((s) => s > 0);
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

  // Train-vs-eval distribution drift
  const driftValue = computeTrainEvalDrift(entries);

  const result: UnlabeledEvalMetrics = {
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

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;

      if (a.consumerApi === null || b.consumerApi === null) {
        continue;
      }

      // Check if A dominates B on core dimensions
      const aDominates = checkDominance(a, b, coreDimensions);
      const bDominates = checkDominance(b, a, coreDimensions);

      if (aDominates.dominates && a.consumerApi < b.consumerApi) {
        violations.push({
          dominant: a.name,
          dominantComposite: a.consumerApi,
          dominantDimensions: aDominates.dimensions,
          dominated: b.name,
          dominatedComposite: b.consumerApi,
        });
      }

      if (bDominates.dominates && b.consumerApi < a.consumerApi) {
        violations.push({
          dominant: b.name,
          dominantComposite: b.consumerApi,
          dominantDimensions: bDominates.dimensions,
          dominated: a.name,
          dominatedComposite: a.consumerApi,
        });
      }
    }
  }

  return violations;
}

function checkDominance(
  a: EvalEntry,
  b: EvalEntry,
  dimensions: string[],
): { dominates: boolean; dimensions: string[] } {
  const dominantDims: string[] = [];
  let anyWorse = false;

  for (const dim of dimensions) {
    const aScore = a.dimensions.find((d) => d.key === dim)?.score ?? null;
    const bScore = b.dimensions.find((d) => d.key === dim)?.score ?? null;
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

  const sorted = scores.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  // Count how many scores are within +/-5 of the median
  const compressed = scores.filter((s) => Math.abs(s - median) <= 5).length;
  return compressed / scores.length;
}

function buildEvalGates(metrics: UnlabeledEvalMetrics): { gate: string; passed: boolean; detail: string }[] {
  return [
    {
      detail: `${(metrics.undersampledRate * 100).toFixed(1)}%`,
      gate: "eval-undersampled-rate-<30%",
      passed: metrics.undersampledRate < 0.3,
    },
    {
      detail: `${(metrics.fallbackGlobRate * 100).toFixed(1)}%`,
      gate: "eval-fallback-rate-=0",
      passed: metrics.fallbackGlobRate === 0,
    },
    {
      detail: `${metrics.coverageConfidenceViolations} violation(s)`,
      gate: "eval-coverage-confidence-<5",
      passed: metrics.coverageConfidenceViolations < 5,
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
      detail: metrics.seedInstabilityRate !== undefined
        ? `${(metrics.seedInstabilityRate * 100).toFixed(1)}%`
        : "n/a (insufficient seeds)",
      gate: "eval-seed-instability-<10%",
      passed: metrics.seedInstabilityRate === undefined || metrics.seedInstabilityRate < 0.10,
    },
    {
      detail: `${(metrics.domainOverreachRate * 100).toFixed(1)}%`,
      gate: "eval-domain-overreach-<15%",
      passed: metrics.domainOverreachRate < 0.15,
    },
    {
      detail: `${(metrics.scenarioOverreachRate * 100).toFixed(1)}%`,
      gate: "eval-scenario-overreach-=0",
      passed: metrics.scenarioOverreachRate === 0,
    },
    {
      detail: metrics.trainEvalDrift !== undefined
        ? `${metrics.trainEvalDrift.toFixed(3)}`
        : "n/a (no train data)",
      gate: "eval-train-drift-<2.0",
      passed: metrics.trainEvalDrift === undefined || metrics.trainEvalDrift < 2.0,
    },
  ];
}

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

  // Compute unlabeled metrics (includes trainEvalDrift when train data exists)
  const metrics = computeUnlabeledMetrics(snapshot.entries);

  // Compute seed robustness across all available snapshots
  const allSnapshots = loadAllEvalSnapshots();
  const seedInstabilityRate = computeSeedRobustness(allSnapshots);
  if (seedInstabilityRate !== undefined) {
    metrics.seedInstabilityRate = seedInstabilityRate;
  }

  // Compute score statistics for summary
  const consumerApis = snapshot.entries.map((e) => e.consumerApi ?? 0).filter((s) => s > 0);
  const agentReadinesses = snapshot.entries.map((e) => e.agentReadiness ?? 0).filter((s) => s > 0);
  const typeSafeties = snapshot.entries.map((e) => e.typeSafety ?? 0).filter((s) => s > 0);

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  const stdDev = (arr: number[]) => {
    if (arr.length < 2) {
      return 0;
    }
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  };

  // Build gates
  const gates = buildEvalGates(metrics);
  const allGatesPassed = gates.every((g) => g.passed);

  // Print results
  console.log("=== Eval Metrics ===\n");
  console.log(`  Undersampled rate:          ${(metrics.undersampledRate * 100).toFixed(1)}%`);
  console.log(`  Fallback glob rate:         ${(metrics.fallbackGlobRate * 100).toFixed(1)}%`);
  console.log(`  Coverage-confidence viols:  ${metrics.coverageConfidenceViolations}`);
  console.log(`  Pareto violations:          ${metrics.paretoViolationCount}`);
  console.log(`  Score compression:          ${(metrics.scoreCompressionRate * 100).toFixed(1)}%`);
  console.log(`  Seed instability rate:      ${metrics.seedInstabilityRate !== undefined ? `${(metrics.seedInstabilityRate * 100).toFixed(1)}%` : "n/a (insufficient seeds)"}`);
  console.log(`  Domain overreach rate:      ${(metrics.domainOverreachRate * 100).toFixed(1)}%`);
  console.log(`  Scenario overreach rate:    ${(metrics.scenarioOverreachRate * 100).toFixed(1)}%`);
  console.log(`  Train-eval drift:           ${metrics.trainEvalDrift !== undefined ? metrics.trainEvalDrift.toFixed(3) : "n/a (no train data)"}`);

  console.log("\n=== Eval Gates ===\n");
  for (const gate of gates) {
    const icon = gate.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${gate.gate.padEnd(35)} ${gate.detail}`);
  }

  const passedCount = gates.filter((g) => g.passed).length;
  console.log(`\n  ${passedCount}/${gates.length} eval gates passed`);

  // Build redacted summary (no package names, no per-package scores)
  const summary: RedactedEvalSummary = {
    allGatesPassed,
    gates,
    metrics: {
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
      undersampledRate: metrics.undersampledRate,
    },
    packageCount: snapshot.entries.length,
    seed: snapshot.seed,
    split: snapshot.corpusSplit as "eval-fixed" | "eval-pool",
    timestamp: new Date().toISOString(),
  };

  // Write redacted summary
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(join(outputDir, "eval-summary.json"), JSON.stringify(summary, null, 2));
  console.log("\nRedacted eval summary saved to benchmarks-output/eval-summary.json");

  // Audit mode: print per-package details (NOT visible to builder agent by default)
  if (auditMode) {
    console.log("\n=== AUDIT: Per-Package Details (not for builder consumption) ===\n");
    const sorted = [...snapshot.entries].sort(
      (a, b) => (b.consumerApi ?? 0) - (a.consumerApi ?? 0),
    );
    console.log(`${"Package".padEnd(30)}${"ConsumerApi".padEnd(14)}${"AgentReady".padEnd(14)}${"TypeSafety".padEnd(14)}${"Domain".padEnd(14)}Undersampled`);
    console.log("-".repeat(100));
    for (const e of sorted) {
      const domain = e.domainInference?.domain ?? "n/a";
      const undersampled = e.coverageDiagnostics?.undersampled ? "YES" : "no";
      console.log(
        `${e.name.padEnd(30)}${String(e.consumerApi ?? "n/a").padEnd(14)}${String(e.agentReadiness ?? "n/a").padEnd(14)}${String(e.typeSafety ?? "n/a").padEnd(14)}${domain.padEnd(14)}${undersampled}`,
      );
    }

    // Print Pareto violations
    const violations = detectParetoViolations(snapshot.entries);
    if (violations.length > 0) {
      console.log("\n=== AUDIT: Pareto Violations ===\n");
      for (const v of violations) {
        console.log(`  ${v.dominant} (${v.dominantComposite}) dominates ${v.dominated} (${v.dominatedComposite}) on [${v.dominantDimensions.join(", ")}] but ranks lower`);
      }
    }
  }

  if (!allGatesPassed) {
    process.exit(1);
  }
}

main();
