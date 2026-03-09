import type { ActionabilitySummary, FileOrigin, Issue, NoiseSummary } from "../types.js";
import { classifyFileOrigin } from "./classifier.js";

/** Options for filtering issues by signal hygiene */
export interface IssueFilterOptions {
  /** Include generated/dist/vendor/config-origin issues (default: false) */
  includeGenerated?: boolean;
  /** Minimum confidence threshold (default: 0, no filtering) */
  minConfidence?: number;
  /** Include indirect-fixability issues (default: true) */
  includeIndirect?: boolean;
  /** Maximum issues to return (default: unlimited) */
  budget?: number;
}

/** Result of filtering issues with noise and actionability accounting */
export interface IssueFilterResult {
  /** Issues that passed all filters */
  actionable: Issue[];
  /** Noise summary for the full set */
  noiseSummary: NoiseSummary;
  /** Actionability summary */
  actionabilitySummary: ActionabilitySummary;
}

/** File origins considered non-source noise */
const NOISE_ORIGINS = new Set<FileOrigin>(["generated", "dist", "vendor", "config"]);

/**
 * Filter issues by origin, ownership, confidence, and fixability.
 *
 * Computes NoiseSummary and ActionabilitySummary as side outputs.
 * This consolidates the duplicate filtering logic from agent/report.ts
 * and fix/planner.ts into one shared function.
 */
export function filterIssues(issues: Issue[], options?: IssueFilterOptions): IssueFilterResult {
  const includeGenerated = options?.includeGenerated ?? false;
  const minConfidence = options?.minConfidence ?? 0;
  const includeIndirect = options?.includeIndirect ?? true;
  const budget = options?.budget;

  // Ensure all issues have fileOrigin set
  for (const issue of issues) {
    if (!issue.fileOrigin) {
      issue.fileOrigin = classifyFileOrigin(issue.file);
    }
  }

  // Compute noise metrics
  const excludedPathSet = new Set<string>();
  let generatedIssueCount = 0;
  let sourceOwnedIssueCount = 0;

  for (const issue of issues) {
    const origin = issue.fileOrigin ?? "source";
    if (NOISE_ORIGINS.has(origin)) {
      generatedIssueCount++;
      excludedPathSet.add(issue.file);
    } else if (origin === "source") {
      sourceOwnedIssueCount++;
    }
  }

  const noiseSummary: NoiseSummary = {
    excludedPaths: [...excludedPathSet].toSorted(),
    generatedIssueCount,
    generatedIssueRatio: issues.length > 0 ? generatedIssueCount / issues.length : 0,
    sourceOwnedIssueCount,
    suppressedGeneratedCount: includeGenerated ? 0 : generatedIssueCount,
  };

  // Filter issues
  const actionable: Issue[] = [];
  let highConfidenceCount = 0;
  let sourceOwnedActionableCount = 0;
  let directlyFixableCount = 0;

  for (const issue of issues) {
    // Suppressed issues are never actionable
    if (issue.suppressionReason) {
      continue;
    }

    // File-origin filter
    if (!includeGenerated) {
      const origin = issue.fileOrigin ?? "source";
      if (NOISE_ORIGINS.has(origin)) {
        continue;
      }
    }

    // Ownership gate: only source-owned or workspace-owned
    if (
      issue.ownership &&
      issue.ownership !== "source-owned" &&
      issue.ownership !== "workspace-owned"
    ) {
      continue;
    }

    // Confidence gate
    if (minConfidence > 0 && issue.confidence !== undefined && issue.confidence < minConfidence) {
      continue;
    }

    // Fixability gate
    if (issue.fixability) {
      if (issue.fixability === "not_actionable" || issue.fixability === "external") {
        continue;
      }
      if (issue.fixability === "indirect" && !includeIndirect) {
        continue;
      }
    }

    actionable.push(issue);

    // Track actionability metrics
    if (issue.confidence === undefined || issue.confidence >= 0.7) {
      highConfidenceCount++;
    }
    if (issue.fileOrigin === "source" || issue.fileOrigin === undefined) {
      sourceOwnedActionableCount++;
    }
    if (issue.fixability === "direct" || !issue.fixability) {
      directlyFixableCount++;
    }
  }

  // Apply budget
  let budgeted = actionable;
  if (budget !== undefined && actionable.length > budget) {
    budgeted = actionable
      .toSorted((lhs, rhs) => (rhs.agentPriority ?? 0) - (lhs.agentPriority ?? 0))
      .slice(0, budget);
  }

  const actionabilitySummary: ActionabilitySummary = {
    actionabilityScore: issues.length > 0 ? budgeted.length / issues.length : 0,
    actionableIssueCount: budgeted.length,
    directlyFixableCount,
    highConfidenceActionableCount: highConfidenceCount,
    sourceOwnedActionableCount,
  };

  return { actionabilitySummary, actionable: budgeted, noiseSummary };
}
