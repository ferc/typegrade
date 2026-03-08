import type { GraphStats } from "./graph/types.js";

export type AnalysisMode = "source" | "package";
export type CompositeKey =
  | "consumerApi"
  | "implementationQuality"
  | "agentReadiness"
  | "typeSafety";
export type DomainKey =
  | "validation"
  | "result"
  | "utility"
  | "router"
  | "orm"
  | "schema"
  | "frontend"
  | "stream"
  | "general";
export type ScoreComparability = "global" | "domain" | "scenario";
export type ScenarioPackKey = "validation" | "router" | "orm" | "result" | "schema" | "stream";

export interface CompositeScore {
  key: CompositeKey;
  score: number | null;
  grade: Grade;
  rationale: string[];
  confidence?: number;
  compositeConfidenceReasons?: string[];
}

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F" | "N/A";

export interface ConfidenceSignal {
  source: string;
  value: number;
  reason: string;
}

export interface DimensionResult {
  key: string;
  label: string;
  enabled: boolean;
  score: number | null;
  weights: Partial<Record<CompositeKey, number>>;
  metrics: Record<string, number | string | boolean>;
  positives: string[];
  negatives: string[];
  issues: Issue[];
  applicabilityReason?: string;
  confidence?: number;
  confidenceSignals?: ConfidenceSignal[];
}

export interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  dimension: string;
}

/** Domain-adjusted score — only comparable within the same domain */
export interface DomainScore {
  domain: DomainKey;
  score: number;
  grade: Grade;
  adjustments: { dimension: string; adjustment: string; effect: number; reason: string }[];
  confidence: number;
  comparability: "domain";
}

/** Scenario-based score — from consumer benchmark apps */
export interface ScenarioScore {
  scenario: string;
  domain: DomainKey;
  score: number;
  grade: Grade;
  passedScenarios: number;
  totalScenarios: number;
  results: ScenarioResult[];
  comparability: "scenario";
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  score: number;
  reason: string;
}

export interface GlobalScores {
  consumerApi: CompositeScore;
  agentReadiness: CompositeScore;
  typeSafety: CompositeScore;
}

export interface ConfidenceSummary {
  graphResolution: number;
  domainInference: number;
  scenarioApplicability: number;
  sampleCoverage: number;
}

export interface BenchmarkDiagnostics {
  assertionMargins: { assertion: string; delta: number; minDelta?: number }[];
  rankingLossGlobal?: number;
  rankingLossByDomain?: Record<string, number>;
  rankingLossByScenario?: Record<string, number>;
  falseEquivalenceCount?: number;
}

export interface AnalysisResult {
  mode: AnalysisMode;
  scoreProfile: "source-project" | "published-declarations";
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;
  composites: CompositeScore[];
  dimensions: DimensionResult[];
  caveats: string[];
  topIssues: Issue[];
  /** Structured global scores for JSON output */
  globalScores?: GlobalScores;
  /** Domain-adjusted score, only comparable within domain */
  domainScore?: DomainScore | undefined;
  /** Scenario-based score from benchmark apps */
  scenarioScore?: ScenarioScore | undefined;
  /** Indicates which score layer is primary for this result */
  scoreComparability: ScoreComparability;
  domainInference?:
    | {
        domain: string;
        confidence: number;
        signals: string[];
        falsePositiveRisk?: number | undefined;
        matchedRules?: string[] | undefined;
        adjustments?: { dimension: string; adjustment: string; reason: string }[] | undefined;
      }
    | undefined;
  /** Graph and dedup stats — mandatory in package mode */
  graphStats: GraphStats;
  dedupStats: { groups: number; filesRemoved: number };
  /** Confidence summary across all layers */
  confidenceSummary?: ConfidenceSummary;
  explainability?: ExplainabilityReport;
  benchmarkDiagnostics?: BenchmarkDiagnostics;
  scenarioDiagnostics?: {
    scenarioPack: string;
    failures: { scenario: string; expected: string; actual: string }[];
  };
}

export interface PrecisionFeatures {
  score: number;
  containsAny: boolean;
  containsUnknown: boolean;
  features: string[];
  reasons: string[];
  /** Per-feature counts for density calculation */
  featureCounts?: Record<string, number>;
}

export interface ExplainabilityEntry {
  name: string;
  score: number;
  file?: string;
  line?: number;
  features?: string[];
  reason?: string;
}

export interface ExplainabilityReport {
  lowestSpecificity: ExplainabilityEntry[];
  highestLift: ExplainabilityEntry[];
  safetyLeaks: ExplainabilityEntry[];
  lowestUsability: ExplainabilityEntry[];
  highestSpecificity: ExplainabilityEntry[];
  highestSpecializationPower: ExplainabilityEntry[];
  domainSuppressions: { name: string; reason: string }[];
  domainAmbiguities: { domain: string; confidence: number; competingDomain?: string }[];
  /** Scenario failure explanations */
  scenarioFailures?: { scenario: string; reason: string }[];
}

export interface PackageAnalysisContext {
  packageName: string;
  packageRoot: string;
  packageJsonPath: string;
  typesEntrypoint: string | null;
  graphStats?: GraphStats;
}
