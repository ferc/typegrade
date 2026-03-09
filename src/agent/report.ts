import type { AnalysisResult, AutofixSummary, Issue } from "../types.js";
import { computeExecutionOrder, groupFixBatches } from "./fix-batch.js";
import type { AgentReport } from "./types.js";

/**
 * Build an agent-oriented report from an analysis result.
 *
 * Filters to only high-confidence, source-owned, directly fixable findings.
 * Groups into fix batches and suggests execution order.
 */
export function buildAgentReport(
  result: AnalysisResult,
  opts?: { minConfidence?: number; includeIndirect?: boolean },
): AgentReport {
  const minConfidence = opts?.minConfidence ?? 0.7;
  const includeIndirect = opts?.includeIndirect ?? false;

  // Collect all issues from dimensions
  const allIssues = result.dimensions.flatMap((dim) => dim.issues);

  // Filter to actionable issues
  const actionableIssues = allIssues.filter((issue) => {
    // Must not be suppressed
    if (issue.suppressionReason) {
      return false;
    }

    // Confidence gate
    if (issue.confidence !== undefined && issue.confidence < minConfidence) {
      return false;
    }

    // Ownership gate: only source-owned
    if (issue.ownership && issue.ownership !== "source-owned") {
      return false;
    }

    // Fixability gate: direct or (optionally) indirect
    if (issue.fixability) {
      if (issue.fixability === "not_actionable" || issue.fixability === "external") {
        return false;
      }
      if (issue.fixability === "indirect" && !includeIndirect) {
        return false;
      }
    }

    return true;
  });

  // Count suppressions
  const suppressedCount = allIssues.length - actionableIssues.length;
  const suppressionReasons = computeSuppressionBreakdown(allIssues, actionableIssues);

  // Group into fix batches
  const fixBatches = groupFixBatches(actionableIssues);
  const executionOrder = computeExecutionOrder(fixBatches);

  // Estimate total score improvement
  const expectedScoreImprovement = estimateScoreImprovement(actionableIssues, allIssues.length);

  return {
    actionableIssues,
    executionOrder,
    expectedScoreImprovement,
    fixBatches,
    suppressedCount,
    suppressionReasons,
  };
}

/**
 * Build an autofix summary from an agent report.
 */
export function buildAutofixSummary(report: AgentReport): AutofixSummary {
  return {
    actionableIssues: report.actionableIssues,
    fixBatches: report.fixBatches,
    suppressedCount: report.suppressedCount,
    suppressionReasons: report.suppressionReasons,
  };
}

function computeSuppressionBreakdown(
  allIssues: Issue[],
  actionableIssues: Issue[],
): { category: string; count: number }[] {
  const actionableSet = new Set(actionableIssues);
  const reasons = new Map<string, number>();

  for (const issue of allIssues) {
    if (actionableSet.has(issue)) {
      continue;
    }

    let category = "other";
    if (issue.suppressionReason) {
      category = "explicit-suppression";
    } else if (issue.ownership && issue.ownership !== "source-owned") {
      category = `ownership:${issue.ownership}`;
    } else if (issue.confidence !== undefined && issue.confidence < 0.7) {
      category = "low-confidence";
    } else if (issue.fixability === "not_actionable" || issue.fixability === "external") {
      category = `fixability:${issue.fixability}`;
    }

    reasons.set(category, (reasons.get(category) ?? 0) + 1);
  }

  return [...reasons.entries()]
    .map(([category, count]) => ({ category, count }))
    .toSorted((lhs, rhs) => rhs.count - lhs.count);
}

function estimateScoreImprovement(actionableIssues: Issue[], totalIssueCount: number): number {
  if (totalIssueCount === 0) {
    return 0;
  }

  // Rough estimate: each fixed actionable issue improves score proportionally
  const errorCount = actionableIssues.filter((iss) => iss.severity === "error").length;
  const warningCount = actionableIssues.filter((iss) => iss.severity === "warning").length;

  // Errors are worth more improvement than warnings
  const improvementPoints = errorCount * 3 + Number(warningCount);
  // Cap at 30 points
  return Math.min(Math.round(improvementPoints), 30);
}

/**
 * Render an agent report as JSON suitable for consumption.
 */
export function renderAgentJson(report: AgentReport): string {
  return JSON.stringify(
    {
      actionableIssueCount: report.actionableIssues.length,
      executionOrder: report.executionOrder,
      expectedScoreImprovement: report.expectedScoreImprovement,
      fixBatches: report.fixBatches,
      issues: report.actionableIssues,
      suppressedCount: report.suppressedCount,
      suppressionReasons: report.suppressionReasons,
    },
    null,
    2,
  );
}
