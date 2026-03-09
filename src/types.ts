import type { GraphStats } from "./graph/types.js";

// --- Analysis Status ---

/** Status of the analysis result */
export type AnalysisStatus = "complete" | "degraded" | "invalid-input" | "unsupported-package";

/** How comparable the scores in this result are */
export type ScoreValidity = "fully-comparable" | "partially-comparable" | "not-comparable";

/** Trust classification for the overall result */
export type TrustClassification = "trusted" | "directional" | "abstained";

/** Stage of package acquisition where failure occurred or processing stopped */
export type AcquisitionStage =
  | "spec-resolution"
  | "package-install"
  | "companion-types-resolution"
  | "declaration-entrypoint-resolution"
  | "graph-build"
  | "fallback-selection"
  | "complete";

/** Trust summary for the overall analysis result */
export interface TrustSummary {
  /** Overall trust classification */
  classification: TrustClassification;
  /** Whether this result can be compared to other results */
  canCompare: boolean;
  /** Whether this result can be used in a quality gate */
  canGate: boolean;
  /** Reasons for the trust classification */
  reasons: string[];
}

/** Diagnostics from the resolution and acquisition pipeline */
export interface ResolutionDiagnostics {
  /** Stage reached in acquisition pipeline */
  acquisitionStage: AcquisitionStage;
  /** Strategy that produced the final result */
  chosenStrategy: string;
  /** All strategies attempted during resolution */
  attemptedStrategies: string[];
  /** Number of declaration files found */
  declarationCount: number;
  /** Stage where failure occurred, if any */
  failureStage?: AcquisitionStage | undefined;
  /** Error message from the failure stage, if any */
  failureReason?: string | undefined;
}

/** Category of degradation explaining why an analysis could not complete normally */
export type DegradedCategory =
  | "invalid-package-spec"
  | "unsupported-package-layout"
  | "missing-declarations"
  | "partial-graph-resolution"
  | "install-failure"
  | "insufficient-surface"
  | "confidence-collapse"
  | "workspace-discovery-failure";

/** Scope of the analysis — what kind of target was analyzed */
export type AnalysisScope = "package" | "source" | "workspace" | "self";

/** Severity class for monorepo violations */
export type ViolationSeverity = "critical" | "high" | "medium" | "low";

// --- Applicability ---

/** Whether a dimension is meaningful for a given library */
export type Applicability = "applicable" | "not_applicable" | "insufficient_evidence";

/** Granular scenario applicability status */
export type ScenarioApplicabilityStatus =
  | "applicable"
  | "applicable_but_weak"
  | "insufficient_evidence"
  | "not_applicable";

// --- Analysis Profiles ---

/** Analysis profile determining scoring behavior and report mode */
export type AnalysisProfile = "library" | "package" | "application" | "autofix-agent";

// --- Boundary Finding Categories ---

/** Category of boundary finding for classification */
export type BoundaryFindingCategory =
  | "library-public-boundary"
  | "application-runtime-boundary"
  | "tooling-trusted-local"
  | "cross-package-trust-boundary";

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
  | "queue"
  | "database"
  | "sdk"
  | "trusted-local"
  | "unknown";

// --- Fixability ---

/** How directly fixable an issue is */
export type FixabilityKind = "direct" | "indirect" | "external" | "not_actionable";

// --- File Origin ---

/** Classification of a file's origin for signal hygiene filtering */
export type FileOrigin = "source" | "generated" | "dist" | "vendor" | "test" | "config";

// --- Ownership ---

/** Who owns the code where an issue originates */
export type OwnershipClass =
  | "source-owned"
  | "workspace-owned"
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
  | "export-vagueness"
  | "unsafe-external-input"
  | "architecture-bypass"
  | "declaration-drift"
  | "missing-strict-config"
  | "unresolved-package-surface"
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
  | "insert-satisfies"
  | "wrap-json-parse"
  | "add-env-parsing"
  | "narrow-overloads"
  | "hoist-validation"
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
  | "expected-generic-density"
  | "self-referential-false-positive"
  | "lexical-only-match"
  | "non-applicable-dimension"
  | "scenario-domain-ambiguity"
  | "expected-domain-complexity"
  | "internal-tooling-pattern";

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
  /** How types are provided — always present */
  typesSource: "bundled" | "@types" | "mixed" | "unknown";
  /** Module system of the package */
  moduleKind?: "esm" | "cjs" | "dual" | "unknown";
  /** How entrypoints were resolved — always present */
  entrypointStrategy: "exports-map" | "types-field" | "main-field" | "fallback-glob" | "unknown";
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
  boundaryType: BoundaryType;
  description: string;
  file: string;
  /** Category of boundary finding for classification */
  findingCategory?: BoundaryFindingCategory | undefined;
  hasValidation: boolean;
  line: number;
  trustLevel: TrustLevel;
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

// --- Noise Summary ---

/** Noise accounting: how many issues come from generated/non-source files */
export interface NoiseSummary {
  /** Total issues from generated/dist/vendor/config files */
  generatedIssueCount: number;
  /** Ratio of generated issues to total issues (0-1) */
  generatedIssueRatio: number;
  /** Issues from source-origin files only */
  sourceOwnedIssueCount: number;
  /** Issues suppressed because they came from generated/non-source files */
  suppressedGeneratedCount: number;
  /** File paths excluded from ranked findings due to origin classification */
  excludedPaths: string[];
}

// --- Actionability Summary ---

/** Summary of actionability across all issues */
export interface ActionabilitySummary {
  /** Total actionable issues (source-owned, not suppressed) */
  actionableIssueCount: number;
  /** Actionable issues with high confidence (>=0.7) */
  highConfidenceActionableCount: number;
  /** Actionable issues from source-origin files */
  sourceOwnedActionableCount: number;
  /** Directly fixable issues */
  directlyFixableCount: number;
  /** Actionability score (0-1): ratio of actionable to total */
  actionabilityScore: number;
}

// --- Boundary Hotspot Summary ---

/** Summary of boundary hotspot risk for a single file */
export interface BoundaryHotspotSummary {
  /** Aggregate hotspot risk score */
  hotspotScore: number;
  /** File path */
  file: string;
  /** Boundary types present in this file */
  boundaryTypes: BoundaryType[];
  /** Number of unvalidated boundaries */
  unvalidatedCount: number;
  /** Number of critical (untrusted-external) boundaries */
  criticalBoundaryCount: number;
  /** Recommended fix approach */
  recommendedFixKind: SuggestedFixKind;
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
  /** Human-readable dimension label (e.g., "API Safety") */
  dimension: string;
  /** Canonical dimension key (e.g., "apiSafety") — stable across versions */
  dimensionKey?: string;
  /** Stable identifier for this issue (deterministic across runs) */
  issueId?: string;
  /** Confidence in this finding (0-1) */
  confidence?: number;
  /** Who owns the code where this issue originates */
  ownership?: OwnershipClass;
  /** File origin classification for signal hygiene */
  fileOrigin?: FileOrigin;
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
  /** Impact on decision-making if this issue is fixed */
  decisionImpact?: "high" | "medium" | "low";
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
  /** Granular applicability status for this scenario evaluation */
  scenarioApplicability?: ScenarioApplicabilityStatus;
  /** Scenario variant used for this evaluation */
  scenarioVariant?: ScenarioVariant;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  score: number;
  reason: string;
  /** Granular outcome for this scenario test (backward compatible — derived from passed if absent) */
  outcome?: ScenarioResultOutcome | undefined;
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
  /** Analysis schema version — always present */
  analysisSchemaVersion: string;
  /** Status of the analysis */
  status: AnalysisStatus;
  /** How comparable these scores are to other results */
  scoreValidity: ScoreValidity;
  /** If degraded, why */
  degradedReason?: string;
  /** If degraded, the category of degradation */
  degradedCategory?: DegradedCategory;
  /** Chain of reasons leading to degradation (most specific first) */
  degradedReasonChain?: string[];
  /** Scope of the analysis target */
  analysisScope?: AnalysisScope;
  mode: AnalysisMode;
  scoreProfile: "source-project" | "published-declarations";
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;
  composites: CompositeScore[];
  dimensions: DimensionResult[];
  caveats: string[];
  topIssues: Issue[];
  /** Structured global scores — always present */
  globalScores: GlobalScores;
  /** Analysis profile — always present */
  profileInfo: ProfileInfo;
  /** Resolved package identity — always present */
  packageIdentity: PackageIdentity;
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
  /** Confidence summary across all layers — always present */
  confidenceSummary: ConfidenceSummary;
  /** Source-mode-specific confidence metrics */
  sourceModeConfidence?: SourceModeConfidence | undefined;
  /** Coverage diagnostics — reachable files, positions, undersampling — always present */
  coverageDiagnostics: CoverageDiagnostics;
  explainability?: ExplainabilityReport;
  /** Summary of evidence quality across scoring layers — always present */
  evidenceSummary: EvidenceSummary;
  /** Role breakdown of exported declarations */
  roleBreakdown?: { role: ExportRole; count: number; avgCentrality: number }[];
  benchmarkDiagnostics?: BenchmarkDiagnostics;
  scenarioDiagnostics?: {
    scenarioPack: string;
    failures: { scenario: string; expected: string; actual: string }[];
  };
  /** Boundary analysis summary */
  boundarySummary?: BoundarySummary;
  /** Autofix-agent summary with actionable issues and fix batches */
  autofixSummary?: AutofixSummary;
  /** Noise summary: source-vs-generated issue accounting */
  noiseSummary?: NoiseSummary | undefined;
  /** Actionability summary across all issues */
  actionabilitySummary?: ActionabilitySummary | undefined;
  /** Boundary-specific quality score */
  boundaryQuality?: BoundaryQualityScore;
  /** Fixability meta-score */
  fixabilityScore?: FixabilityScore;
  /** Suppressions applied during analysis */
  suppressions?: SuppressionEntry[];
  /** Fix plan for agent consumption */
  fixPlan?: FixPlan;
  /** Why no fix batches were emitted (when autofixSummary has empty batches) */
  autofixAbstentionReason?: string;
  /** Boundary report for boundaries command */
  boundaryReport?: BoundaryReport;
  /** Verification plan for post-fix validation */
  verificationPlan?: VerificationPlan;
  /** Trust summary — classifies the result as trusted, directional, or abstained */
  trustSummary?: TrustSummary;
  /** Resolution diagnostics — traces the acquisition pipeline */
  resolutionDiagnostics?: ResolutionDiagnostics;
  /** Top boundary hotspots ranked by risk */
  boundaryHotspots?: BoundaryHotspot[];
  /** Concrete next-action recommendations (max 3) */
  recommendations?: Recommendation[];
  /** Recommended fixes for boundary hotspots */
  boundaryRecommendedFixes?: BoundaryRecommendedFix[];
  /** Issue clusters for human-facing summary */
  issueClusters?: IssueCluster[];
  /** Adoption-grade library inspection report (package mode) */
  inspectionReport?: LibraryInspectionReport;
}

export interface PrecisionFeatures {
  score: number;
  containsAny: boolean;
  containsUnknown: boolean;
  features: string[];
  reasons: string[];
  /** Per-feature counts for density calculation */
  featureCounts?: Record<string, number>;
  /** Property paths where 'any' was found (e.g., [[".opts", "[index]", "any"]]) */
  anyPaths?: string[][];
  /** If 'any' originates from a dependency type, the source info */
  anyOrigin?: { sourceFilePath: string; packageName: string | undefined };
  /** Fraction of child positions containing 'any' (0-1). Only set for compound types. */
  anyDensity?: number;
  /** Fraction of child positions containing 'unknown' (0-1). Only set for compound types. */
  unknownDensity?: number;
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
  samplingClass: "complete" | "compact" | "compact-complete" | "compact-partial" | "undersampled";
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

// --- Configuration ---

/** Project-level configuration loaded from typegrade.config.ts */
export interface TypegradeConfig {
  /** Domain mode override */
  domain?: "auto" | "off" | DomainKey;
  /** Analysis profile override */
  profile?: AnalysisProfile;
  /** Boundary policy configuration */
  boundaries?: BoundaryPolicyConfig;
  /** Monorepo layering configuration */
  monorepo?: MonorepoConfig;
  /** Suppression overrides */
  suppressions?: SuppressionOverrides;
  /** Minimum score for CI gate */
  minScore?: number;
}

/** Boundary policy configuration */
export interface BoundaryPolicyConfig {
  /** Trust zone definitions mapping paths to trust levels */
  trustZones?: TrustZoneDefinition[];
  /** Boundary validation policies */
  policies?: BoundaryPolicyRule[];
}

/** A named trust zone mapping file paths to a trust level */
export interface TrustZoneDefinition {
  name: string;
  paths: string[];
  trustLevel: TrustLevel;
}

/** A validation policy for a specific boundary type */
export interface BoundaryPolicyRule {
  name: string;
  source: BoundaryType;
  requiresValidation: boolean;
  severity: "error" | "warning" | "info";
}

/** Monorepo configuration */
export interface MonorepoConfig {
  /** Layer assignments for packages */
  layers?: Record<string, PackageLayer>;
  /** Allowed layer dependencies (source → targets) */
  allowedDependencies?: Record<PackageLayer, PackageLayer[]>;
}

/** Suppression budget overrides */
export interface SuppressionOverrides {
  /** Maximum suppressed issues per category before warning */
  budgets?: Record<string, number>;
  /** Categories that must never grow (budget = 0 growth) */
  protectedCategories?: string[];
}

// --- Boundary Flow Analysis ---

/** Classification of a data ingress source */
export type BoundarySource =
  | "http-input"
  | "env-var"
  | "filesystem-read"
  | "queue-payload"
  | "database-result"
  | "json-parse"
  | "sdk-response"
  | "ipc-message"
  | "ui-input";

/** A single step in a taint propagation chain */
export interface TaintFlowStep {
  kind: "assignment" | "return" | "parameter" | "property-access" | "wrapper";
  file: string;
  line: number;
  expression: string;
}

/** A validation or sanitization sink that terminates a taint chain */
export interface ValidationSink {
  kind:
    | "schema-parser"
    | "type-guard"
    | "assert-function"
    | "branded-constructor"
    | "encoding-helper";
  file: string;
  line: number;
  expression: string;
}

/** A complete taint flow chain from source to sink */
export interface TaintFlowChain {
  isValidated: boolean;
  /** Provenance of the taint — where it originates in the trust model */
  provenance?: "external-input" | "parsed-data" | "cross-boundary" | "internal" | undefined;
  sink?: ValidationSink;
  source: BoundarySource;
  sourceExpression: string;
  sourceFile: string;
  sourceLine: number;
  steps: TaintFlowStep[];
}

/** Boundary report for the boundaries command */
export interface BoundaryReport {
  summary: BoundarySummary;
  quality: BoundaryQualityScore;
  taintChains: TaintFlowChain[];
  hotspots: BoundaryHotspot[];
  trustZoneCrossings: TrustZoneCrossing[];
  policyViolations: BoundaryPolicyViolation[];
}

/** A hotspot where unvalidated data crosses trust boundaries */
export interface BoundaryHotspot {
  file: string;
  line: number;
  boundaryType: BoundaryType;
  trustLevel: TrustLevel;
  riskScore: number;
  description: string;
}

/** A trust zone crossing event */
export interface TrustZoneCrossing {
  fromZone: string;
  toZone: string;
  file: string;
  line: number;
  dataFlow: string;
}

/** A boundary policy violation */
export interface BoundaryPolicyViolation {
  policy: string;
  file: string;
  line: number;
  boundaryType: BoundaryType;
  severity: "error" | "warning" | "info";
  description: string;
}

// --- Fix Planning ---

/** Category of safe, deterministic fixes */
export type SafeFixCategory =
  | "add-explicit-return-type"
  | "replace-any-with-unknown"
  | "insert-satisfies"
  | "wrap-json-parse"
  | "add-env-parsing"
  | "narrow-overloads"
  | "hoist-validation";

/** Fix application mode */
export type FixMode = "safe" | "review";

/** A planned fix batch with confidence and verification metadata */
export interface FixPlanBatch {
  id: string;
  title: string;
  rationale: string;
  targetFiles: string[];
  issueIds: string[];
  risk: "low" | "medium" | "high";
  expectedImpact: number;
  requiresPublicApiChange: boolean;
  requiresHumanReview: boolean;
  /** Confidence that this fix is correct (0-1) */
  confidence: number;
  /** Expected score uplift from this batch */
  expectedScoreUplift: number;
  /** Commands to verify the fix */
  verificationCommands: string[];
  /** Rollback instructions */
  rollbackNotes: string;
  /** IDs of batches that must be applied first */
  dependsOn: string[];
  /** Category of safe fix, if applicable */
  fixCategory?: SafeFixCategory;
}

/** Complete fix plan with ordered batches and verification */
export interface FixPlan {
  batches: FixPlanBatch[];
  totalExpectedUplift: number;
  verificationCommands: string[];
  rollbackNotes: string[];
  analysisSchemaVersion: string;
}

/** Result of applying fixes */
export interface FixApplicationResult {
  applied: { batchId: string; filesModified: string[] }[];
  skipped: { batchId: string; reason: string }[];
  verificationPassed: boolean;
  scoreBefore: number;
  scoreAfter: number | null;
}

// --- Monorepo Analysis ---

/** Layer classification for a package in a monorepo */
export type PackageLayer = "app" | "domain" | "infra" | "ui" | "data" | "shared" | "tooling";

/** A layer dependency violation */
export interface LayerViolation {
  sourcePackage: string;
  targetPackage: string;
  sourceLayer: PackageLayer;
  targetLayer: PackageLayer;
  importPath: string;
  violationType: "forbidden-cross-layer" | "infra-bypass" | "unstable-leak" | "trust-zone-crossing";
  /** Severity of this violation */
  severity: ViolationSeverity;
}

/** Summary of violation severity distribution */
export interface ViolationSeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Summary of monorepo health derived from violation analysis */
export interface MonorepoHealthSummary {
  totalPackages: number;
  totalViolations: number;
  violationsByType: Record<string, number>;
  /** Severity distribution of violations */
  violationSeveritySummary: ViolationSeveritySummary;
  /** Violations per package (normalized density) */
  violationDensity: number;
  healthScore: number;
  healthGrade: Grade;
  /** Confidence in the workspace discovery and classification */
  workspaceConfidence: number;
  /** Confidence in the layer model assignment */
  layerModelConfidence: number;
}

/** Cross-package boundary summary for monorepo mode */
export interface CrossPackageBoundarySummary {
  affectedPackages: string[];
  highRiskCrossings: number;
  totalCrossings: number;
  /** Overall severity of trust gaps across packages */
  trustGapSeverity?: "none" | "low" | "moderate" | "high";
}

/** Monorepo analysis report */
export interface MonorepoReport {
  analysisSchemaVersion: string;
  packages: MonorepoPackageInfo[];
  violations: LayerViolation[];
  layerGraph: Record<string, string[]>;
  healthSummary?: MonorepoHealthSummary;
  /** Cross-package boundary summary */
  crossPackageBoundarySummary?: CrossPackageBoundarySummary;
}

/** Package info within a monorepo */
export interface MonorepoPackageInfo {
  name: string;
  layer: PackageLayer;
  path: string;
  dependencies: string[];
}

// --- Diff Analysis ---

/** Result of comparing two analysis runs */
export interface DiffResult {
  analysisSchemaVersion: string;
  baseline: AnalysisResult;
  target: AnalysisResult;
  compositeDiffs: CompositeDiff[];
  dimensionDiffs: DimensionDiff[];
  newIssues: Issue[];
  resolvedIssues: Issue[];
  worsenedIssues: Issue[];
  /** Confidence drift between baseline and target */
  confidenceDrift?: number;
  /** Boundary coverage change */
  boundaryCoverageDelta?: number;
  /** Whether degraded-result rate increased */
  degradedRateIncreased?: boolean;
  summary: string;
}

/** Score diff for a composite */
export interface CompositeDiff {
  key: CompositeKey;
  baseline: number;
  target: number;
  delta: number;
}

/** Score diff for a dimension */
export interface DimensionDiff {
  key: string;
  label: string;
  baseline: number;
  target: number;
  delta: number;
}

// --- Comparison Decision ---

/** Outcome of a package comparison decision */
export type ComparisonOutcome =
  | "clear-winner"
  | "marginal-winner"
  | "equivalent"
  | "incomparable"
  | "abstained";

/** Why a comparison could not produce a decision */
export type AbstentionKind =
  | "degraded-analysis"
  | "domain-mismatch"
  | "both-directional"
  | "low-evidence"
  | "low-codebase-relevance"
  | "both-require-human-review";

/** Status of comparability between two results */
export type ComparabilityStatus =
  | "fully-comparable"
  | "cross-domain-forced"
  | "directional-only"
  | "not-comparable";

/** Provenance trace for a single metric used in the decision */
export interface MetricProvenance {
  /** Which metric this traces */
  metric: string;
  /** Inputs that contributed to this metric */
  inputs: string[];
  /** Penalties applied during scoring */
  penaltiesApplied: string[];
  /** Confidence in this particular metric (0-1) */
  confidence: number;
}

/** A single metric delta between two packages */
export interface MetricDelta {
  /** Metric name */
  metric: string;
  /** Value for package A */
  valueA: number | null;
  /** Value for package B */
  valueB: number | null;
  /** Absolute delta (A - B) */
  delta: number | null;
  /** Whether this delta is significant (above noise threshold) */
  significant: boolean;
}

/** Full decision report from a package comparison */
export interface ComparisonDecisionReport {
  /** Decision outcome */
  outcome: ComparisonOutcome;
  /** Winning package name (null if equivalent/incomparable/abstained) */
  winner: string | null;
  /** Decision-adjusted score for package A */
  decisionScoreA: number | null;
  /** Decision-adjusted score for package B */
  decisionScoreB: number | null;
  /** Confidence in the decision (0-1) */
  decisionConfidence: number;
  /** Reasons the decision cannot be made (for incomparable/abstained) */
  blockingReasons: string[];
  /** Top reasons supporting the decision */
  topReasons: string[];
  /** Per-metric deltas */
  metricDeltas: MetricDelta[];
  /** Provenance for each metric used */
  metricProvenance: MetricProvenance[];
  /** Trust summaries for both packages */
  trustA?: TrustSummary;
  trustB?: TrustSummary;
  /** Why the comparison was abstained or blocked */
  abstentionKind?: AbstentionKind;
  /** Status of comparability between the two results */
  comparabilityStatus?: ComparabilityStatus;
}

// --- Source Mode Confidence ---

/** Source-mode-specific confidence metrics */
export interface SourceModeConfidence {
  declarationEmitSuccess: number;
  fixabilityRate: number;
  ownershipClarity: number;
  sourceFileCoverage: number;
  sourceOwnedExportCoverage: number;
}

// --- Verification ---

/** A verification plan for post-fix validation */
export interface VerificationPlan {
  commands: VerificationCommand[];
  expectedOutcome: string;
}

/** A single verification command */
export interface VerificationCommand {
  command: string;
  description: string;
  mustPass: boolean;
}

// --- Evaluation Summary (WS9) ---

/** Aggregate metrics across the evaluation corpus */
export interface EvalAggregateMetrics {
  confidenceCalibration: number;
  degradedRate: number;
  domainCoverageRate: number;
  fallbackRate: number;
  issueNoiseRate: number;
  monorepoTrustCalibration: number;
  scenarioCoverageRate: number;
  schemaConsistencyRate: number;
  sourceModeSuccessRate: number;
}

/** Result of a single evaluation gate */
export interface EvalGateResult {
  metric: number;
  name: string;
  passed: boolean;
  threshold: number;
}

/** Redacted evaluation summary — no per-package scores visible to builder */
export interface RedactedEvalSummary {
  /** Aggregate metrics (no per-package breakdown) */
  aggregateMetrics: EvalAggregateMetrics;
  /** Date the evaluation was run */
  evaluatedAt: string;
  /** Aggregate gate results */
  gates: EvalGateResult[];
  /** Schema version used */
  schemaVersion: string;
  /** Total packages evaluated */
  totalPackages: number;
}

/** Shadow-latest comparison result */
export interface ShadowLatestResult {
  /** Current version metrics */
  current: EvalAggregateMetrics;
  /** Per-metric deltas */
  deltas: Partial<Record<keyof EvalAggregateMetrics, number>>;
  /** Whether any metric regressed beyond threshold */
  hasRegression: boolean;
  /** Which metrics regressed */
  regressions: string[];
  /** Previous (shadow) version metrics */
  shadow: EvalAggregateMetrics;
}

// --- Recommendations ---

// --- Issue Clusters ---

/** Cluster category for grouping related issues */
export type ClusterCategory =
  | "soundness"
  | "public-surface"
  | "boundary-validation"
  | "publish-declaration"
  | "scenario-evidence"
  | "agent-ergonomics";

/** Clustered issue summary for human and agent consumption */
export interface IssueCluster {
  /** Cluster identifier */
  clusterId: string;
  /** Cluster category */
  category: ClusterCategory;
  /** Human-readable title */
  title: string;
  /** Why this cluster matters */
  whyItMatters: string;
  /** Files affected by this cluster */
  affectedFiles: string[];
  /** Total issue count in this cluster */
  issueCount: number;
  /** Up to 3 sample issues from the cluster */
  sampleIssues: Issue[];
  /** Expected metric impact if cluster is fully resolved */
  expectedMetricImpact: string;
  /** Suggested fix strategy for agent consumption */
  agentFixStrategy: string;
}

// --- Library Inspection Report (Adoption-Grade) ---

/** Risk cluster for adoption decisions */
export interface AdoptionRiskCluster {
  /** Risk type */
  risk: string;
  /** Risk severity */
  severity: "high" | "medium" | "low";
  /** Human-readable description */
  description: string;
  /** Can the consuming team mitigate this? */
  mitigable: boolean;
  /** Mitigation strategy if applicable */
  mitigation?: string;
}

/** Library inspection report for adoption decisions */
export interface LibraryInspectionReport {
  /** Overall adoption readiness score (0-100) */
  candidateSuitability: number;
  /** Human-readable adoption summary */
  adoptionSummary: string;
  /** Adoption risks with mitigations */
  adoptionRisks: AdoptionRiskCluster[];
  /** APIs that are safe to use without wrappers */
  safeSubset: string[];
  /** Required wrappers for unsafe APIs */
  requiredWrappers: string[];
  /** APIs that should be banned (too unsafe) */
  bannedApis: string[];
  /** Evidence quality for this assessment */
  evidenceQuality: number;
  /** Issue clusters summarizing the library's type health */
  issueClusters: IssueCluster[];
}

/** Impact class for a recommendation */
export type ImpactClass = "high" | "medium" | "low";

/** A concrete next-action recommendation */
export interface Recommendation {
  /** What to do */
  action: string;
  /** Why this matters */
  reason: string;
  /** Expected impact class */
  impact: ImpactClass;
  /** Category of recommendation */
  category: "soundness" | "boundary" | "public-surface" | "general";
}

// --- Boundary Recommended Fix ---

/** A recommended fix for a boundary hotspot */
export interface BoundaryRecommendedFix {
  /** File containing the hotspot */
  file: string;
  /** Line number */
  line: number;
  /** Boundary type */
  boundaryType: BoundaryType;
  /** Concrete fix description */
  fix: string;
  /** Fix category */
  fixKind: SuggestedFixKind;
  /** Risk score of the hotspot being fixed */
  riskScore: number;
}

// --- Agent Acceptance and Abort ---

/** An acceptance check for a fix batch */
export interface AcceptanceCheck {
  /** Command to run */
  command: string;
  /** What the command should produce */
  expectedOutcome: string;
  /** Whether this check must pass */
  mustPass: boolean;
}

/** A condition under which the agent should abort */
export interface AbortCondition {
  /** What to check */
  condition: string;
  /** Why this should cause an abort */
  reason: string;
}

// --- Fit-Compare (Codebase-Aware Library Comparison) ---

/** Risk of migrating to a candidate library */
export interface MigrationRiskReport {
  /** Risk from API shape mismatches */
  apiMismatchRisk: "low" | "medium" | "high";
  /** Risk from typing differences */
  typingRisk: "low" | "medium" | "high";
  /** Risk from boundary handling differences */
  boundaryRisk: "low" | "medium" | "high";
  /** Estimated number of files to modify */
  estimatedTouchPoints: number;
  /** Estimated number of fix batches needed */
  estimatedBatchCount: number;
  /** Whether human review is required */
  requiresHumanReview: boolean;
}

/** Fit signal for a candidate relative to a codebase */
export interface FitSignal {
  /** Name of the signal */
  name: string;
  /** Score contribution (0-100) */
  score: number;
  /** Human-readable explanation */
  explanation: string;
}

/** Per-candidate fit assessment */
export interface CandidateFitAssessment {
  /** Package name */
  packageName: string;
  /** Package analysis result */
  result: AnalysisResult;
  /** Decision score from comparison engine */
  decisionScore: number | null;
  /** Domain compatibility with the codebase */
  domainCompatibility: number;
  /** Fit signals computed from codebase context */
  fitSignals: FitSignal[];
  /** Migration risk assessment */
  migrationRisk: MigrationRiskReport;
  /** Overall fit score (0-100) */
  fitScore: number;
  /** Codebase relevance score (0-100) */
  codebaseRelevance?: number;
  /** Evidence supporting the relevance score */
  relevanceEvidence?: string[];
}

/** Decision from a fit-compare analysis */
export interface FitCompareDecision {
  /** Recommendation outcome */
  outcome: ComparisonOutcome;
  /** Winning candidate (null if equivalent/abstained) */
  winner: string | null;
  /** Confidence in the decision (0-1) */
  decisionConfidence: number;
  /** Blocking reasons for incomparable/abstained outcomes */
  blockingReasons: string[];
  /** Top reasons supporting the decision */
  topReasons: string[];
  /** Why the comparison was abstained or blocked */
  abstentionKind?: AbstentionKind;
  /** Status of comparability between the two results */
  comparabilityStatus?: ComparabilityStatus;
}

/** Result of a codebase-aware library fit comparison */
export interface FitCompareResult {
  /** Schema version */
  analysisSchemaVersion: string;
  /** First candidate assessment */
  candidateA: CandidateFitAssessment;
  /** Second candidate assessment */
  candidateB: CandidateFitAssessment;
  /** Codebase analysis result */
  codebase: AnalysisResult;
  /** Adoption decision */
  adoptionDecision: FitCompareDecision;
  /** First migration batches for the winning candidate */
  firstMigrationBatches: string[];
}

// --- Scenario Result Outcome ---

/** Granular outcome for an individual scenario test */
export type ScenarioResultOutcome =
  | "passed"
  | "failed"
  | "not_applicable"
  | "insufficient_evidence";

// --- Analysis Schema ---

/** Current schema version for analysis output */
export const ANALYSIS_SCHEMA_VERSION = "0.13.0";
