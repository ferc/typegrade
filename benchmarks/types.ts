/**
 * Benchmark system types — V2 manifest format, split management,
 * quarantine policy, and evaluation metrics.
 */

// ─── Manifest V2 ──────────────────────────────────────────────────────────

export type BenchmarkSplit = "train" | "holdout" | "eval-fixed" | "eval-pool";

/** V1 entry format (backward compat) */
export type ManifestEntryV1 = string | { spec: string; typesVersion?: string };

/** V2 entry format with metadata for stratified sampling and auditing */
export interface ManifestEntryV2 {
  spec: string;
  typesVersion?: string;
  /** Functional proxy family for stratified sampling */
  proxyFamily?: string;
  /** Approximate type surface size band */
  sizeBand?: "small" | "medium" | "large";
  /** How types are provided */
  typesSourceHint?: "bundled" | "@types" | "mixed";
  /** Module system */
  moduleKind?: "esm" | "cjs" | "dual";
  /** Human-readable note */
  notes?: string;
}

export type ManifestEntry = ManifestEntryV1 | ManifestEntryV2;

/** Manifest wrapper (supports both V1 and V2 entries) */
export interface BenchmarkManifestV2 {
  version?: 2;
  split?: BenchmarkSplit;
  packages: Record<string, ManifestEntry[]>;
}

// ─── Snapshots & Results ───────────────────────────────────────────────────

/** Raw benchmark snapshot persisted to results/ */
export interface RawBenchmarkSnapshotV2 {
  timestamp: string;
  split: BenchmarkSplit;
  manifestSource: string;
  seed?: number;
  /** SHA-256 prefix of the source manifest content */
  manifestHash?: string;
  /** Number of packages sampled (pool-sampled runs only) */
  sampleCount?: number;
  /** SHA-256 prefixes of sampled package specs */
  sampledHashes?: string[];
  entries: RawBenchmarkEntry[];
  assertions?: unknown[];
  summary?: unknown;
  scenarioAssertions?: unknown;
  domainAccuracy?: unknown;
  corpusSplit: string;
}

export interface RawBenchmarkEntry {
  name: string;
  tier: string;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety: number | null;
  domainFitScore: number | null;
  scenarioScore: unknown | null;
  dimensions: { key: string; score: number | null; confidence: number | null; metrics: Record<string, unknown> }[];
  graphStats: unknown;
  coverageDiagnostics: unknown | null;
  domainInference: unknown | null;
  explainability?: unknown | null;
}

// ─── Redacted Eval Summary ─────────────────────────────────────────────────

/**
 * Builder-visible eval output.
 * Contains ONLY aggregate metrics — no package names, no per-package scores.
 */
export interface RedactedEvalSummary {
  timestamp: string;
  split: BenchmarkSplit;
  packageCount: number;
  seed?: number;
  /** Aggregate metrics safe for builder consumption */
  metrics: {
    undersampledRate: number;
    fallbackGlobRate: number;
    coverageConfidenceViolations: number;
    paretoViolationCount: number;
    scoreCompressionRate: number;
    seedInstabilityRate?: number;
    domainOverreachRate: number;
    scenarioOverreachRate: number;
    medianConsumerApi: number;
    medianAgentReadiness: number;
    medianTypeSafety: number;
    scoreStdDev: number;
    trainEvalDrift?: number;
    compactRate?: number;
    confidenceModerationRate?: number;
  };
  /** Gate pass/fail results */
  gates: { gate: string; passed: boolean; detail: string }[];
  /** Overall pass/fail */
  allGatesPassed: boolean;
  /** Concrete wrong-specific domain mismatch examples (redacted to family only) */
  wrongSpecificExamples?: { family: string; expected: string; actual: string }[];
  /** Concrete fallback-glob examples (redacted to family only) */
  fallbackExamples?: { family: string; reason: string }[];
  /** Concrete undersampled examples (redacted to family only) */
  undersampledExamples?: { family: string; reasons: string[] }[];
  /** Per-family score metrics (normalized) */
  familyMetrics?: { family: string; meanScore: number; variance: number; count: number }[];
  /** Normalized family variance (coefficient of variation across families) */
  normalizedFamilyVariance?: number;
  /** Install failures encountered during benchmarking */
  installabilityFailures?: { family: string; error: string }[];
  /** Multi-seed aggregate metrics (present when multiple seeds available) */
  multiSeedMetrics?: {
    seedCount: number;
    wrongSpecificP50: number;
    wrongSpecificP90: number;
    undersampledP50: number;
    undersampledP90: number;
    scenarioOverreachP50: number;
    scenarioOverreachP90: number;
    perFamilyScoreVariance: number;
  };
  /** Comparison against an approved baseline snapshot */
  baselineComparison?: {
    baselineTimestamp: string;
    regressions: { metric: string; baseline: number; current: number }[];
    improvements: { metric: string; baseline: number; current: number }[];
  };
  /** Confidence calibration bands — measures how well confidence predicts quality and failure modes */
  calibration?: {
    band: string;
    count: number;
    meanConfidence: number;
    reasonableRate: number;
    undersampledRate?: number;
    fallbackRate?: number;
    domainOverreachRate?: number;
    degradedRate?: number;
    failureModeRate?: number;
  }[];
}

// ─── Unlabeled Eval Metrics ────────────────────────────────────────────────

export interface UnlabeledEvalMetrics {
  /** Rate of packages flagged as undersampled */
  undersampledRate: number;
  /** Rate of packages that used fallback glob */
  fallbackGlobRate: number;
  /** Packages where high score + low coverage is suspicious */
  coverageConfidenceViolations: number;
  /** Pareto-dominance violations across core dimensions */
  paretoViolationCount: number;
  /** Rate of scores clustering in a narrow band (false flatness) */
  scoreCompressionRate: number;
  /** Rate of scores that are unstable across pool seeds */
  seedInstabilityRate?: number;
  /** Domain inference overreach — predicting specific domain without strong evidence */
  domainOverreachRate: number;
  /** Scenario scores emitted without sufficient domain confidence */
  scenarioOverreachRate: number;
  /** Drift between train and eval score distributions */
  trainEvalDrift?: number;
  /** Rate of compact (small-by-design) packages */
  compactRate?: number;
  /** Rate of packages where score was moderated due to low confidence */
  confidenceModerationRate?: number;
}

export interface ParetoViolation {
  /** Package A dominates B on these dimensions */
  dominant: string;
  dominated: string;
  /** Dimensions where A > B */
  dominantDimensions: string[];
  /** But A ranks below B on composite */
  dominantComposite: number;
  dominatedComposite: number;
}

// ─── Quarantine Policy ─────────────────────────────────────────────────────

export interface BenchmarkQuarantinePolicy {
  /** Files the builder agent must not read */
  builderForbiddenPaths: string[];
  /** Commands the builder agent may run */
  builderAllowedCommands: string[];
  /** Commands the judge/CI may run */
  judgeAllowedCommands: string[];
  /** Imports that calibration/optimizer code must not reference */
  forbiddenImportsForOptimizer: string[];
}

export const QUARANTINE_POLICY: BenchmarkQuarantinePolicy = {
  builderForbiddenPaths: [
    "benchmarks/manifest.eval.fixed.json",
    "benchmarks/manifest.eval.pool.json",
    "benchmarks-output/eval-raw/",
    "benchmarks-output/shadow-raw/",
  ],
  builderAllowedCommands: [
    "benchmark:train",
    "benchmark:holdout",
    "gate:train",
    "gate:holdout",
    "benchmark:optimize",
    "benchmark:calibrate",
  ],
  judgeAllowedCommands: [
    "benchmark:eval",
    "benchmark:pool",
    "benchmark:judge",
    "benchmark:shadow",
    "gate:eval",
    "gate:shadow",
  ],
  forbiddenImportsForOptimizer: [
    "manifest.eval.fixed.json",
    "manifest.eval.pool.json",
    "eval-raw",
    "eval-summary",
    "shadow-raw",
  ],
};

// ─── Random Sample Spec ────────────────────────────────────────────────────

export interface RandomSampleSpec {
  /** Seed for deterministic sampling */
  seed: number;
  /** Number of packages to sample */
  count: number;
  /** Hash of the source manifest */
  manifestHash?: string;
  /** Hashes of sampled package specs */
  sampledHashes?: string[];
}

// ─── Monotonic Constraints ─────────────────────────────────────────────────

/**
 * Constraints that the optimizer must respect.
 * Violating these means the scorer is unsound.
 */
export interface MonotonicConstraint {
  name: string;
  description: string;
  /** Returns true if the constraint is satisfied */
  check: (before: number, after: number) => boolean;
}

// ─── Redacted Shadow Summary ─────────────────────────────────────────────

/**
 * Builder-visible shadow validation output.
 * Contains ONLY aggregate metrics — no package names or per-package details.
 * Emitted by the judge-only shadow validation track.
 */
export interface RedactedShadowSummary {
  timestamp: string;
  totalPackages: number;
  /** Rate of packages producing comparable results */
  comparableRate: number;
  /** Rate of correct abstention (degraded/not-comparable for appropriate cases) */
  abstentionCorrectnessRate: number;
  /** Rate of false-authoritative results (trusted classification on bad data) */
  falseAuthoritativeRate: number;
  /** Rate of install failures */
  installFailureRate: number;
  /** Rate of packages using fallback glob */
  fallbackGlobRate: number;
  /** Rate of domain inference on packages without clear domain signals */
  domainOverreachRate: number;
  /** Rate of scenario scores on packages without matching domain */
  scenarioOverreachRate: number;
  /** Rate of scores clustering in narrow band */
  scoreCompressionRate: number;
  /** Cross-run stability coefficient (1.0 = perfectly stable) */
  crossRunStability: number;
  /** 99% lower confidence bounds for gate metrics */
  confidenceBounds: {
    comparableRate: number;
    abstentionCorrectnessRate: number;
    falseAuthoritativeRate: number;
    fallbackGlobRate: number;
  };
  /** Stratification breakdown (no package names) */
  stratification?: {
    byTypesSource: Record<string, { count: number; comparableRate: number }>;
    bySizeBand: Record<string, { count: number; comparableRate: number }>;
    byModuleKind: Record<string, { count: number; comparableRate: number }>;
  };
  /** Gate pass/fail results */
  gates: { gate: string; passed: boolean; detail: string }[];
  allGatesPassed: boolean;
}

export const MONOTONIC_CONSTRAINTS: MonotonicConstraint[] = [
  {
    name: "any-leakage-typeSafety",
    description: "More any leakage must never improve typeSafety",
    check: (before, after) => after <= before,
  },
  {
    name: "lower-coverage-confidence",
    description: "Lower coverage must never increase confidence",
    check: (before, after) => after <= before,
  },
  {
    name: "fallback-no-score-boost",
    description: "Fallback or undersampling must never improve composite scores",
    check: (before, after) => after <= before,
  },
  {
    name: "contradiction-no-certainty-boost",
    description: "Stronger contradiction evidence must never raise domain certainty",
    check: (before, after) => after <= before,
  },
];
