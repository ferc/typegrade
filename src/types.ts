export type AnalysisMode = "source" | "package";
export type CompositeKey = "consumerApi" | "implementationQuality" | "agentReadiness";

export interface CompositeScore {
  key: CompositeKey;
  score: number | null;
  grade: Grade;
  rationale: string[];
  confidence?: number;
}

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F" | "N/A";

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
  domainInference?: { domain: string; confidence: number; signals: string[] };
}

export interface PrecisionFeatures {
  score: number;
  containsAny: boolean;
  containsUnknown: boolean;
  features: string[];
  reasons: string[];
}

export interface PackageAnalysisContext {
  packageName: string;
  packageRoot: string;
  packageJsonPath: string;
  typesEntrypoint: string | null;
  graphStats?: import("./graph/types.js").GraphStats;
}
