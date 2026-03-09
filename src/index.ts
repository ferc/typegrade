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

// Stable public types
export type {
  AnalysisMode,
  AnalysisProfile,
  AnalysisResult,
  Applicability,
  AutofixSummary,
  BoundaryInventoryEntry,
  BoundaryQualityScore,
  BoundarySummary,
  BoundaryType,
  CentralityWeight,
  CompositeKey,
  CompositeScore,
  ConfidenceSignal,
  ConfidenceSummary,
  CoverageDiagnostics,
  DimensionResult,
  DomainKey,
  DomainScore,
  EvidenceSummary,
  ExplainabilityReport,
  ExportRole,
  FixabilityKind,
  FixabilityScore,
  FixBatch,
  GlobalScores,
  Grade,
  Issue,
  OwnershipClass,
  PackageIdentity,
  ProfileInfo,
  RoleClassification,
  RootCauseCategory,
  ScenarioScore,
  ScoreComparability,
  SuggestedFixKind,
  SuppressionCategory,
  SuppressionEntry,
  TrustLevel,
} from "./types.js";
