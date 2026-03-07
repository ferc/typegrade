/** The precision level of a single resolved type */
export type TypePrecisionLevel =
  | "any"
  | "unknown"
  | "wide-primitive"
  | "primitive-union"
  | "generic-unbound"
  | "interface"
  | "enum"
  | "generic-bound"
  | "literal"
  | "template-literal"
  | "literal-union"
  | "branded"
  | "discriminated-union"
  | "never";

/** Result from a single analyzer dimension */
export interface DimensionResult {
  name: string;
  score: number; // 0-100
  weight: number; // 0-1
  details: string[];
  issues: Issue[];
}

export interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  dimension: string;
}

/** Final output */
export interface AnalysisResult {
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;
  overallScore: number; // 0-100
  grade: string;
  dimensions: DimensionResult[];
  topIssues: Issue[];
  aiReadiness: "HIGH" | "MODERATE" | "LOW" | "POOR";
}

export interface TsguardConfig {
  weights: {
    typeCoverage: number;
    strictConfig: number;
    typePrecision: number;
    unsoundness: number;
    runtimeValidation: number;
    exportQuality: number;
  };
  include: string[];
  exclude: string[];
  thresholds: {
    literalUnionMaxMembers: number;
    minScore: number;
  };
}
