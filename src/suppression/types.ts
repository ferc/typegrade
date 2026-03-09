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
}

/** Default suppression config per profile */
export const PROFILE_SUPPRESSION_CONFIGS: Record<AnalysisProfile, SuppressionConfig> = {
  application: {
    minConfidence: 0.4,
    suppressDependencyOwned: true,
    suppressGenerated: true,
    suppressLowEvidence: false,
    suppressTrustedLocal: false,
  },
  "autofix-agent": {
    minConfidence: 0.7,
    suppressDependencyOwned: true,
    suppressGenerated: true,
    suppressLowEvidence: true,
    suppressTrustedLocal: true,
  },
  library: {
    minConfidence: 0.3,
    suppressDependencyOwned: true,
    suppressGenerated: true,
    suppressLowEvidence: false,
    suppressTrustedLocal: false,
  },
  package: {
    minConfidence: 0.3,
    suppressDependencyOwned: true,
    suppressGenerated: true,
    suppressLowEvidence: false,
    suppressTrustedLocal: false,
  },
};
