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
import type { ParetoViolation, RedactedEvalSummary, UnlabeledEvalMetrics } from "./types.js";

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
  if (!existsSync(evalDir)) return null;

  const files = readdirSync(evalDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) return null;

  const latestFile = files[files.length - 1]!;
  return JSON.parse(readFileSync(join(evalDir, latestFile), "utf8"));
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

  return {
    coverageConfidenceViolations,
    domainOverreachRate: Math.round(domainOverreachRate * 1000) / 1000,
    fallbackGlobRate: Math.round(fallbackGlobRate * 1000) / 1000,
    paretoViolationCount,
    scenarioOverreachRate: Math.round(scenarioOverreachRate * 1000) / 1000,
    scoreCompressionRate: Math.round(scoreCompressionRate * 1000) / 1000,
    undersampledRate: Math.round(undersampledRate * 1000) / 1000,
  };
}

function detectParetoViolations(entries: EvalEntry[]): ParetoViolation[] {
  const violations: ParetoViolation[] = [];
  const coreDimensions = ["apiSpecificity", "apiSafety", "semanticLift", "specializationPower"];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;

      if (a.consumerApi === null || b.consumerApi === null) continue;

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
    if (aScore === null || bScore === null) continue;

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
  if (scores.length < 3) return 0;

  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  // Count how many scores are within ±5 of the median
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
      detail: `${(metrics.domainOverreachRate * 100).toFixed(1)}%`,
      gate: "eval-domain-overreach-<15%",
      passed: metrics.domainOverreachRate < 0.15,
    },
    {
      detail: `${(metrics.scenarioOverreachRate * 100).toFixed(1)}%`,
      gate: "eval-scenario-overreach-=0",
      passed: metrics.scenarioOverreachRate === 0,
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

  // Compute unlabeled metrics
  const metrics = computeUnlabeledMetrics(snapshot.entries);

  // Compute score statistics for summary
  const consumerApis = snapshot.entries.map((e) => e.consumerApi ?? 0).filter((s) => s > 0);
  const agentReadinesses = snapshot.entries.map((e) => e.agentReadiness ?? 0).filter((s) => s > 0);
  const typeSafeties = snapshot.entries.map((e) => e.typeSafety ?? 0).filter((s) => s > 0);

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  const stdDev = (arr: number[]) => {
    if (arr.length < 2) return 0;
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
  console.log(`  Domain overreach rate:      ${(metrics.domainOverreachRate * 100).toFixed(1)}%`);
  console.log(`  Scenario overreach rate:    ${(metrics.scenarioOverreachRate * 100).toFixed(1)}%`);

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
      undersampledRate: metrics.undersampledRate,
    },
    packageCount: snapshot.entries.length,
    seed: snapshot.seed,
    split: snapshot.corpusSplit as "eval-fixed" | "eval-pool",
    timestamp: new Date().toISOString(),
  };

  // Write redacted summary
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

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
