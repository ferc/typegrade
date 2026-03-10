// Public library API — no CLI side effects on import
export { analyzeBoundariesOnly, analyzeProject, normalizeResult } from "./analyzer.js";
export type { BoundaryOnlyResult } from "./analyzer.js";
export { scorePackage } from "./package-scorer.js";
export type { ScorePackageOptions } from "./package-scorer.js";
export {
  renderDimensionTable,
  renderExplainability,
  renderJson,
  renderReport,
} from "./utils/format.js";
export { comparePackages } from "./compare.js";
export type { CompareResult, CompareOptions } from "./compare.js";
export { fitCompare } from "./fit-compare.js";
export type { FitCompareOptions } from "./fit-compare.js";

// Signal hygiene: file-origin classification and issue filtering
export { classifyFileOrigin } from "./origin/index.js";
export { filterIssues } from "./origin/index.js";
export type { IssueFilterOptions, IssueFilterResult } from "./origin/index.js";

// Agent and profile APIs
export { buildAgentReport, enrichFixBatches, renderAgentJson } from "./agent/index.js";
export type {
  AgentReport,
  EnrichedFixBatch,
  FixBatchDiff,
  RollbackRisk,
  StopCondition,
} from "./agent/index.js";
export { detectProfile, gatherProfileSignals } from "./profiles/index.js";
export { resolveFileOwnership } from "./ownership/index.js";
export {
  buildBoundaryGraph,
  buildBoundarySummary,
  computeBoundaryQuality,
} from "./boundaries/index.js";
export { applySuppressions } from "./suppression/index.js";

// Fix planning and application
export { buildFixPlan } from "./fix/planner.js";
export { applyFixes } from "./fix/applier.js";

// Diff analysis
export { computeDiff, loadAnalysisSnapshot, renderDiffReport } from "./diff.js";

// Boundary flow analysis
export { buildTaintFlowChains } from "./boundaries/flow.js";
export { computeBoundaryHotspots, evaluateBoundaryPolicies } from "./boundaries/policy.js";

// Monorepo analysis
export { analyzeMonorepo } from "./monorepo/index.js";

// Configuration
export { loadConfig } from "./config.js";

// Constants
export { ANALYSIS_SCHEMA_VERSION } from "./types.js";

// Smart CLI
export { classifyTarget, isLocalTarget, isPackageTarget } from "./cli-targets.js";
export type { ClassifiedTarget, TargetKind } from "./cli-targets.js";
export { runSmart, SmartUsageError } from "./cli-smart.js";
export type { SmartDispatchResult, SmartOptions } from "./cli-smart.js";

// Stable public types
export type {
  AbortCondition,
  AcceptanceCheck,
  ActionabilitySummary,
  AcquisitionStage,
  AnalysisMode,
  AnalysisProfile,
  AnalysisResult,
  AnalysisScope,
  AnalysisStatus,
  Applicability,
  AutofixSummary,
  BoundaryHotspotSummary,
  BoundaryFindingCategory,
  BoundaryHotspot,
  BoundaryInventoryEntry,
  BoundaryPolicyConfig,
  BoundaryPolicyViolation,
  BoundaryQualityScore,
  BoundaryRecommendedFix,
  BoundaryReport,
  BoundarySource,
  BoundarySummary,
  BoundaryType,
  CentralityWeight,
  AbstentionKind,
  ComparabilityStatus,
  ComparisonDecisionReport,
  ComparisonOutcome,
  CompositeDiff,
  CompositeKey,
  CompositeScore,
  CrossPackageBoundarySummary,
  ConfidenceBottleneck,
  ConfidenceSignal,
  ConfidenceSummary,
  CoverageDiagnostics,
  CoverageFailureMode,
  DeclEmitDiagnostic,
  DegradedCategory,
  DiffResult,
  DimensionDiff,
  DimensionResult,
  DomainKey,
  DomainScore,
  EvalAggregateMetrics,
  EvalGateResult,
  ExecutionDiagnostics,
  EvidenceSummary,
  ExplainabilityReport,
  ExportRole,
  FileOrigin,
  FixabilityKind,
  FixabilityScore,
  FitCompareDecision,
  FitCompareResult,
  FitSignal,
  FixApplicationResult,
  FixBatch,
  FixMode,
  FixPlan,
  FixPlanBatch,
  GlobalScores,
  Grade,
  AdoptionRiskCluster,
  ClusterCategory,
  ImpactClass,
  Issue,
  IssueCluster,
  LibraryInspectionReport,
  CandidateFitAssessment,
  LayerViolation,
  MigrationComplexity,
  MigrationRiskReport,
  MetricDelta,
  MetricProvenance,
  MonorepoConfig,
  MonorepoHealthSummary,
  MonorepoPackageInfo,
  MonorepoReport,
  NoiseSummary,
  OwnershipClass,
  PackageIdentity,
  PackageLayer,
  ProfileInfo,
  Recommendation,
  RedactedEvalSummary,
  ResolutionDiagnostics,
  ResultKind,
  ResourceWarning,
  RoleClassification,
  RootCauseCategory,
  SafeFixCategory,
  ScenarioApplicabilityStatus,
  ScenarioResultOutcome,
  ScenarioScore,
  ScenarioVariant,
  ScoreComparability,
  ScoreValidity,
  ScorecardEntry,
  ShadowLatestResult,
  SmartCliResult,
  SmartComparePayload,
  SmartMode,
  SmartNextAction,
  SmartSummary,
  SmartSupplements,
  SmartTargetKind,
  SourceModeConfidence,
  SuggestedFixKind,
  SuppressionCategory,
  SuppressionEntry,
  SuppressionOverrides,
  TaintFlowChain,
  TaintFlowStep,
  DecisionGrade,
  TrustClassification,
  TrustLevel,
  TrustSummary,
  TrustZoneCrossing,
  TrustZoneDefinition,
  TypegradeConfig,
  ValidationSink,
  VerificationCommand,
  VerificationPlan,
  ViolationSeverity,
  ViolationSeveritySummary,
} from "./types.js";
