import type { AgentReport, StopCondition } from "./types.js";
import type { AnalysisResult, AutofixSummary, Issue } from "../types.js";
import { computeExecutionOrder, enrichFixBatches, groupFixBatches } from "./fix-batch.js";

/**
 * Build an agent-oriented report from an analysis result.
 *
 * Filters to only high-confidence, source-owned, directly fixable findings.
 * Groups into fix batches and suggests execution order.
 */
/** Maximum actionable issues to include in agent report */
const AGENT_ISSUE_BUDGET = 50;

export function buildAgentReport(
  result: AnalysisResult,
  opts?: { minConfidence?: number; includeIndirect?: boolean; issueBudget?: number },
): AgentReport {
  // Degraded results must never emit fix batches.
  // Also block on ambiguous/low-confidence analyses to prevent agent churn.
  const allNullScores = result.composites.every((comp) => comp.score === null);
  const isLowConfidence = result.confidenceSummary
    ? (result.confidenceSummary.graphResolution +
        result.confidenceSummary.sampleCoverage +
        result.confidenceSummary.domainInference) /
        3 <
      0.3
    : false;

  if ((result.status === "degraded" && allNullScores) || result.status === "degraded") {
    return {
      actionableIssues: [],
      enrichedBatches: [],
      executionOrder: [],
      expectedScoreImprovement: 0,
      fixBatches: [],
      stopConditions: [
        {
          kind: "no-actionable-issues",
          met: true,
          reason: `Analysis is degraded: ${result.degradedReason ?? "unknown reason"}. No fix batches emitted.`,
        },
      ],
      suppressedCount: 0,
      suppressionReasons: [],
      verificationSteps: [],
    };
  }

  // Very low confidence: block fix batches even on "complete" analyses
  if (isLowConfidence && result.scoreValidity === "not-comparable") {
    return {
      actionableIssues: [],
      enrichedBatches: [],
      executionOrder: [],
      expectedScoreImprovement: 0,
      fixBatches: [],
      stopConditions: [
        {
          kind: "no-actionable-issues",
          met: true,
          reason: `Analysis confidence too low for fix batches (scoreValidity: ${result.scoreValidity}). No fix batches emitted.`,
        },
      ],
      suppressedCount: 0,
      suppressionReasons: [],
      verificationSteps: [],
    };
  }

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

    // Ownership gate: only source-owned or workspace-owned
    if (
      issue.ownership &&
      issue.ownership !== "source-owned" &&
      issue.ownership !== "workspace-owned"
    ) {
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

  // Apply issue budget — prioritize by agentPriority, then cap
  const budget = opts?.issueBudget ?? AGENT_ISSUE_BUDGET;
  const budgetedIssues = actionableIssues
    .toSorted((lhs, rhs) => (rhs.agentPriority ?? 0) - (lhs.agentPriority ?? 0))
    .slice(0, budget);

  // Count suppressions (includes budget-trimmed issues)
  const suppressedCount = allIssues.length - budgetedIssues.length;
  const suppressionReasons = computeSuppressionBreakdown(allIssues, budgetedIssues);

  // Group into fix batches
  const fixBatches = groupFixBatches(budgetedIssues);
  const executionOrder = computeExecutionOrder(fixBatches);

  // Enrich batches with score deltas and verification commands
  const enrichedBatches = enrichFixBatches(fixBatches, budgetedIssues);

  // Estimate total score improvement
  const expectedScoreImprovement = estimateScoreImprovement(budgetedIssues, allIssues.length);

  // Compute stop conditions
  const stopConditions = computeStopConditions(budgetedIssues, expectedScoreImprovement);

  // Default verification steps for the entire report
  const verificationSteps = ["npx tsc --noEmit", "npx vitest run", "npx typegrade analyze --json"];

  return {
    actionableIssues: budgetedIssues,
    enrichedBatches,
    executionOrder,
    expectedScoreImprovement,
    fixBatches,
    stopConditions,
    suppressedCount,
    suppressionReasons,
    verificationSteps,
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

function computeStopConditions(
  actionableIssues: Issue[],
  expectedScoreImprovement: number,
): StopCondition[] {
  return [
    {
      kind: "no-actionable-issues",
      met: actionableIssues.length === 0,
      reason:
        actionableIssues.length === 0
          ? "No actionable issues remain"
          : `${actionableIssues.length} actionable issue(s) remain`,
    },
    {
      kind: "diminishing-returns",
      met: expectedScoreImprovement < 2,
      reason:
        expectedScoreImprovement < 2
          ? `Expected improvement (${expectedScoreImprovement}) is below threshold of 2`
          : `Expected improvement of ${expectedScoreImprovement} points`,
    },
    {
      kind: "all-batches-applied",
      met: false,
      reason: "No batches have been applied yet",
    },
    {
      kind: "score-target-met",
      met: false,
      reason: "No score target defined",
    },
  ];
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
      enrichedBatches: report.enrichedBatches,
      executionOrder: report.executionOrder,
      expectedScoreImprovement: report.expectedScoreImprovement,
      fixBatches: report.fixBatches,
      issues: report.actionableIssues,
      stopConditions: report.stopConditions,
      suppressedCount: report.suppressedCount,
      suppressionReasons: report.suppressionReasons,
      verificationSteps: report.verificationSteps,
    },
    null,
    2,
  );
}
