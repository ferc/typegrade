export type AnalysisMode = "source" | "package";
export type CompositeKey = "consumerApi" | "implementationQuality" | "agentReadiness" | "typeSafety";

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
  domainInference?: {
    domain: string;
    confidence: number;
    signals: string[];
    falsePositiveRisk?: number;
    matchedRules?: string[];
    adjustments?: Array<{ dimension: string; adjustment: string; reason: string }>;
  };
  graphStats?: import("./graph/types.js").GraphStats;
  dedupStats?: { groups: number; filesRemoved: number };
  explainability?: ExplainabilityReport;
  benchmarkDiagnostics?: {
    assertionMargins: Array<{ assertion: string; delta: number; minDelta?: number }>;
    rankingLoss?: number;
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
  domainSuppressions: Array<{ name: string; reason: string }>;
  domainAmbiguities: Array<{ domain: string; confidence: number; competingDomain?: string }>;
}

export interface PackageAnalysisContext {
  packageName: string;
  packageRoot: string;
  packageJsonPath: string;
  typesEntrypoint: string | null;
  graphStats?: import("./graph/types.js").GraphStats;
}
