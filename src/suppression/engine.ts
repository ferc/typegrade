import type { AnalysisProfile, Issue, SuppressionCategory, SuppressionEntry } from "../types.js";
import {
  PROFILE_SUPPRESSION_CONFIGS,
  type SuppressionConfig,
  type SuppressionContext,
} from "./types.js";

const LEXICAL_PATTERNS = [/naming convention/i, /inconsistent case/i];

const INTERNAL_TOOLING_PATTERNS = [/[/\\]scripts[/\\]/, /[/\\]tools[/\\]/, /\.config\./];

/** TypeScript internal declaration name patterns that produce self-referential false positives */
const SELF_REFERENTIAL_DECLARATION_PATTERNS = [
  /^__type$/,
  /^__event$/,
  /^__module$/,
  /^_default$/,
  /^__[a-zA-Z]+$/,
];

const EXPECTED_COMPLEXITY_DOMAINS = new Set(["schema", "stream"]);

/** Options for the suppression engine */
export interface ApplySuppressionOptions {
  configOverride?: Partial<SuppressionConfig>;
  context?: SuppressionContext;
}

/**
 * Apply suppressions to a list of issues based on the profile config.
 *
 * Returns the filtered issues and a list of suppression records.
 * Suppressions never silently raise scores — they only remove or demote findings.
 */
export function applySuppressions(
  issues: Issue[],
  profile: AnalysisProfile,
  options?: ApplySuppressionOptions,
): { filtered: Issue[]; suppressions: SuppressionEntry[] } {
  const baseConfig: SuppressionConfig = PROFILE_SUPPRESSION_CONFIGS[profile];
  const config: SuppressionConfig = options?.configOverride
    ? { ...baseConfig, ...options.configOverride }
    : baseConfig;
  const context = options?.context;

  const filtered: Issue[] = [];
  const suppressions: SuppressionEntry[] = [];

  for (let idx = 0; idx < issues.length; idx++) {
    const issue = issues[idx]!;
    const suppression = evaluateSuppression(issue, config, context);

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
  context?: SuppressionContext,
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

  // Self-referential false positive: issue file is the project's own declaration file
  if (
    config.suppressSelfReferential &&
    context?.selfDeclarationFile &&
    issue.file === context.selfDeclarationFile
  ) {
    return {
      category: "self-referential-false-positive",
      confidence: 0.9,
      reason: "Issue in project's own declaration file — self-referential false positive",
    };
  }

  // Lexical-only match: issue is purely about naming/style
  if (config.suppressLexicalOnly) {
    for (const pattern of LEXICAL_PATTERNS) {
      if (pattern.test(issue.message)) {
        return {
          category: "lexical-only-match",
          confidence: 0.85,
          reason: `Lexical-only finding: ${issue.message.slice(0, 80)}`,
        };
      }
    }
  }

  // Non-applicable dimension: issue comes from a dimension marked as not applicable
  if (config.suppressNonApplicable && context?.dimensions) {
    const dimEntry = context.dimensions.find((dd) => dd.key === issue.dimension);
    if (
      dimEntry &&
      (dimEntry.applicability === "not_applicable" ||
        dimEntry.applicability === "insufficient_evidence")
    ) {
      return {
        category: "non-applicable-dimension",
        confidence: 0.8,
        reason: `Dimension "${issue.dimension}" is ${dimEntry.applicability}`,
      };
    }
  }

  // Internal tooling pattern: issue in scripts/, tools/, or .config. files
  if (config.suppressInternalTooling) {
    for (const pattern of INTERNAL_TOOLING_PATTERNS) {
      if (pattern.test(issue.file)) {
        return {
          category: "internal-tooling-pattern",
          confidence: 0.75,
          reason: `Issue in internal tooling file: ${issue.file}`,
        };
      }
    }
  }

  // Expected domain complexity: surface complexity in domains known for it
  if (
    config.suppressExpectedComplexity &&
    context?.domain &&
    EXPECTED_COMPLEXITY_DOMAINS.has(context.domain) &&
    /surface complexity/i.test(issue.message)
  ) {
    return {
      category: "expected-domain-complexity",
      confidence: 0.7,
      reason: `Expected complexity in ${context.domain} domain`,
    };
  }

  // Lexical self-referential: issue message references a TS internal declaration name
  if (config.suppressSelfReferential) {
    for (const pattern of SELF_REFERENTIAL_DECLARATION_PATTERNS) {
      if (pattern.test(issue.message)) {
        return {
          category: "self-referential-false-positive",
          confidence: 0.85,
          reason: `Declaration name matches internal pattern: ${issue.message.slice(0, 60)}`,
        };
      }
    }
  }

  // Ambiguous ownership: generated/vendor-origin files with non-error severity
  if (
    issue.fileOrigin &&
    (issue.fileOrigin === "generated" || issue.fileOrigin === "vendor") &&
    issue.severity !== "error"
  ) {
    return {
      category: "ambiguous-ownership",
      confidence: 0.8,
      reason: `Non-error issue in ${issue.fileOrigin}-origin file: ${issue.file}`,
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
