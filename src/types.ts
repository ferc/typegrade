import type { GraphStats } from "./graph/types.js";

// --- Applicability ---

/** Whether a dimension is meaningful for a given library */
export type Applicability = "applicable" | "not_applicable" | "insufficient_evidence";

// --- Analysis Profiles ---

/** Analysis profile determining scoring behavior and report mode */
export type AnalysisProfile = "library" | "package" | "application" | "autofix-agent";

// --- Boundary Types ---

/** Classification of a data boundary in the codebase */
export type BoundaryType =
  | "network"
  | "filesystem"
  | "env"
  | "config"
  | "serialization"
  | "IPC"
  | "UI-input"
  | "trusted-local"
  | "unknown";

// --- Fixability ---

/** How directly fixable an issue is */
export type FixabilityKind = "direct" | "indirect" | "external" | "not_actionable";

// --- Ownership ---

/** Who owns the code where an issue originates */
export type OwnershipClass =
  | "source-owned"
  | "generated"
  | "dependency-owned"
  | "standard-library-owned"
  | "mixed"
  | "unresolved";

// --- Trust Levels ---

/** Trust classification for a boundary data source */
export type TrustLevel =
  | "untrusted-external"
  | "semi-trusted-external"
  | "trusted-local"
  | "generated-local"
  | "internal-only"
  | "unknown";

// --- Root Cause Categories ---

/** Root cause category for an issue */
export type RootCauseCategory =
  | "missing-validation"
  | "weak-type"
  | "unsafe-cast"
  | "missing-narrowing"
  | "opaque-dependency"
  | "config-gap"
  | "boundary-leak"
  | "other";

// --- Suggested Fix Kinds ---

/** Kind of fix suggested for an issue */
export type SuggestedFixKind =
  | "add-type-annotation"
  | "add-validation"
  | "replace-any"
  | "add-narrowing"
  | "add-type-guard"
  | "strengthen-generic"
  | "add-overload"
  | "other";

// --- Suppression Categories ---

/** Category of suppression applied to a finding */
export type SuppressionCategory =
  | "trusted-local-tooling"
  | "dependency-owned-opaque"
  | "generated-artifact"
  | "benchmark-self-referential"
  | "non-applicable-boundary"
  | "low-evidence"
  | "ambiguous-ownership"
  | "expected-generic-density";

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
  /** Consumer relevance score (0-1) for profile-aware weighting */
  consumerRelevance?: number;
  /** Boundary relevance score (0-1) for boundary-quality weighting */
  boundaryRelevance?: number;
  /** Agent fix priority (0-1) for autofix-agent ordering */
  agentFixPriority?: number;
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

// --- Profile Info ---

/** Profile detection result */
export interface ProfileInfo {
  profile: AnalysisProfile;
  profileConfidence: number;
  profileReasons: string[];
}

// --- Boundary Summary ---

/** Single boundary entry in the inventory */
export interface BoundaryInventoryEntry {
  file: string;
  line: number;
  boundaryType: BoundaryType;
  trustLevel: TrustLevel;
  hasValidation: boolean;
  description: string;
}

/** Summary of boundary analysis across the codebase */
export interface BoundarySummary {
  totalBoundaries: number;
  validatedBoundaries: number;
  unvalidatedBoundaries: number;
  inventory: BoundaryInventoryEntry[];
  boundaryCoverage: number;
  missingValidationHotspots: {
    file: string;
    line: number;
    boundaryType: BoundaryType;
    trustLevel: TrustLevel;
  }[];
  trustedLocalSuppressions: { file: string; line: number; reason: string }[];
  taintBreaks: { file: string; line: number; source: string; sink: string }[];
}

// --- Fix Batch ---

/** A grouped batch of related fixes for agent consumption */
export interface FixBatch {
  id: string;
  title: string;
  rationale: string;
  targetFiles: string[];
  issueIds: string[];
  risk: "low" | "medium" | "high";
  expectedImpact: number;
  requiresPublicApiChange: boolean;
  requiresHumanReview: boolean;
}

// --- Autofix Summary ---

/** Summary for autofix-agent consumption */
export interface AutofixSummary {
  actionableIssues: Issue[];
  fixBatches: FixBatch[];
  suppressedCount: number;
  suppressionReasons: { category: string; count: number }[];
}

// --- Suppression Entry ---

/** Record of a suppression applied to a finding */
export interface SuppressionEntry {
  issueIndex: number;
  category: SuppressionCategory;
  reason: string;
  confidence: number;
}

// --- Boundary Quality Score ---

/** Boundary-specific quality score */
export interface BoundaryQualityScore {
  score: number;
  grade: Grade;
  totalBoundaries: number;
  validatedRatio: number;
  trustModelAccuracy: number;
  rationale: string[];
}

// --- Fixability Score ---

/** Fixability meta-score computed from issue-level fixability assessments */
export interface FixabilityScore {
  score: number;
  grade: Grade;
  directlyFixable: number;
  indirectlyFixable: number;
  externalOnly: number;
  notActionable: number;
  rationale: string[];
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
  /** How directly fixable issues in this dimension are */
  fixability?: FixabilityKind;
  /** Ownership classification for this dimension's findings */
  ownership?: OwnershipClass;
}

export interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  dimension: string;
  /** Confidence in this finding (0-1) */
  confidence?: number;
  /** Who owns the code where this issue originates */
  ownership?: OwnershipClass;
  /** How directly fixable this issue is */
  fixability?: FixabilityKind;
  /** Boundary type if this is a boundary-related issue */
  boundaryType?: BoundaryType;
  /** Root cause category */
  rootCauseCategory?: RootCauseCategory;
  /** If suppressed, the reason */
  suppressionReason?: string;
  /** Priority for agent consumption (0-100, higher = more important) */
  agentPriority?: number;
  /** Suggested fix approach */
  suggestedFixKind?: SuggestedFixKind;
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
  /** Analysis profile used for this run */
  profileInfo?: ProfileInfo;
  /** Boundary analysis summary */
  boundarySummary?: BoundarySummary;
  /** Autofix-agent summary with actionable issues and fix batches */
  autofixSummary?: AutofixSummary;
  /** Boundary-specific quality score */
  boundaryQuality?: BoundaryQualityScore;
  /** Fixability meta-score */
  fixabilityScore?: FixabilityScore;
  /** Suppressions applied during analysis */
  suppressions?: SuppressionEntry[];
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
