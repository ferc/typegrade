import type { AnalysisProfile, Issue, SuppressionCategory, SuppressionEntry } from "../types.js";
import { PROFILE_SUPPRESSION_CONFIGS, type SuppressionConfig } from "./types.js";

/**
 * Apply suppressions to a list of issues based on the profile config.
 *
 * Returns the filtered issues and a list of suppression records.
 * Suppressions never silently raise scores — they only remove or demote findings.
 */
export function applySuppressions(
  issues: Issue[],
  profile: AnalysisProfile,
  configOverride?: Partial<SuppressionConfig>,
): { filtered: Issue[]; suppressions: SuppressionEntry[] } {
  const baseConfig: SuppressionConfig = PROFILE_SUPPRESSION_CONFIGS[profile];
  const config: SuppressionConfig = configOverride
    ? { ...baseConfig, ...configOverride }
    : baseConfig;

  const filtered: Issue[] = [];
  const suppressions: SuppressionEntry[] = [];

  for (let idx = 0; idx < issues.length; idx++) {
    const issue = issues[idx]!;
    const suppression = evaluateSuppression(issue, config);

    if (suppression) {
      suppressions.push({
        category: suppression.category,
        confidence: suppression.confidence,
        issueIndex: idx,
        reason: suppression.reason,
      });
      // Mark the issue as suppressed but still include it with suppressionReason
      filtered.push({
        ...issue,
        suppressionReason: suppression.reason,
      });
    } else {
      filtered.push(issue);
    }
  }

  return { filtered, suppressions };
}

function evaluateSuppression(
  issue: Issue,
  config: SuppressionConfig,
): { category: SuppressionCategory; reason: string; confidence: number } | null {
  // Low confidence suppression
  if (
    config.suppressLowEvidence &&
    issue.confidence !== undefined &&
    issue.confidence < config.minConfidence
  ) {
    return {
      category: "low-evidence",
      confidence: 1 - issue.confidence,
      reason: `Confidence ${issue.confidence.toFixed(2)} below threshold ${config.minConfidence}`,
    };
  }

  // Dependency-owned suppression
  if (config.suppressDependencyOwned && issue.ownership === "dependency-owned") {
    return {
      category: "dependency-owned-opaque",
      confidence: 0.85,
      reason: "Issue in dependency-owned code",
    };
  }

  // Generated file suppression
  if (config.suppressGenerated && issue.ownership === "generated") {
    return {
      category: "generated-artifact",
      confidence: 0.8,
      reason: "Issue in generated code",
    };
  }

  // Trusted local suppression (for boundary-related issues)
  if (config.suppressTrustedLocal && issue.boundaryType && issue.boundaryType === "trusted-local") {
    return {
      category: "trusted-local-tooling",
      confidence: 0.75,
      reason: "Trusted local boundary — suppressed in agent mode",
    };
  }

  // Boundary type non-applicable suppression
  if (issue.boundaryType === "config" && issue.severity === "warning") {
    return {
      category: "non-applicable-boundary",
      confidence: 0.7,
      reason: "Config boundary warning — low risk in context",
    };
  }

  return null;
}

/**
 * Summarize suppression results for reporting.
 */
export function summarizeSuppressions(
  suppressions: SuppressionEntry[],
): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const sup of suppressions) {
    counts.set(sup.category, (counts.get(sup.category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .toSorted((lhs, rhs) => rhs.count - lhs.count);
}
