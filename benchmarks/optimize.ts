#!/usr/bin/env tsx
/**
 * NSGA-II evolutionary weight optimizer — searches for improved weights using ONLY train data.
 *
 * Replaces pairwise perturbation with a multi-objective evolutionary search (NSGA-II style).
 * Optimizes weight vectors for all three composites (consumerApi, agentReadiness, typeSafety)
 * simultaneously as a single genome.
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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { CompositeKey } from "../src/types.js";
import { DIMENSION_CONFIGS } from "../src/constants.js";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const COMPOSITE_KEYS: CompositeKey[] = ["consumerApi", "agentReadiness", "typeSafety"];
const POPULATION_SIZE = 100;
const GENERATIONS = 50;
const MUTATION_SIGMA = 0.02;
const WEIGHT_MIN = 0.01;
const WEIGHT_MAX = 0.5;
const TOURNAMENT_SIZE = 3;
const ELITISM_FRACTION = 0.1;
const CONCORDANCE_FLOOR = 0.9;
const NUM_OBJECTIVES = 4;
const PRNG_SEED = 42;

// ─── Types ───────────────────────────────────────────────────────────────────

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

/** A genome encodes weights for all three composites plus threshold parameters */
interface Genome {
  /** Weight vectors per composite */
  weights: Record<CompositeKey, Record<string, number>>;
  /** Compact position threshold (minimum measured positions for compact classification) */
  compactPositionThreshold: number;
  /** Compact declaration threshold (minimum measured declarations for compact classification) */
  compactDeclarationThreshold: number;
  /** Domain ambiguity threshold (minimum gap between winner and runner-up) */
  domainAmbiguityThreshold: number;
  /** Scenario emission threshold (minimum domain confidence to run scenario packs) */
  scenarioEmissionThreshold: number;
}

/** Fitness vector for NSGA-II (all objectives to be minimized) */
interface FitnessVector {
  /** 1 - concordance rate on consumerApi */
  obj0: number;
  /** 1 - concordance rate on agentReadiness */
  obj1: number;
  /** 1 - concordance rate on typeSafety */
  obj2: number;
  /** Total diagnostic failures */
  obj3: number;
}

interface Individual {
  genome: Genome;
  fitness: FitnessVector;
  rank: number;
  crowdingDistance: number;
  /** Whether hard constraints are satisfied */
  feasible: boolean;
  /** Per-composite concordance results */
  concordance: Record<CompositeKey, ConcordanceResult>;
}

interface GenerationStats {
  generation: number;
  feasibleCount: number;
  bestConcordance: Record<CompositeKey, number>;
  paretoFrontSize: number;
  totalDiagFailures: number;
}

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32) for reproducible search */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    let tt = (state += 0x6D_2B_79_F5);
    tt = Math.imul(tt ^ (tt >>> 15), tt | 1);
    tt ^= tt + Math.imul(tt ^ (tt >>> 7), tt | 61);
    // Convert to unsigned 32-bit integer before dividing
    const unsigned = (tt ^ (tt >>> 14)) >>> 0; // eslint-disable-line unicorn/prefer-math-trunc
    return unsigned / 4_294_967_296;
  };
}

// ─── Weight Extraction ───────────────────────────────────────────────────────

/** Extract current weights for a given composite from DIMENSION_CONFIGS */
function extractWeights(composite: CompositeKey): Record<string, number> {
  const result: Record<string, number> = {};
  for (const cfg of DIMENSION_CONFIGS) {
    const wt = cfg.weights[composite];
    if (wt) {
      result[cfg.key] = wt;
    }
  }
  return result;
}

// ─── Snapshot Loading ────────────────────────────────────────────────────────

function findLatestTrainSnapshot(): BenchmarkSnapshot | null {
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    return null;
  }

  const files = readdirSync(resultsDir).filter((ff) => ff.endsWith(".json")).toSorted();
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

// ─── Score Computation ───────────────────────────────────────────────────────

function getDimensionScore(entry: ResultEntry, dimensionKey: string): number | null {
  if (!entry.dimensions) {
    return null;
  }
  const dim = entry.dimensions.find((dd) => dd.key === dimensionKey);
  return dim?.score ?? null;
}

/** Recompute a composite score from dimension scores and a weight vector */
function recomputeComposite(entry: ResultEntry, weights: Record<string, number>): number | null {
  if (!entry.dimensions) {
    return null;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [dimKey, weight] of Object.entries(weights)) {
    const dimScore = getDimensionScore(entry, dimKey);
    if (dimScore !== null) {
      weightedSum += dimScore * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) {
    return null;
  }
  return Math.round(weightedSum / totalWeight);
}

// ─── Concordance Evaluation ──────────────────────────────────────────────────

/** Evaluate concordance for a single composite's assertions */
function evaluateConcordance(params: {
  entries: ResultEntry[];
  composite: CompositeKey;
  weights: Record<string, number>;
}): ConcordanceResult {
  const { entries, composite, weights } = params;
  const entryMap = new Map<string, ResultEntry>();
  for (const en of entries) {
    entryMap.set(en.name, en);
  }

  let concordant = 0;
  let total = 0;
  let mustPassFailures = 0;
  let hardDiagFailures = 0;

  for (const assertion of PAIRWISE_ASSERTIONS) {
    if (assertion.class === "ambiguous") {
      continue;
    }
    if (assertion.composite !== composite) {
      continue;
    }

    const higherEntry = entryMap.get(assertion.higher);
    const lowerEntry = entryMap.get(assertion.lower);
    if (!higherEntry || !lowerEntry) {
      continue;
    }

    const higherScore = recomputeComposite(higherEntry, weights);
    const lowerScore = recomputeComposite(lowerEntry, weights);
    if (higherScore === null || lowerScore === null) {
      continue;
    }

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

// ─── Genome Operations ──────────────────────────────────────────────────────

/** Build the baseline genome from current DIMENSION_CONFIGS */
function buildBaselineGenome(): Genome {
  const weights: Record<string, Record<string, number>> = {};
  for (const composite of COMPOSITE_KEYS) {
    weights[composite] = extractWeights(composite);
  }
  return {
    compactDeclarationThreshold: 5,
    compactPositionThreshold: 10,
    domainAmbiguityThreshold: 0.15,
    scenarioEmissionThreshold: 0.7,
    weights: weights as Record<CompositeKey, Record<string, number>>,
  };
}

/** Normalize weight vector so values sum to approximately 1.0 */
function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights);
  const total = Object.values(weights).reduce((aa, bb) => aa + bb, 0);
  if (total === 0) {
    return { ...weights };
  }
  const normalized: Record<string, number> = {};
  for (const kk of keys) {
    normalized[kk] = Math.round((weights[kk]! / total) * 100) / 100;
  }
  return normalized;
}

/** Clamp a value to the weight range */
function clampWeight(val: number): number {
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, val));
}

/** Generate a Gaussian random number using Box-Muller transform */
function gaussianRandom(rng: () => number, sigma: number): number {
  const u1 = rng();
  const u2 = rng();
  // Avoid log(0)
  const safeU1 = Math.max(1e-10, u1);
  return Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2) * sigma;
}

/** Mutate a genome with Gaussian perturbation */
function mutateGenome(genome: Genome, rng: () => number): Genome {
  const mutated: Genome = {
    compactDeclarationThreshold: genome.compactDeclarationThreshold,
    compactPositionThreshold: genome.compactPositionThreshold,
    domainAmbiguityThreshold: genome.domainAmbiguityThreshold,
    scenarioEmissionThreshold: genome.scenarioEmissionThreshold,
    weights: {} as Record<CompositeKey, Record<string, number>>,
  };

  // Mutate weights for each composite
  for (const composite of COMPOSITE_KEYS) {
    const original = genome.weights[composite];
    const perturbed: Record<string, number> = {};
    for (const [dimKey, val] of Object.entries(original)) {
      perturbed[dimKey] = clampWeight(val + gaussianRandom(rng, MUTATION_SIGMA));
    }
    mutated.weights[composite] = normalizeWeights(perturbed);
  }

  // Mutate thresholds with small perturbations
  mutated.compactPositionThreshold = Math.max(
    1,
    Math.round(genome.compactPositionThreshold + gaussianRandom(rng, 2)),
  );
  mutated.compactDeclarationThreshold = Math.max(
    1,
    Math.round(genome.compactDeclarationThreshold + gaussianRandom(rng, 1)),
  );
  mutated.domainAmbiguityThreshold = Math.max(
    0.05,
    Math.min(0.5, genome.domainAmbiguityThreshold + gaussianRandom(rng, 0.03)),
  );
  mutated.scenarioEmissionThreshold = Math.max(
    0.3,
    Math.min(0.95, genome.scenarioEmissionThreshold + gaussianRandom(rng, 0.05)),
  );

  return mutated;
}

/** Uniform crossover between two genomes */
function crossoverGenomes(params: {
  parentA: Genome;
  parentB: Genome;
  rng: () => number;
}): Genome {
  const { parentA, parentB, rng } = params;
  const child: Genome = {
    compactDeclarationThreshold: rng() < 0.5
      ? parentA.compactDeclarationThreshold
      : parentB.compactDeclarationThreshold,
    compactPositionThreshold: rng() < 0.5
      ? parentA.compactPositionThreshold
      : parentB.compactPositionThreshold,
    domainAmbiguityThreshold: rng() < 0.5
      ? parentA.domainAmbiguityThreshold
      : parentB.domainAmbiguityThreshold,
    scenarioEmissionThreshold: rng() < 0.5
      ? parentA.scenarioEmissionThreshold
      : parentB.scenarioEmissionThreshold,
    weights: {} as Record<CompositeKey, Record<string, number>>,
  };

  // Uniform crossover on weight vectors
  for (const composite of COMPOSITE_KEYS) {
    const weightsA = parentA.weights[composite];
    const weightsB = parentB.weights[composite];
    const childWeights: Record<string, number> = {};

    for (const dimKey of Object.keys(weightsA)) {
      childWeights[dimKey] = rng() < 0.5
        ? (weightsA[dimKey] ?? 0)
        : (weightsB[dimKey] ?? 0);
    }
    child.weights[composite] = normalizeWeights(childWeights);
  }

  return child;
}

// ─── Fitness Evaluation ─────────────────────────────────────────────────────

/** Evaluate a genome's fitness against train data */
function evaluateGenome(genome: Genome, entries: ResultEntry[]): Individual {
  const concordance: Record<string, ConcordanceResult> = {};
  let totalDiagFailures = 0;
  let totalMustPassFailures = 0;
  let totalHardDiagFailures = 0;

  for (const composite of COMPOSITE_KEYS) {
    const result = evaluateConcordance({
      composite,
      entries,
      weights: genome.weights[composite],
    });
    concordance[composite] = result;
    totalDiagFailures += (result.total - result.concordant);
    totalMustPassFailures += result.mustPassFailures;
    totalHardDiagFailures += result.hardDiagFailures;
  }

  const conApi = concordance["consumerApi"]!;
  const conAgent = concordance["agentReadiness"]!;
  const conSafety = concordance["typeSafety"]!;

  const fitness: FitnessVector = {
    obj0: 1 - conApi.rate,
    obj1: 1 - conAgent.rate,
    obj2: 1 - conSafety.rate,
    obj3: totalDiagFailures,
  };

  // Hard constraints: no must-pass or hard-diag failures, 90%+ concordance on each
  const feasible =
    totalMustPassFailures === 0 &&
    totalHardDiagFailures === 0 &&
    conApi.rate >= CONCORDANCE_FLOOR &&
    conAgent.rate >= CONCORDANCE_FLOOR &&
    conSafety.rate >= CONCORDANCE_FLOOR;

  return {
    concordance: concordance as Record<CompositeKey, ConcordanceResult>,
    crowdingDistance: 0,
    feasible,
    fitness,
    genome,
    rank: 0,
  };
}

// ─── NSGA-II Mechanics ──────────────────────────────────────────────────────

/** Check if individual A dominates individual B (all objectives <=, at least one <) */
function dominates(indA: Individual, indB: Individual): boolean {
  const fitA = indA.fitness;
  const fitB = indB.fitness;
  const objsA = [fitA.obj0, fitA.obj1, fitA.obj2, fitA.obj3];
  const objsB = [fitB.obj0, fitB.obj1, fitB.obj2, fitB.obj3];

  let atLeastOneBetter = false;
  for (let idx = 0; idx < NUM_OBJECTIVES; idx++) {
    if (objsA[idx]! > objsB[idx]!) {
      return false;
    }
    if (objsA[idx]! < objsB[idx]!) {
      atLeastOneBetter = true;
    }
  }
  return atLeastOneBetter;
}

/** Non-dominated sorting into Pareto fronts */
function nonDominatedSort(population: Individual[]): Individual[][] {
  const popSize = population.length;
  const dominationCount = Array.from<number>({ length: popSize }).fill(0);
  const dominatedSet: number[][] = Array.from({ length: popSize }, () => []);
  const fronts: Individual[][] = [];

  // Compute domination relationships
  for (let pp = 0; pp < popSize; pp++) {
    for (let qq = pp + 1; qq < popSize; qq++) {
      const indP = population[pp]!;
      const indQ = population[qq]!;

      // Feasible individuals always dominate infeasible ones
      if (indP.feasible && !indQ.feasible) {
        dominatedSet[pp]!.push(qq);
        dominationCount[qq]!++;
      } else if (!indP.feasible && indQ.feasible) {
        dominatedSet[qq]!.push(pp);
        dominationCount[pp]!++;
      } else if (dominates(indP, indQ)) {
        dominatedSet[pp]!.push(qq);
        dominationCount[qq]!++;
      } else if (dominates(indQ, indP)) {
        dominatedSet[qq]!.push(pp);
        dominationCount[pp]!++;
      }
    }
  }

  // Build first front
  let currentFront: number[] = [];
  for (let idx = 0; idx < popSize; idx++) {
    if (dominationCount[idx] === 0) {
      currentFront.push(idx);
    }
  }

  // Iterate through fronts
  while (currentFront.length > 0) {
    const front: Individual[] = currentFront.map((idx) => population[idx]!);
    fronts.push(front);

    const nextFront: number[] = [];
    for (const pp of currentFront) {
      for (const qq of dominatedSet[pp]!) {
        dominationCount[qq]!--;
        if (dominationCount[qq] === 0) {
          nextFront.push(qq);
        }
      }
    }
    currentFront = nextFront;
  }

  return fronts;
}

/** Compute crowding distance for individuals within a single front */
function computeCrowdingDistance(front: Individual[]): void {
  const frontSize = front.length;
  if (frontSize <= 2) {
    for (const ind of front) {
      ind.crowdingDistance = Infinity;
    }
    return;
  }

  // Reset crowding distances
  for (const ind of front) {
    ind.crowdingDistance = 0;
  }

  // For each objective, sort and compute distance contributions
  const objectiveAccessors = [
    (ind: Individual) => ind.fitness.obj0,
    (ind: Individual) => ind.fitness.obj1,
    (ind: Individual) => ind.fitness.obj2,
    (ind: Individual) => ind.fitness.obj3,
  ];

  for (const accessor of objectiveAccessors) {
    // Sort by this objective
    const sorted = [...front].toSorted((aa, bb) => accessor(aa) - accessor(bb));
    const minVal = accessor(sorted[0]!);
    const maxVal = accessor(sorted[frontSize - 1]!);
    const range = maxVal - minVal;

    // Boundary individuals get infinite distance
    sorted[0]!.crowdingDistance = Infinity;
    sorted[frontSize - 1]!.crowdingDistance = Infinity;

    if (range > 0) {
      for (let idx = 1; idx < frontSize - 1; idx++) {
        const prev = accessor(sorted[idx - 1]!);
        const next = accessor(sorted[idx + 1]!);
        sorted[idx]!.crowdingDistance += (next - prev) / range;
      }
    }
  }
}

/** Tournament selection: pick best by (rank, crowding distance) */
function tournamentSelect(population: Individual[], rng: () => number): Individual {
  let best: Individual | null = null;

  for (let tt = 0; tt < TOURNAMENT_SIZE; tt++) {
    const idx = Math.floor(rng() * population.length);
    const candidate = population[idx]!;

    if (best === null) {
      best = candidate;
    } else if (candidate.rank < best.rank) {
      best = candidate;
    } else if (candidate.rank === best.rank && candidate.crowdingDistance > best.crowdingDistance) {
      best = candidate;
    }
  }

  return best!;
}

// ─── Population Initialization ──────────────────────────────────────────────

/** Create initial population by perturbing the baseline genome */
function initializePopulation(params: {
  baseline: Genome;
  rng: () => number;
  entries: ResultEntry[];
}): Individual[] {
  const { baseline, rng, entries } = params;
  // First individual is always the baseline
  const population: Individual[] = [evaluateGenome(baseline, entries)];

  // Remaining individuals are random mutations from baseline
  for (let idx = 1; idx < POPULATION_SIZE; idx++) {
    const mutated = mutateGenome(baseline, rng);
    population.push(evaluateGenome(mutated, entries));
  }

  return population;
}

// ─── Main Evolutionary Loop ─────────────────────────────────────────────────

/** Run one generation of NSGA-II and return the new population */
function evolveGeneration(params: {
  population: Individual[];
  rng: () => number;
  entries: ResultEntry[];
}): Individual[] {
  const { population, rng, entries } = params;
  const eliteCount = Math.ceil(POPULATION_SIZE * ELITISM_FRACTION);

  // Non-dominated sorting
  const fronts = nonDominatedSort(population);
  let rankVal = 0;
  for (const front of fronts) {
    computeCrowdingDistance(front);
    for (const ind of front) {
      ind.rank = rankVal;
    }
    rankVal++;
  }

  // Collect elites from best fronts
  const elites: Individual[] = [];
  for (const front of fronts) {
    if (elites.length >= eliteCount) {
      break;
    }
    // Sort front by crowding distance (descending) to prefer diverse individuals
    const sortedFront = [...front].toSorted((aa, bb) => bb.crowdingDistance - aa.crowdingDistance);
    for (const ind of sortedFront) {
      if (elites.length >= eliteCount) {
        break;
      }
      elites.push(ind);
    }
  }

  // Generate offspring via selection, crossover, and mutation
  const offspring: Individual[] = [...elites];

  while (offspring.length < POPULATION_SIZE) {
    const parentA = tournamentSelect(population, rng);
    const parentB = tournamentSelect(population, rng);

    let childGenome = crossoverGenomes({ parentA: parentA.genome, parentB: parentB.genome, rng });
    childGenome = mutateGenome(childGenome, rng);

    offspring.push(evaluateGenome(childGenome, entries));
  }

  return offspring.slice(0, POPULATION_SIZE);
}

/** Collect generation statistics */
function collectGenerationStats(population: Individual[], generation: number): GenerationStats {
  const feasiblePop = population.filter((ind) => ind.feasible);
  const fronts = nonDominatedSort(population);
  const paretoFrontSize = fronts.length > 0 ? fronts[0]!.length : 0;

  const bestConcordance: Record<string, number> = {};
  for (const composite of COMPOSITE_KEYS) {
    let bestRate = 0;
    for (const ind of population) {
      const rate = ind.concordance[composite]?.rate ?? 0;
      if (rate > bestRate) {
        bestRate = rate;
      }
    }
    bestConcordance[composite] = Math.round(bestRate * 1000) / 1000;
  }

  // Sum diagnostic failures across the best feasible individual
  let totalDiagFailures = Infinity;
  for (const ind of feasiblePop) {
    const failures = ind.fitness.obj3;
    if (failures < totalDiagFailures) {
      totalDiagFailures = failures;
    }
  }
  if (!isFinite(totalDiagFailures)) {
    totalDiagFailures = -1;
  }

  return {
    bestConcordance: bestConcordance as Record<CompositeKey, number>,
    feasibleCount: feasiblePop.length,
    generation,
    paretoFrontSize,
    totalDiagFailures,
  };
}

// ─── Output Formatting ──────────────────────────────────────────────────────

/** Find the best individual for a specific objective */
function bestForObjective(population: Individual[], objIndex: number): Individual | null {
  const feasible = population.filter((ind) => ind.feasible);
  if (feasible.length === 0) {
    return null;
  }

  const accessor = (ind: Individual): number => {
    const fit = ind.fitness;
    if (objIndex === 0) {
      return fit.obj0;
    }
    if (objIndex === 1) {
      return fit.obj1;
    }
    if (objIndex === 2) {
      return fit.obj2;
    }
    return fit.obj3;
  };

  let best = feasible[0]!;
  for (let idx = 1; idx < feasible.length; idx++) {
    if (accessor(feasible[idx]!) < accessor(best)) {
      best = feasible[idx]!;
    }
  }
  return best;
}

/** Get the overall best individual (minimize sum of normalized objectives) */
function overallBest(population: Individual[]): Individual | null {
  const feasible = population.filter((ind) => ind.feasible);
  if (feasible.length === 0) {
    return null;
  }

  // Score by sum of concordance-based objectives (obj0..obj2) + normalized diag failures
  const maxDiag = Math.max(1, ...feasible.map((ind) => ind.fitness.obj3));
  let best = feasible[0]!;
  let bestScore = Infinity;

  for (const ind of feasible) {
    const score = ind.fitness.obj0 + ind.fitness.obj1 + ind.fitness.obj2 + ind.fitness.obj3 / maxDiag;
    if (score < bestScore) {
      bestScore = score;
      best = ind;
    }
  }
  return best;
}

/** Print results for a composite */
function printCompositeResult(params: {
  composite: CompositeKey;
  baseWeights: Record<string, number>;
  bestWeights: Record<string, number>;
  baseline: ConcordanceResult;
  optimized: ConcordanceResult;
}): void {
  const { composite, baseWeights, bestWeights, baseline, optimized } = params;

  console.log(`--- ${composite} ---`);
  console.log(`  Assertions: ${baseline.total}`);
  console.log(
    `  Baseline: ${(baseline.rate * 100).toFixed(1)}% concordance, ` +
    `${baseline.mustPassFailures} must-pass fail, ${baseline.hardDiagFailures} hard-diag fail`,
  );

  const improved =
    optimized.mustPassFailures < baseline.mustPassFailures ||
    optimized.hardDiagFailures < baseline.hardDiagFailures ||
    optimized.rate > baseline.rate;

  if (improved) {
    console.log(
      `  Improved: ${(optimized.rate * 100).toFixed(1)}% concordance, ` +
      `${optimized.mustPassFailures} must-pass fail, ${optimized.hardDiagFailures} hard-diag fail`,
    );
    console.log("  Weight changes:");
    for (const [dim, weight] of Object.entries(bestWeights)) {
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

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("=== typegrade NSGA-II Evolutionary Optimizer (train-only) ===\n");

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

  const rng = mulberry32(PRNG_SEED);
  const baseline = buildBaselineGenome();
  const baselineIndividual = evaluateGenome(baseline, snapshot.entries);

  // Print baseline status
  console.log("Baseline concordance:");
  for (const composite of COMPOSITE_KEYS) {
    const cc = baselineIndividual.concordance[composite];
    console.log(
      `  ${composite}: ${(cc.rate * 100).toFixed(1)}% ` +
      `(${cc.concordant}/${cc.total}, ${cc.mustPassFailures} must-pass fail, ${cc.hardDiagFailures} hard-diag fail)`,
    );
  }
  console.log(`  Feasible: ${baselineIndividual.feasible ? "yes" : "no"}\n`);

  // Initialize population
  console.log(`Initializing population of ${POPULATION_SIZE}...`);
  let population = initializePopulation({ baseline, entries: snapshot.entries, rng });

  // Evolutionary loop
  const generationStats: GenerationStats[] = [];
  console.log(`Running ${GENERATIONS} generations...\n`);

  for (let gen = 0; gen < GENERATIONS; gen++) {
    population = evolveGeneration({ entries: snapshot.entries, population, rng });
    const stats = collectGenerationStats(population, gen);
    generationStats.push(stats);

    // Print progress every 10 generations
    if (gen % 10 === 0 || gen === GENERATIONS - 1) {
      const apiRate = stats.bestConcordance["consumerApi"] ?? 0;
      const agentRate = stats.bestConcordance["agentReadiness"] ?? 0;
      const safetyRate = stats.bestConcordance["typeSafety"] ?? 0;
      console.log(
        `  Gen ${String(gen).padStart(3)}: ` +
        `feasible=${String(stats.feasibleCount).padStart(3)} ` +
        `pareto=${String(stats.paretoFrontSize).padStart(3)} ` +
        `concordance=[${(apiRate * 100).toFixed(0)}%, ${(agentRate * 100).toFixed(0)}%, ${(safetyRate * 100).toFixed(0)}%] ` +
        `diagFail=${stats.totalDiagFailures}`,
      );
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────

  console.log("\n=== Optimization Results ===\n");

  // Find best individual overall
  const best = overallBest(population);
  if (!best) {
    console.log("No feasible solution found. Hard constraints may be too strict.");
    console.log("Consider relaxing concordance floor or checking train assertions.\n");
  }

  // Compare against baseline
  const baseWeightsMap: Record<string, Record<string, number>> = {};
  for (const composite of COMPOSITE_KEYS) {
    baseWeightsMap[composite] = extractWeights(composite);
  }

  // Print per-composite results
  for (const composite of COMPOSITE_KEYS) {
    const baseWeights = baseWeightsMap[composite]!;
    const baseResult = baselineIndividual.concordance[composite];
    const optResult = best?.concordance[composite] ?? baseResult;
    const optWeights = best?.genome.weights[composite] ?? baseWeights;

    printCompositeResult({
      baseWeights,
      baseline: baseResult,
      bestWeights: optWeights,
      composite,
      optimized: optResult,
    });
  }

  // Print threshold results
  if (best) {
    console.log("--- Thresholds ---");
    console.log(`  Compact position threshold:    ${best.genome.compactPositionThreshold} (baseline: 10)`);
    console.log(`  Compact declaration threshold: ${best.genome.compactDeclarationThreshold} (baseline: 5)`);
    console.log(`  Domain ambiguity threshold:    ${best.genome.domainAmbiguityThreshold.toFixed(3)} (baseline: 0.150)`);
    console.log(`  Scenario emission threshold:   ${best.genome.scenarioEmissionThreshold.toFixed(3)} (baseline: 0.700)`);
    console.log();
  }

  // Aggregate summary
  let totalMustPassBaseline = 0;
  let totalMustPassBest = 0;
  let totalHardDiagBaseline = 0;
  let totalHardDiagBest = 0;

  for (const composite of COMPOSITE_KEYS) {
    totalMustPassBaseline += baselineIndividual.concordance[composite].mustPassFailures;
    totalMustPassBest += (best?.concordance[composite].mustPassFailures ?? totalMustPassBaseline);
    totalHardDiagBaseline += baselineIndividual.concordance[composite].hardDiagFailures;
    totalHardDiagBest += (best?.concordance[composite].hardDiagFailures ?? totalHardDiagBaseline);
  }

  const anyImproved = best !== null && (
    totalMustPassBest < totalMustPassBaseline ||
    totalHardDiagBest < totalHardDiagBaseline ||
    COMPOSITE_KEYS.some((ck) => (best.concordance[ck].rate) > (baselineIndividual.concordance[ck].rate))
  );

  console.log("=== Aggregate ===");
  console.log(`  Must-pass failures: ${totalMustPassBaseline} → ${totalMustPassBest}`);
  console.log(`  Hard-diagnostic failures: ${totalHardDiagBaseline} → ${totalHardDiagBest}`);
  console.log(`  Any improvement found: ${anyImproved ? "yes" : "no"}`);

  // ── Save Report ─────────────────────────────────────────────────────────

  const outputDir = join(import.meta.dirname, "..", "benchmarks-output", "optimize");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Collect Pareto front candidates
  const fronts = nonDominatedSort(population);
  const paretoFront = (fronts[0] ?? []).filter((ind) => ind.feasible);

  const paretoFrontData = paretoFront.map((ind) => ({
    concordance: Object.fromEntries(
      COMPOSITE_KEYS.map((ck) => [ck, Math.round(ind.concordance[ck].rate * 1000) / 1000]),
    ),
    diagnosticFailures: ind.fitness.obj3,
    thresholds: {
      compactDeclarationThreshold: ind.genome.compactDeclarationThreshold,
      compactPositionThreshold: ind.genome.compactPositionThreshold,
      domainAmbiguityThreshold: Math.round(ind.genome.domainAmbiguityThreshold * 1000) / 1000,
      scenarioEmissionThreshold: Math.round(ind.genome.scenarioEmissionThreshold * 1000) / 1000,
    },
    weights: Object.fromEntries(
      COMPOSITE_KEYS.map((ck) => [ck, ind.genome.weights[ck]]),
    ),
  }));

  // Best per objective
  const bestPerObjective: Record<string, unknown> = {};
  const objectiveLabels = ["consumerApi_concordance", "agentReadiness_concordance", "typeSafety_concordance", "diagnostic_failures"];
  for (let oi = 0; oi < NUM_OBJECTIVES; oi++) {
    const bestInd = bestForObjective(population, oi);
    if (bestInd) {
      bestPerObjective[objectiveLabels[oi]!] = {
        concordance: Object.fromEntries(
          COMPOSITE_KEYS.map((ck) => [ck, Math.round(bestInd.concordance[ck].rate * 1000) / 1000]),
        ),
        diagnosticFailures: bestInd.fitness.obj3,
        weights: Object.fromEntries(
          COMPOSITE_KEYS.map((ck) => [ck, bestInd.genome.weights[ck]]),
        ),
      };
    }
  }

  // Build composites section for backward compatibility
  const compositesReport: Record<string, unknown> = {};
  for (const composite of COMPOSITE_KEYS) {
    const baseResult = baselineIndividual.concordance[composite];
    const optResult = best?.concordance[composite] ?? baseResult;
    const optWeights = best?.genome.weights[composite] ?? baseWeightsMap[composite]!;
    const compositeImproved =
      optResult.mustPassFailures < baseResult.mustPassFailures ||
      optResult.hardDiagFailures < baseResult.hardDiagFailures ||
      optResult.rate > baseResult.rate;

    compositesReport[composite] = {
      baseline: {
        concordance: Math.round(baseResult.rate * 1000) / 1000,
        hardDiagFailures: baseResult.hardDiagFailures,
        mustPassFailures: baseResult.mustPassFailures,
        weights: baseWeightsMap[composite],
      },
      improved: compositeImproved,
      optimal: {
        concordance: Math.round(optResult.rate * 1000) / 1000,
        hardDiagFailures: optResult.hardDiagFailures,
        mustPassFailures: optResult.mustPassFailures,
        weights: optWeights,
      },
    };
  }

  const report = {
    algorithm: "nsga-ii",
    bestPerObjective,
    composites: compositesReport,
    generationStats,
    paretoFront: paretoFrontData,
    settings: {
      concordanceFloor: CONCORDANCE_FLOOR,
      elitismFraction: ELITISM_FRACTION,
      generations: GENERATIONS,
      mutationSigma: MUTATION_SIGMA,
      populationSize: POPULATION_SIZE,
      seed: PRNG_SEED,
      tournamentSize: TOURNAMENT_SIZE,
      weightRange: [WEIGHT_MIN, WEIGHT_MAX],
    },
    summary: {
      anyImproved,
      totalHardDiagBaseline,
      totalHardDiagBest,
      totalMustPassBaseline,
      totalMustPassBest,
    },
    timestamp: new Date().toISOString(),
  };

  const reportPath = join(outputDir, "latest.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nOptimizer report saved to benchmarks-output/optimize/latest.json`);
}

main();
