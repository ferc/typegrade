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

// Stable public types
export type {
  AnalysisMode,
  AnalysisResult,
  Applicability,
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
  GlobalScores,
  Grade,
  Issue,
  PackageIdentity,
  RoleClassification,
  ScenarioScore,
  ScoreComparability,
} from "./types.js";
