import type { AnalysisProfile } from "../types.js";

export type { SuppressionCategory, SuppressionEntry } from "../types.js";

/** Configuration for the suppression engine */
export interface SuppressionConfig {
  /** Whether to suppress trusted-local findings */
  suppressTrustedLocal: boolean;
  /** Whether to suppress dependency-owned findings */
  suppressDependencyOwned: boolean;
  /** Whether to suppress generated file findings */
  suppressGenerated: boolean;
  /** Minimum confidence to keep a finding (below = suppress) */
  minConfidence: number;
  /** Whether to suppress low-evidence findings */
  suppressLowEvidence: boolean;
  /** Whether to suppress self-referential false positives */
  suppressSelfReferential?: boolean;
  /** Whether to suppress lexical-only style matches */
  suppressLexicalOnly?: boolean;
  /** Whether to suppress findings from non-applicable dimensions */
  suppressNonApplicable?: boolean;
  /** Whether to suppress findings in internal tooling files */
  suppressInternalTooling?: boolean;
  /** Whether to suppress expected domain complexity findings */
  suppressExpectedComplexity?: boolean;
}

/** Context for domain-aware suppression rules */
export interface SuppressionContext {
  /** Detected domain for the project */
  domain?: string;
  /** Dimension applicability information */
  dimensions?: { key: string; applicability: string }[];
  /** The project's own declaration file path, if known */
  selfDeclarationFile?: string;
}

/** Default suppression config per profile */
export const PROFILE_SUPPRESSION_CONFIGS: Record<AnalysisProfile, SuppressionConfig> = {
  application: {
    minConfidence: 0.4,
    suppressDependencyOwned: true,
    suppressExpectedComplexity: false,
    suppressGenerated: true,
    suppressInternalTooling: true,
    suppressLexicalOnly: false,
    suppressLowEvidence: false,
    suppressNonApplicable: false,
    suppressSelfReferential: true,
    suppressTrustedLocal: false,
  },
  "autofix-agent": {
    minConfidence: 0.7,
    suppressDependencyOwned: true,
    suppressExpectedComplexity: true,
    suppressGenerated: true,
    suppressInternalTooling: true,
    suppressLexicalOnly: true,
    suppressLowEvidence: true,
    suppressNonApplicable: true,
    suppressSelfReferential: true,
    suppressTrustedLocal: true,
  },
  library: {
    minConfidence: 0.3,
    suppressDependencyOwned: true,
    suppressExpectedComplexity: false,
    suppressGenerated: true,
    suppressInternalTooling: false,
    suppressLexicalOnly: false,
    suppressLowEvidence: false,
    suppressNonApplicable: false,
    suppressSelfReferential: true,
    suppressTrustedLocal: false,
  },
  package: {
    minConfidence: 0.3,
    suppressDependencyOwned: true,
    suppressExpectedComplexity: false,
    suppressGenerated: true,
    suppressInternalTooling: false,
    suppressLexicalOnly: false,
    suppressLowEvidence: false,
    suppressNonApplicable: false,
    suppressSelfReferential: true,
    suppressTrustedLocal: false,
  },
};
