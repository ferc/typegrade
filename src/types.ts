import type { GraphStats } from "./graph/types.js";

// --- Applicability ---

/** Whether a dimension is meaningful for a given library */
export type Applicability = "applicable" | "not_applicable" | "insufficient_evidence";

// --- Export Roles ---

/** Functional role of an exported declaration in the public API */
export type ExportRole =
  | "public-constructor"
  | "dsl-builder"
  | "type-utility"
  | "schema-constructor"
  | "query-builder"
  | "transport-boundary"
  | "navigation-helper"
  | "state-primitive"
  | "ui-component"
  | "ancillary-helper"
  | "internal-helper";

/** Role classification for a single declaration */
export interface RoleClassification {
  role: ExportRole;
  confidence: number;
  reasons: string[];
}

/** Centrality weight derived from role and entrypoint prominence */
export interface CentralityWeight {
  declarationName: string;
  centralityWeight: number;
  role: ExportRole;
  isEntrypoint: boolean;
  isReexported: boolean;
}

// --- Package Identity ---

/** Resolved identity of the analyzed package */
export interface PackageIdentity {
  displayName: string;
  resolvedSpec: string;
  resolvedVersion: string | null;
}

// --- Evidence Summary ---

/** Summary of evidence quality across scoring layers */
export interface EvidenceSummary {
  exportCoverage: number;
  coreSurfaceCoverage: number;
  specializationEvidence: number;
  domainEvidence: number;
  scenarioEvidence: number;
}

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
  | "state"
  | "testing"
  | "cli"
  | "general";
export type ScoreComparability = "global" | "domain" | "scenario";
export type ScenarioPackKey =
  | "validation"
  | "router"
  | "orm"
  | "result"
  | "schema"
  | "stream"
  | "state"
  | "testing"
  | "cli";

/** Scenario variant for subfamily selection within a domain */
export type ScenarioVariant =
  | "router-client"
  | "router-server"
  | "testing-library"
  | "testing-http"
  | "testing-runner"
  | "validation-schema"
  | "validation-decoder"
  | "cli-builder"
  | "cli-parser";

export interface CompositeScore {
  key: CompositeKey;
  score: number | null;
  grade: Grade;
  rationale: string[];
  confidence?: number;
  compositeConfidenceReasons?: string[];
  /** Which layer this score is comparable at */
  comparability?: ScoreComparability;
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
  /** Whether this dimension is meaningful for this library */
  applicability: Applicability;
  /** Why this dimension is/isn't applicable */
  applicabilityReasons: string[];
  /** @deprecated Use applicabilityReasons[0] instead */
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
  /** Scenario variant used for this evaluation */
  scenarioVariant?: ScenarioVariant;
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
  /** Coverage diagnostics — reachable files, positions, undersampling */
  coverageDiagnostics?: CoverageDiagnostics;
  explainability?: ExplainabilityReport;
  /** Resolved package identity (name, version, spec) */
  packageIdentity?: PackageIdentity;
  /** Summary of evidence quality across scoring layers */
  evidenceSummary?: EvidenceSummary;
  /** Role breakdown of exported declarations */
  roleBreakdown?: { role: ExportRole; count: number; avgCentrality: number }[];
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

/** Coverage diagnostics for a package analysis */
/** Specific failure mode that caused coverage issues */
export type CoverageFailureMode =
  | "entrypoint-resolution"
  | "export-map-resolution"
  | "@types-fragmentation"
  | "install-failure"
  | "fallback-glob"
  | "declaration-scarcity";

export interface CoverageDiagnostics {
  /** How types are provided: bundled in package, @types/* sibling, or mixed */
  typesSource: "bundled" | "@types" | "mixed" | "unknown";
  /** Total files reachable from entrypoints */
  reachableFiles: number;
  /** Total measured type positions in the public surface */
  measuredPositions: number;
  /** Total declarations in the public surface */
  measuredDeclarations: number;
  /** Whether the package is considered undersampled */
  undersampled: boolean;
  /** If undersampled, reason(s) why */
  undersampledReasons: string[];
  /** Cross-package type reference count (import edges outside package) */
  crossPackageTypeRefs?: number;
  /** Whether a coverage penalty was applied to scores */
  coveragePenaltyApplied?: boolean;
  /** Classification of sampling quality */
  samplingClass: "complete" | "compact" | "undersampled";
  /** If compact, explanation for why it's compact-but-complete */
  compactReason?: string;
  /** Specific failure mode that caused coverage issues */
  coverageFailureMode?: CoverageFailureMode;
}

export interface PackageAnalysisContext {
  packageName: string;
  packageRoot: string;
  packageJsonPath: string;
  typesEntrypoint: string | null;
  graphStats?: GraphStats;
  /** Whether types come from @types/* package */
  typesSource?: "bundled" | "@types" | "mixed" | "unknown";
}
