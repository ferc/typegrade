// Public library API — no CLI side effects on import
export { analyzeProject } from "./analyzer.js";
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

// Agent and profile APIs
export { buildAgentReport, renderAgentJson } from "./agent/index.js";
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
export { computeDiff, renderDiffReport } from "./diff.js";

// Boundary flow analysis
export { buildTaintFlowChains } from "./boundaries/flow.js";
export { computeBoundaryHotspots, evaluateBoundaryPolicies } from "./boundaries/policy.js";

// Monorepo analysis
export { analyzeMonorepo } from "./monorepo/index.js";

// Configuration
export { loadConfig } from "./config.js";

// Constants
export { ANALYSIS_SCHEMA_VERSION } from "./types.js";

// Stable public types
export type {
  AnalysisMode,
  AnalysisProfile,
  AnalysisResult,
  Applicability,
  AutofixSummary,
  BoundaryHotspot,
  BoundaryInventoryEntry,
  BoundaryPolicyConfig,
  BoundaryPolicyViolation,
  BoundaryQualityScore,
  BoundaryReport,
  BoundarySource,
  BoundarySummary,
  BoundaryType,
  CentralityWeight,
  CompositeDiff,
  CompositeKey,
  CompositeScore,
  ConfidenceSignal,
  ConfidenceSummary,
  CoverageDiagnostics,
  CoverageFailureMode,
  DiffResult,
  DimensionDiff,
  DimensionResult,
  DomainKey,
  DomainScore,
  EvidenceSummary,
  ExplainabilityReport,
  ExportRole,
  FixabilityKind,
  FixabilityScore,
  FixApplicationResult,
  FixBatch,
  FixMode,
  FixPlan,
  FixPlanBatch,
  GlobalScores,
  Grade,
  Issue,
  LayerViolation,
  MonorepoConfig,
  MonorepoPackageInfo,
  MonorepoReport,
  OwnershipClass,
  PackageIdentity,
  PackageLayer,
  ProfileInfo,
  RoleClassification,
  RootCauseCategory,
  SafeFixCategory,
  ScenarioScore,
  ScenarioVariant,
  ScoreComparability,
  SuggestedFixKind,
  SuppressionCategory,
  SuppressionEntry,
  SuppressionOverrides,
  TaintFlowChain,
  TaintFlowStep,
  TrustLevel,
  TrustZoneCrossing,
  TrustZoneDefinition,
  TypegradeConfig,
  ValidationSink,
  VerificationCommand,
  VerificationPlan,
} from "./types.js";
