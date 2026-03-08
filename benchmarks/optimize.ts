#!/usr/bin/env tsx
/**
 * NSGA-II multi-objective evolutionary optimizer — searches for improved
 * scoring parameters using ONLY train data.
 *
 * Four simultaneous objectives (all minimized):
 *   0. Wrong-specific rate — domain accuracy misclassifications
 *   1. Undersampled rate — fraction of packages flagged as undersampled
 *   2. Fallback rate — fraction of packages using fallback glob
 *   3. 1 - assertion pass rate — inverse of pairwise concordance
 *
 * Decision variables:
 *   - Composite weight perturbations (per dimension per composite)
 *   - Domain thresholds (confidence, ambiguity gap)
 *   - Undersample score cap
 *   - Compact classification thresholds (reachable files, positions, declarations)
 *
 * Hard constraints:
 *   - No train assertion regressions (must-pass + hard-diagnostic)
 *   - All weight vectors sum to ~1.0 per composite
 *   - All thresholds in valid ranges
 *
 * NSGA-II specifics:
 *   - Non-dominated sorting with feasibility-first comparison
 *   - Crowding distance for diversity preservation
 *   - Binary tournament selection
 *   - Simulated Binary Crossover (SBX, eta=20)
 *   - Polynomial mutation (eta=20)
 *
 * Quarantine: This script MUST NOT reference eval manifests, eval results,
 * or eval summary files. It operates exclusively on train assertions and
 * train benchmark snapshots.
 */

import { EXPECTED_DOMAINS, PAIRWISE_ASSERTIONS } from "./assertions.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { CompositeKey } from "../src/types.js";
import { DIMENSION_CONFIGS } from "../src/constants.js";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const COMPOSITE_KEYS: CompositeKey[] = ["consumerApi", "agentReadiness", "typeSafety"];
const POPULATION_SIZE = 100;
const GENERATIONS = 50;
const NUM_OBJECTIVES = 4;
const PRNG_SEED = 42;

/** SBX crossover distribution index */
const SBX_ETA = 20;
/** Polynomial mutation distribution index */
const PM_ETA = 20;
/** Crossover probability */
const CROSSOVER_RATE = 0.9;
/** Mutation probability (per gene) */
const MUTATION_RATE = 0.1;
/** Tournament size for binary tournament selection */
const TOURNAMENT_SIZE = 2;

/** Weight bounds */
const WEIGHT_MIN = 0.01;
const WEIGHT_MAX = 0.5;

/** Concordance floor: hard constraint on minimum concordance per composite */
const CONCORDANCE_FLOOR = 0.9;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ResultEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety?: number | null;
  dimensions?: { key: string; score: number | null; confidence: number | null; metrics?: Record<string, unknown> }[];
  graphStats?: { usedFallbackGlob: boolean } | null;
  coverageDiagnostics?: { undersampled: boolean; samplingClass?: string } | null;
  domainInference?: { domain: string; confidence: number } | null;
}

interface BenchmarkSnapshot {
  timestamp: string;
  entries: ResultEntry[];
  corpusSplit?: string;
  domainAccuracy?: {
    accuracy: number;
    correct: number;
    total: number;
    wrongSpecificRate: number;
    abstained: number;
    confusion: { pkg: string; expected: string; actual: string }[];
  };
}

interface ConcordanceResult {
  concordant: number;
  total: number;
  rate: number;
  mustPassFailures: number;
  hardDiagFailures: number;
}

/** Gene bounds definition for a single decision variable */
interface GeneBounds {
  name: string;
  lower: number;
  upper: number;
}

/** Individual in the NSGA-II population */
interface Individual {
  genes: number[];
  objectives: number[];
  rank: number;
  crowdingDistance: number;
  /** Whether hard constraints are satisfied */
  feasible: boolean;
  /** Decoded parameter set for reporting */
  decoded?: DecodedParams;
}

/** Decoded parameter values from the gene vector */
interface DecodedParams {
  weights: Record<CompositeKey, Record<string, number>>;
  domainConfidenceThreshold: number;
  domainAmbiguityGap: number;
  undersampleScoreCap: number;
  minReachableFiles: number;
  minMeasuredPositions: number;
  minMeasuredDeclarations: number;
}

interface OptimizationConfig {
  populationSize: number;
  generations: number;
  crossoverRate: number;
  mutationRate: number;
  tournamentSize: number;
  sbxEta: number;
  pmEta: number;
}

interface GenerationStats {
  generation: number;
  feasibleCount: number;
  paretoFrontSize: number;
  bestObjectives: number[];
  worstObjectives: number[];
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

// ─── Gene Encoding ───────────────────────────────────────────────────────────

/**
 * Build the ordered list of gene bounds.
 * The gene vector encodes:
 *   1. Weight perturbations for each composite (per dimension key)
 *   2. Domain confidence threshold
 *   3. Domain ambiguity gap
 *   4. Undersample score cap
 *   5. Min reachable files
 *   6. Min measured positions
 *   7. Min measured declarations
 */
function buildGeneBounds(): GeneBounds[] {
  const bounds: GeneBounds[] = [];

  // Weight genes: one per (composite, dimension) pair
  for (const composite of COMPOSITE_KEYS) {
    for (const cfg of DIMENSION_CONFIGS) {
      const wt = cfg.weights[composite];
      if (wt) {
        bounds.push({
          lower: WEIGHT_MIN,
          name: `weight:${composite}:${cfg.key}`,
          upper: WEIGHT_MAX,
        });
      }
    }
  }

  // Threshold genes
  bounds.push({ lower: 0.3, name: "domainConfidenceThreshold", upper: 0.95 });
  bounds.push({ lower: 0.05, name: "domainAmbiguityGap", upper: 0.5 });
  bounds.push({ lower: 50, name: "undersampleScoreCap", upper: 80 });
  bounds.push({ lower: 1, name: "minReachableFiles", upper: 10 });
  bounds.push({ lower: 3, name: "minMeasuredPositions", upper: 30 });
  bounds.push({ lower: 2, name: "minMeasuredDeclarations", upper: 15 });

  return bounds;
}

/** Extract baseline gene values from current DIMENSION_CONFIGS and defaults */
function buildBaselineGenes(bounds: GeneBounds[]): number[] {
  const genes: number[] = [];

  for (const bound of bounds) {
    if (bound.name.startsWith("weight:")) {
      const parts = bound.name.split(":");
      const composite = parts[1] as CompositeKey;
      const dimKey = parts[2]!;
      const cfg = DIMENSION_CONFIGS.find((dc) => dc.key === dimKey);
      const wt = cfg?.weights[composite] ?? 0.1;
      genes.push(wt);
    } else if (bound.name === "domainConfidenceThreshold") {
      genes.push(0.7);
    } else if (bound.name === "domainAmbiguityGap") {
      genes.push(0.15);
    } else if (bound.name === "undersampleScoreCap") {
      genes.push(65);
    } else if (bound.name === "minReachableFiles") {
      genes.push(3);
    } else if (bound.name === "minMeasuredPositions") {
      genes.push(10);
    } else if (bound.name === "minMeasuredDeclarations") {
      genes.push(5);
    }
  }

  return genes;
}

/** Decode gene vector into structured parameters */
function decodeGenes(genes: number[], bounds: GeneBounds[]): DecodedParams {
  const weights: Record<string, Record<string, number>> = {};
  for (const composite of COMPOSITE_KEYS) {
    weights[composite] = {};
  }

  let domainConfidenceThreshold = 0.7;
  let domainAmbiguityGap = 0.15;
  let undersampleScoreCap = 65;
  let minReachableFiles = 3;
  let minMeasuredPositions = 10;
  let minMeasuredDeclarations = 5;

  for (let idx = 0; idx < genes.length; idx++) {
    const bound = bounds[idx]!;
    const val = genes[idx]!;

    if (bound.name.startsWith("weight:")) {
      const parts = bound.name.split(":");
      const composite = parts[1]!;
      const dimKey = parts[2]!;
      weights[composite]![dimKey] = val;
    } else if (bound.name === "domainConfidenceThreshold") {
      domainConfidenceThreshold = val;
    } else if (bound.name === "domainAmbiguityGap") {
      domainAmbiguityGap = val;
    } else if (bound.name === "undersampleScoreCap") {
      undersampleScoreCap = val;
    } else if (bound.name === "minReachableFiles") {
      minReachableFiles = val;
    } else if (bound.name === "minMeasuredPositions") {
      minMeasuredPositions = val;
    } else if (bound.name === "minMeasuredDeclarations") {
      minMeasuredDeclarations = val;
    }
  }

  // Normalize weight vectors so each composite sums to ~1.0
  for (const composite of COMPOSITE_KEYS) {
    weights[composite] = normalizeWeights(weights[composite]!);
  }

  return {
    domainAmbiguityGap,
    domainConfidenceThreshold,
    minMeasuredDeclarations: Math.round(minMeasuredDeclarations),
    minMeasuredPositions: Math.round(minMeasuredPositions),
    minReachableFiles: Math.round(minReachableFiles),
    undersampleScoreCap: Math.round(undersampleScoreCap),
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

// ─── Objective Evaluation ────────────────────────────────────────────────────

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

/**
 * Compute wrong-specific domain rate.
 * Uses decoded thresholds to simulate domain acceptance, then compares
 * against expected domains from train assertions.
 */
function computeWrongSpecificRate(entries: ResultEntry[], decoded: DecodedParams): number {
  let wrongSpecific = 0;
  let totalChecked = 0;

  for (const entry of entries) {
    const expected = EXPECTED_DOMAINS[entry.name];
    if (!expected) {
      continue;
    }

    totalChecked++;

    // Simulate domain acceptance with candidate thresholds
    const inference = entry.domainInference;
    if (!inference) {
      // No inference means abstention — not wrong-specific
      continue;
    }

    const accepted = inference.confidence >= decoded.domainConfidenceThreshold;
    if (!accepted) {
      // Below threshold means abstention — not wrong-specific
      continue;
    }

    if (inference.domain !== expected && expected !== "general") {
      // Wrong domain for a non-general package
      wrongSpecific++;
    }
  }

  return totalChecked > 0 ? wrongSpecific / totalChecked : 0;
}

/** Compute undersampled rate from entries using decoded thresholds */
function computeUndersampledRate(entries: ResultEntry[], decoded: DecodedParams): number {
  let undersampled = 0;
  let totalChecked = 0;

  for (const entry of entries) {
    if (!entry.coverageDiagnostics) {
      continue;
    }

    totalChecked++;

    // Simulate undersampled detection using candidate thresholds
    // A package is undersampled if it has too few positions and declarations
    const diag = entry.coverageDiagnostics as Record<string, unknown>;
    const measuredPositions = (diag["measuredPositions"] as number) ?? 0;
    const measuredDeclarations = (diag["measuredDeclarations"] as number) ?? 0;
    const reachableFiles = (diag["reachableFiles"] as number) ?? 0;

    // Check against candidate compact thresholds
    const isBelowPositionThreshold = measuredPositions < decoded.minMeasuredPositions;
    const isBelowDeclarationThreshold = measuredDeclarations < decoded.minMeasuredDeclarations;
    const isBelowFileThreshold = reachableFiles < decoded.minReachableFiles;

    if (isBelowPositionThreshold && isBelowDeclarationThreshold && isBelowFileThreshold) {
      undersampled++;
    }
  }

  return totalChecked > 0 ? undersampled / totalChecked : 0;
}

/** Compute fallback glob rate from entries */
function computeFallbackRate(entries: ResultEntry[]): number {
  let fallbackCount = 0;
  let totalChecked = 0;

  for (const entry of entries) {
    if (!entry.graphStats) {
      continue;
    }

    totalChecked++;
    if (entry.graphStats.usedFallbackGlob) {
      fallbackCount++;
    }
  }

  return totalChecked > 0 ? fallbackCount / totalChecked : 0;
}

/**
 * Evaluate all four objectives for a gene vector.
 * Returns the individual with computed objectives and feasibility.
 */
function evaluateIndividual(params: {
  genes: number[];
  bounds: GeneBounds[];
  entries: ResultEntry[];
}): Individual {
  const { genes, bounds, entries } = params;
  const decoded = decodeGenes(genes, bounds);

  // Objective 0: Wrong-specific domain rate (minimize)
  const wrongSpecificRate = computeWrongSpecificRate(entries, decoded);

  // Objective 1: Undersampled rate (minimize)
  const undersampledRate = computeUndersampledRate(entries, decoded);

  // Objective 2: Fallback rate (minimize). Not controllable via weights
  // But included for Pareto-completeness
  const fallbackRate = computeFallbackRate(entries);

  // Objective 3: 1 - assertion pass rate (minimize)
  let totalConcordant = 0;
  let totalAssertions = 0;
  let totalMustPassFails = 0;
  let totalHardDiagFails = 0;

  for (const composite of COMPOSITE_KEYS) {
    const result = evaluateConcordance({
      composite,
      entries,
      weights: decoded.weights[composite],
    });
    totalConcordant += result.concordant;
    totalAssertions += result.total;
    totalMustPassFails += result.mustPassFailures;
    totalHardDiagFails += result.hardDiagFailures;
  }

  const passRate = totalAssertions > 0 ? totalConcordant / totalAssertions : 0;
  const assertionError = 1 - passRate;

  // Hard constraints
  const feasible =
    totalMustPassFails === 0 &&
    totalHardDiagFails === 0 &&
    passRate >= CONCORDANCE_FLOOR;

  return {
    crowdingDistance: 0,
    decoded,
    feasible,
    genes: [...genes],
    objectives: [wrongSpecificRate, undersampledRate, fallbackRate, assertionError],
    rank: 0,
  };
}

// ─── NSGA-II Core ────────────────────────────────────────────────────────────

/**
 * Non-dominated sorting — assign Pareto ranks to the entire population.
 * Feasible individuals always dominate infeasible ones.
 * Returns array of fronts (front 0 is the Pareto-optimal set).
 */
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
      } else if (dominatesObjectives(indP.objectives, indQ.objectives)) {
        dominatedSet[pp]!.push(qq);
        dominationCount[qq]!++;
      } else if (dominatesObjectives(indQ.objectives, indP.objectives)) {
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

  // Build successive fronts
  let rankVal = 0;
  while (currentFront.length > 0) {
    const front: Individual[] = [];
    for (const idx of currentFront) {
      const ind = population[idx]!;
      ind.rank = rankVal;
      front.push(ind);
    }
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
    rankVal++;
  }

  return fronts;
}

/** Check if objective vector A dominates B (all <=, at least one <) */
function dominatesObjectives(objsA: number[], objsB: number[]): boolean {
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

/**
 * Crowding distance assignment for individuals within a single Pareto front.
 * Boundary solutions receive infinite distance to ensure diversity.
 */
function crowdingDistanceAssignment(front: Individual[]): void {
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

  // For each objective, sort and accumulate distance contributions
  for (let objIdx = 0; objIdx < NUM_OBJECTIVES; objIdx++) {
    const sorted = [...front].toSorted((aa, bb) => aa.objectives[objIdx]! - bb.objectives[objIdx]!);
    const minVal = sorted[0]!.objectives[objIdx]!;
    const maxVal = sorted[frontSize - 1]!.objectives[objIdx]!;
    const range = maxVal - minVal;

    // Boundary individuals get infinite distance
    sorted[0]!.crowdingDistance = Infinity;
    sorted[frontSize - 1]!.crowdingDistance = Infinity;

    if (range > 0) {
      for (let idx = 1; idx < frontSize - 1; idx++) {
        const prev = sorted[idx - 1]!.objectives[objIdx]!;
        const next = sorted[idx + 1]!.objectives[objIdx]!;
        sorted[idx]!.crowdingDistance += (next - prev) / range;
      }
    }
  }
}

/**
 * Binary tournament selection — pick two random candidates and return
 * the one with better rank, or better crowding distance if ranks tie.
 */
function binaryTournamentSelection(population: Individual[], rng: () => number): Individual {
  const idxA = Math.floor(rng() * population.length);
  const idxB = Math.floor(rng() * population.length);
  const candA = population[idxA]!;
  const candB = population[idxB]!;

  // Prefer lower rank (better Pareto front)
  if (candA.rank < candB.rank) {
    return candA;
  }
  if (candB.rank < candA.rank) {
    return candB;
  }

  // Same rank — prefer higher crowding distance (more diverse)
  if (candA.crowdingDistance > candB.crowdingDistance) {
    return candA;
  }
  return candB;
}

/**
 * Simulated Binary Crossover (SBX) — produces two offspring from two parents.
 * Uses the distribution index eta to control spread of offspring.
 */
function sbxCrossover(params: {
  parent1: number[];
  parent2: number[];
  bounds: GeneBounds[];
  rng: () => number;
  eta: number;
  crossoverRate: number;
}): [number[], number[]] {
  const { parent1, parent2, bounds, rng, eta, crossoverRate } = params;
  const numGenes = parent1.length;
  const child1 = [...parent1];
  const child2 = [...parent2];

  if (rng() > crossoverRate) {
    return [child1, child2];
  }

  for (let gi = 0; gi < numGenes; gi++) {
    // Each gene crosses over with 50% probability
    if (rng() > 0.5) {
      continue;
    }

    const p1 = parent1[gi]!;
    const p2 = parent2[gi]!;

    // Skip if parents are identical at this gene
    if (Math.abs(p1 - p2) < 1e-14) {
      continue;
    }

    const lo = bounds[gi]!.lower;
    const hi = bounds[gi]!.upper;

    const sortedLow = Math.min(p1, p2);
    const sortedHigh = Math.max(p1, p2);
    const diff = sortedHigh - sortedLow;

    // Compute spread factor for lower bound
    const exponent = 1 / (eta + 1);
    const spreadLow = 1 + (2 * (sortedLow - lo) / diff);
    const probLow = 2 - spreadLow ** (-(eta + 1));
    const rand1 = rng();
    const betaq1 = rand1 <= 1 / probLow
      ? (rand1 * probLow) ** exponent
      : (1 / (2 - rand1 * probLow)) ** exponent;

    // Compute spread factor for upper bound
    const spreadHigh = 1 + (2 * (hi - sortedHigh) / diff);
    const probHigh = 2 - spreadHigh ** (-(eta + 1));
    const rand2 = rng();
    const betaq2 = rand2 <= 1 / probHigh
      ? (rand2 * probHigh) ** exponent
      : (1 / (2 - rand2 * probHigh)) ** exponent;

    // Produce offspring
    child1[gi] = clampGene(0.5 * ((sortedLow + sortedHigh) - betaq1 * diff), lo, hi);
    child2[gi] = clampGene(0.5 * ((sortedLow + sortedHigh) + betaq2 * diff), lo, hi);
  }

  return [child1, child2];
}

/**
 * Polynomial mutation — perturbs each gene with probability mutationRate.
 * Uses the distribution index eta to control perturbation magnitude.
 */
function polynomialMutation(params: {
  individual: number[];
  bounds: GeneBounds[];
  rng: () => number;
  eta: number;
  mutationRate: number;
}): number[] {
  const { individual, bounds, rng, eta, mutationRate } = params;
  const mutated = [...individual];

  for (let gi = 0; gi < mutated.length; gi++) {
    if (rng() > mutationRate) {
      continue;
    }

    const val = mutated[gi]!;
    const lo = bounds[gi]!.lower;
    const hi = bounds[gi]!.upper;
    const range = hi - lo;

    if (range < 1e-14) {
      continue;
    }

    const delta1 = (val - lo) / range;
    const delta2 = (hi - val) / range;
    const uu = rng();

    const pmExp = 1 / (eta + 1);
    const deltaq = uu < 0.5
      ? (2 * uu + (1 - 2 * uu) * ((1 - delta1) ** (eta + 1))) ** pmExp - 1
      : 1 - (2 * (1 - uu) + 2 * (uu - 0.5) * ((1 - delta2) ** (eta + 1))) ** pmExp;

    mutated[gi] = clampGene(val + deltaq * range, lo, hi);
  }

  return mutated;
}

/** Clamp a gene value to its bounds */
function clampGene(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

// ─── Population Initialization ──────────────────────────────────────────────

/** Create initial population — baseline + random perturbations */
function initializePopulation(params: {
  baselineGenes: number[];
  bounds: GeneBounds[];
  entries: ResultEntry[];
  rng: () => number;
  config: OptimizationConfig;
}): Individual[] {
  const { baselineGenes, bounds, entries, rng, config } = params;
  // First individual is always the baseline
  const population: Individual[] = [
    evaluateIndividual({ bounds, entries, genes: baselineGenes }),
  ];

  // Remaining individuals: random within bounds
  for (let idx = 1; idx < config.populationSize; idx++) {
    const genes: number[] = [];
    for (let gi = 0; gi < bounds.length; gi++) {
      const lo = bounds[gi]!.lower;
      const hi = bounds[gi]!.upper;
      // Perturb baseline rather than fully random — keeps search near known-good region
      const baseline = baselineGenes[gi]!;
      const spread = (hi - lo) * 0.3;
      const perturbed = baseline + (rng() * 2 - 1) * spread;
      genes.push(clampGene(perturbed, lo, hi));
    }
    population.push(evaluateIndividual({ bounds, entries, genes }));
  }

  return population;
}

// ─── Main NSGA-II Loop ───────────────────────────────────────────────────────

/**
 * Run the NSGA-II optimizer.
 * Returns the final population after all generations.
 */
function runOptimizer(params: {
  entries: ResultEntry[];
  bounds: GeneBounds[];
  baselineGenes: number[];
  config: OptimizationConfig;
  rng: () => number;
}): { population: Individual[]; stats: GenerationStats[] } {
  const { entries, bounds, baselineGenes, config, rng } = params;

  // Initialize population
  console.log(`Initializing population of ${config.populationSize}...`);
  let population = initializePopulation({
    baselineGenes,
    bounds,
    config,
    entries,
    rng,
  });

  // Assign initial ranks and crowding distances
  const initialFronts = nonDominatedSort(population);
  for (const front of initialFronts) {
    crowdingDistanceAssignment(front);
  }

  const allStats: GenerationStats[] = [];
  console.log(`Running ${config.generations} generations...\n`);

  for (let gen = 0; gen < config.generations; gen++) {
    // Generate offspring
    const offspring: Individual[] = [];

    while (offspring.length < config.populationSize) {
      // Binary tournament selection
      const parent1 = binaryTournamentSelection(population, rng);
      const parent2 = binaryTournamentSelection(population, rng);

      // SBX crossover
      const [childGenes1, childGenes2] = sbxCrossover({
        bounds,
        crossoverRate: config.crossoverRate,
        eta: config.sbxEta,
        parent1: parent1.genes,
        parent2: parent2.genes,
        rng,
      });

      // Polynomial mutation
      const mutGenes1 = polynomialMutation({
        bounds,
        eta: config.pmEta,
        individual: childGenes1,
        mutationRate: config.mutationRate,
        rng,
      });
      const mutGenes2 = polynomialMutation({
        bounds,
        eta: config.pmEta,
        individual: childGenes2,
        mutationRate: config.mutationRate,
        rng,
      });

      offspring.push(evaluateIndividual({ bounds, entries, genes: mutGenes1 }));
      if (offspring.length < config.populationSize) {
        offspring.push(evaluateIndividual({ bounds, entries, genes: mutGenes2 }));
      }
    }

    // Combine parent + offspring (size 2N)
    const combined = [...population, ...offspring];

    // Non-dominated sorting on combined population
    const fronts = nonDominatedSort(combined);
    for (const front of fronts) {
      crowdingDistanceAssignment(front);
    }

    // Select next generation (size N) by filling from best fronts
    const nextPopulation: Individual[] = [];
    for (const front of fronts) {
      if (nextPopulation.length + front.length <= config.populationSize) {
        // Entire front fits
        nextPopulation.push(...front);
      } else {
        // Partial front — sort by crowding distance descending
        const remaining = config.populationSize - nextPopulation.length;
        const sortedFront = [...front].toSorted(
          (aa, bb) => bb.crowdingDistance - aa.crowdingDistance,
        );
        nextPopulation.push(...sortedFront.slice(0, remaining));
        break;
      }
    }

    population = nextPopulation;

    // Collect generation statistics
    const stats = collectGenerationStats(population, gen);
    allStats.push(stats);

    // Print progress every 10 generations
    if (gen % 10 === 0 || gen === config.generations - 1) {
      const objLabels = ["wrongSpec", "undersamp", "fallback", "assertErr"];
      const bestStr = stats.bestObjectives
        .map((val, oi) => `${objLabels[oi]}=${(val * 100).toFixed(1)}%`)
        .join(" ");
      console.log(
        `  Gen ${String(gen).padStart(3)}: ` +
        `feasible=${String(stats.feasibleCount).padStart(3)} ` +
        `pareto=${String(stats.paretoFrontSize).padStart(3)} ` +
        `best=[${bestStr}]`,
      );
    }
  }

  return { population, stats: allStats };
}

/** Collect statistics for a generation */
function collectGenerationStats(population: Individual[], generation: number): GenerationStats {
  const feasiblePop = population.filter((ind) => ind.feasible);
  const fronts = nonDominatedSort(population);
  const paretoFrontSize = fronts.length > 0 ? fronts[0]!.length : 0;

  // Compute best (min) and worst (max) per objective among feasible
  const bestObjectives = Array.from<number>({ length: NUM_OBJECTIVES }).fill(Infinity);
  const worstObjectives = Array.from<number>({ length: NUM_OBJECTIVES }).fill(-Infinity);

  for (const ind of feasiblePop) {
    for (let oi = 0; oi < NUM_OBJECTIVES; oi++) {
      const val = ind.objectives[oi]!;
      if (val < bestObjectives[oi]!) {
        bestObjectives[oi] = val;
      }
      if (val > worstObjectives[oi]!) {
        worstObjectives[oi] = val;
      }
    }
  }

  // If no feasible individuals, reset to sentinel values
  if (feasiblePop.length === 0) {
    bestObjectives.fill(-1);
    worstObjectives.fill(-1);
  }

  return {
    bestObjectives,
    feasibleCount: feasiblePop.length,
    generation,
    paretoFrontSize,
    worstObjectives,
  };
}

// ─── Output and Reporting ────────────────────────────────────────────────────

/** Find the overall best individual by minimizing sum of normalized objectives */
function selectKneeSolution(population: Individual[]): Individual | null {
  const feasible = population.filter((ind) => ind.feasible);
  if (feasible.length === 0) {
    return null;
  }

  // Compute min/max for normalization
  const mins = Array.from<number>({ length: NUM_OBJECTIVES }).fill(Infinity);
  const maxs = Array.from<number>({ length: NUM_OBJECTIVES }).fill(-Infinity);
  for (const ind of feasible) {
    for (let oi = 0; oi < NUM_OBJECTIVES; oi++) {
      const val = ind.objectives[oi]!;
      if (val < mins[oi]!) {
        mins[oi] = val;
      }
      if (val > maxs[oi]!) {
        maxs[oi] = val;
      }
    }
  }

  // Normalized sum selection (knee point heuristic)
  let best = feasible[0]!;
  let bestScore = Infinity;

  for (const ind of feasible) {
    let score = 0;
    for (let oi = 0; oi < NUM_OBJECTIVES; oi++) {
      const range = maxs[oi]! - mins[oi]!;
      if (range > 0) {
        score += (ind.objectives[oi]! - mins[oi]!) / range;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = ind;
    }
  }

  return best;
}

/** Print detailed knee solution thresholds and weight changes */
function printKneeDetails(decoded: DecodedParams, baselineGenes: number[], bounds: GeneBounds[]): void {
  console.log("\n  Thresholds:");
  console.log(`    Domain confidence:      ${decoded.domainConfidenceThreshold.toFixed(3)}`);
  console.log(`    Domain ambiguity gap:   ${decoded.domainAmbiguityGap.toFixed(3)}`);
  console.log(`    Undersample score cap:  ${decoded.undersampleScoreCap}`);
  console.log(`    Min reachable files:    ${decoded.minReachableFiles}`);
  console.log(`    Min measured positions: ${decoded.minMeasuredPositions}`);
  console.log(`    Min measured decl:      ${decoded.minMeasuredDeclarations}`);

  console.log("\n  Weight changes vs baseline:");
  const baseDecoded = decodeGenes(baselineGenes, bounds);
  for (const composite of COMPOSITE_KEYS) {
    printWeightChanges(composite, decoded.weights[composite], baseDecoded.weights[composite]);
  }
}

/** Print weight changes for a single composite */
function printWeightChanges(
  composite: CompositeKey,
  kneeWeights: Record<string, number>,
  baseWeights: Record<string, number>,
): void {
  const changes: string[] = [];
  for (const [dim, weight] of Object.entries(kneeWeights)) {
    const diff = weight - (baseWeights[dim] ?? 0);
    if (Math.abs(diff) > 0.005) {
      const diffStr = diff > 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3);
      changes.push(`      ${dim.padEnd(24)} ${weight.toFixed(3)} (${diffStr})`);
    }
  }

  if (changes.length > 0) {
    console.log(`    ${composite}:`);
    for (const line of changes) {
      console.log(line);
    }
  } else {
    console.log(`    ${composite}: no significant changes`);
  }
}

/** Format a decoded params block for output */
function formatDecodedSolution(ind: Individual): Record<string, unknown> {
  const { decoded } = ind;
  if (!decoded) {
    return {};
  }

  return {
    objectives: {
      assertionError: round4(ind.objectives[3]!),
      fallbackRate: round4(ind.objectives[2]!),
      undersampledRate: round4(ind.objectives[1]!),
      wrongSpecificRate: round4(ind.objectives[0]!),
    },
    thresholds: {
      domainAmbiguityGap: round4(decoded.domainAmbiguityGap),
      domainConfidenceThreshold: round4(decoded.domainConfidenceThreshold),
      minMeasuredDeclarations: decoded.minMeasuredDeclarations,
      minMeasuredPositions: decoded.minMeasuredPositions,
      minReachableFiles: decoded.minReachableFiles,
      undersampleScoreCap: decoded.undersampleScoreCap,
    },
    weights: Object.fromEntries(
      COMPOSITE_KEYS.map((ck) => [ck, decoded.weights[ck]]),
    ),
  };
}

/** Round to 4 decimal places */
function round4(val: number): number {
  return Math.round(val * 10_000) / 10_000;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("=== typegrade NSGA-II Multi-Objective Optimizer (train-only) ===\n");

  // Load train snapshot
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

  // Build gene encoding
  const bounds = buildGeneBounds();
  const baselineGenes = buildBaselineGenes(bounds);
  const rng = mulberry32(PRNG_SEED);

  console.log(`Gene count: ${bounds.length} decision variables`);
  console.log(`Objectives: wrongSpecificRate, undersampledRate, fallbackRate, assertionError`);

  // Evaluate baseline
  const baselineInd = evaluateIndividual({ bounds, entries: snapshot.entries, genes: baselineGenes });
  console.log("\nBaseline objectives:");
  console.log(`  Wrong-specific rate: ${(baselineInd.objectives[0]! * 100).toFixed(1)}%`);
  console.log(`  Undersampled rate:   ${(baselineInd.objectives[1]! * 100).toFixed(1)}%`);
  console.log(`  Fallback rate:       ${(baselineInd.objectives[2]! * 100).toFixed(1)}%`);
  console.log(`  Assertion error:     ${(baselineInd.objectives[3]! * 100).toFixed(1)}%`);
  console.log(`  Feasible: ${baselineInd.feasible ? "yes" : "no"}\n`);

  // Configuration
  const config: OptimizationConfig = {
    crossoverRate: CROSSOVER_RATE,
    generations: GENERATIONS,
    mutationRate: MUTATION_RATE,
    pmEta: PM_ETA,
    populationSize: POPULATION_SIZE,
    sbxEta: SBX_ETA,
    tournamentSize: TOURNAMENT_SIZE,
  };

  // Run optimizer
  const { population, stats } = runOptimizer({
    baselineGenes,
    bounds,
    config,
    entries: snapshot.entries,
    rng,
  });

  // ── Results ─────────────────────────────────────────────────────────────

  console.log("\n=== Optimization Results ===\n");

  // Extract Pareto front
  const fronts = nonDominatedSort(population);
  const paretoFront = (fronts[0] ?? []).filter((ind) => ind.feasible);

  console.log(`Pareto front size: ${paretoFront.length} feasible solutions`);

  // Select knee solution
  const knee = selectKneeSolution(population);
  if (knee) {
    console.log("\n--- Knee Solution (best balanced tradeoff) ---");
    console.log(`  Wrong-specific rate: ${(knee.objectives[0]! * 100).toFixed(1)}%`);
    console.log(`  Undersampled rate:   ${(knee.objectives[1]! * 100).toFixed(1)}%`);
    console.log(`  Fallback rate:       ${(knee.objectives[2]! * 100).toFixed(1)}%`);
    console.log(`  Assertion error:     ${(knee.objectives[3]! * 100).toFixed(1)}%`);

    if (knee.decoded) {
      printKneeDetails(knee.decoded, baselineGenes, bounds);
    }
  } else {
    console.log("No feasible solution found. Hard constraints may be too strict.");
    console.log("Consider relaxing concordance floor or checking train assertions.\n");
  }

  // Compare against baseline
  const anyImproved = knee !== null && knee.objectives.some(
    (val, oi) => val < baselineInd.objectives[oi]!,
  );
  const anyRegressed = knee !== null && knee.objectives.some(
    (val, oi) => val > baselineInd.objectives[oi]!,
  );

  console.log("\n=== Aggregate ===");
  console.log(`  Improvement found: ${anyImproved ? "yes" : "no"}`);
  console.log(`  Regressions: ${anyRegressed ? "yes (tradeoff)" : "no"}`);

  // ── Save Report ─────────────────────────────────────────────────────────

  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const outputDir = join(import.meta.dirname, "..", "benchmarks-output", "optimize");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build Pareto front data
  const paretoFrontData = paretoFront.map((ind) => formatDecodedSolution(ind));

  // Build per-objective best solutions
  const objectiveLabels = ["wrongSpecificRate", "undersampledRate", "fallbackRate", "assertionError"];
  const bestPerObjective: Record<string, unknown> = {};
  for (let oi = 0; oi < NUM_OBJECTIVES; oi++) {
    const feasible = population.filter((ind) => ind.feasible);
    if (feasible.length === 0) {
      continue;
    }

    let bestInd = feasible[0]!;
    for (const ind of feasible) {
      if (ind.objectives[oi]! < bestInd.objectives[oi]!) {
        bestInd = ind;
      }
    }
    bestPerObjective[objectiveLabels[oi]!] = formatDecodedSolution(bestInd);
  }

  const report = {
    algorithm: "nsga-ii",
    baseline: formatDecodedSolution(baselineInd),
    bestPerObjective,
    generationStats: stats,
    kneeSolution: knee ? formatDecodedSolution(knee) : null,
    paretoFront: paretoFrontData,
    settings: {
      concordanceFloor: CONCORDANCE_FLOOR,
      crossoverRate: CROSSOVER_RATE,
      geneCount: bounds.length,
      generations: GENERATIONS,
      mutationRate: MUTATION_RATE,
      objectives: objectiveLabels,
      pmEta: PM_ETA,
      populationSize: POPULATION_SIZE,
      sbxEta: SBX_ETA,
      seed: PRNG_SEED,
      tournamentSize: TOURNAMENT_SIZE,
    },
    summary: {
      anyImproved,
      anyRegressed,
      baselineObjectives: baselineInd.objectives,
      feasibleCount: population.filter((ind) => ind.feasible).length,
      kneeObjectives: knee?.objectives ?? null,
      paretoFrontSize: paretoFront.length,
    },
    timestamp: new Date().toISOString(),
  };

  // Write to benchmarks/results/ as the spec requires
  const resultsPath = join(resultsDir, `optimize-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`);
  writeFileSync(resultsPath, JSON.stringify(report, null, 2));
  console.log(`\nPareto front saved to ${resultsPath}`);

  // Also write to benchmarks-output/optimize/latest.json for backward compat
  const latestPath = join(outputDir, "latest.json");
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`Optimizer report saved to benchmarks-output/optimize/latest.json`);
}

main();
