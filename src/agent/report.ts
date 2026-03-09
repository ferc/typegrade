import type { AbortCondition, AnalysisResult, AutofixSummary, Issue } from "../types.js";
import type { AgentReport, EnrichedFixBatch, StopCondition } from "./types.js";
import { computeExecutionOrder, enrichFixBatches, groupFixBatches } from "./fix-batch.js";
import { filterIssues } from "../origin/filter.js";

/**
 * Build an agent-oriented report from an analysis result.
 *
 * Filters to only high-confidence, source-owned, directly fixable findings.
 * Groups into fix batches and suggests execution order.
 */
/** Maximum actionable issues to include in agent report */
const AGENT_ISSUE_BUDGET = 50;
/** Maximum actionable issues in strict agent mode (--agent flag) */
const AGENT_STRICT_BUDGET = 25;
/** Minimum confidence for agent mode (higher than default) */
const AGENT_MIN_CONFIDENCE = 0.7;

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
    const abstentionReason = `Analysis is degraded: ${result.degradedReason ?? "unknown reason"}. No fix batches emitted.`;
    return {
      abortSignals: [{ condition: "Analysis is degraded", reason: abstentionReason }],
      abstentionReason,
      actionableIssues: [],
      enrichedBatches: [],
      executionOrder: [],
      expectedScoreImprovement: 0,
      fixBatches: [],
      stopConditions: [
        {
          kind: "no-actionable-issues",
          met: true,
          reason: abstentionReason,
        },
      ],
      suppressedCount: 0,
      suppressionReasons: [],
      verificationSteps: [],
    };
  }

  // Very low confidence: block fix batches even on "complete" analyses
  if (isLowConfidence && result.scoreValidity === "not-comparable") {
    const abstentionReason = `Analysis confidence too low for fix batches (scoreValidity: ${result.scoreValidity}). No fix batches emitted.`;
    return {
      abortSignals: [{ condition: "Confidence too low", reason: abstentionReason }],
      abstentionReason,
      actionableIssues: [],
      enrichedBatches: [],
      executionOrder: [],
      expectedScoreImprovement: 0,
      fixBatches: [],
      stopConditions: [
        {
          kind: "no-actionable-issues",
          met: true,
          reason: abstentionReason,
        },
      ],
      suppressedCount: 0,
      suppressionReasons: [],
      verificationSteps: [],
    };
  }

  const minConfidence = opts?.minConfidence ?? AGENT_MIN_CONFIDENCE;
  const includeIndirect = opts?.includeIndirect ?? false;

  // Collect all issues from dimensions
  const allIssues = result.dimensions.flatMap((dim) => dim.issues);

  // Filter to actionable issues using shared signal-hygiene filter
  const { actionable: actionableIssues } = filterIssues(allIssues, {
    includeGenerated: false,
    includeIndirect,
    minConfidence,
  });

  // Apply source-mode priority boost when analyzing own source
  const isSourceMode = result.analysisScope === "source" || result.analysisScope === "self";
  if (isSourceMode) {
    for (const issue of actionableIssues) {
      issue.agentPriority = (issue.agentPriority ?? 50) + computeSourceModeIssuePriority(issue);
    }
  }

  // Apply issue budget — prioritize by agentPriority, then cap
  // Use stricter budget when analysis is source/self mode (agent is operating on own code)
  const isStrictMode = isSourceMode;
  const budget = opts?.issueBudget ?? (isStrictMode ? AGENT_STRICT_BUDGET : AGENT_ISSUE_BUDGET);
  const budgetedIssues = actionableIssues
    .toSorted((lhs, rhs) => (rhs.agentPriority ?? 0) - (lhs.agentPriority ?? 0))
    .slice(0, budget);

  // Count suppressions (includes budget-trimmed issues)
  const suppressedCount = allIssues.length - budgetedIssues.length;
  const suppressionReasons = computeSuppressionBreakdown(allIssues, budgetedIssues);

  // Group into fix batches (cluster by module directory in source mode)
  const fixBatches = groupFixBatches(
    budgetedIssues,
    isSourceMode ? { clusterByModule: true } : undefined,
  );
  const executionOrder = computeExecutionOrder(fixBatches);

  // Enrich batches with score deltas and verification commands
  const enrichedBatches = enrichFixBatches(fixBatches, budgetedIssues);

  // Estimate total score improvement
  const expectedScoreImprovement = estimateScoreImprovement(budgetedIssues, allIssues.length);

  // Compute stop conditions
  const stopConditions = computeStopConditions(budgetedIssues, expectedScoreImprovement);

  // Default verification steps for the entire report
  const verificationSteps = ["npx tsc --noEmit", "npx vitest run", "npx typegrade analyze --json"];

  // Build typed verification plan
  const verificationPlan = {
    commands: [
      { command: "npx tsc --noEmit", description: "Type check all files", mustPass: true },
      { command: "npx vitest run", description: "Run test suite", mustPass: true },
      {
        command: "npx typegrade analyze --json",
        description: "Re-score after fixes",
        mustPass: false,
      },
    ],
  };

  // Compute abstention reason when no batches were produced
  let abstentionReason: string | undefined = undefined;
  if (fixBatches.length === 0) {
    if (budgetedIssues.length === 0) {
      abstentionReason =
        allIssues.length === 0
          ? "No issues found in the analysis"
          : `All ${allIssues.length} issues were filtered out (not source-owned, low confidence, or suppressed)`;
    } else {
      abstentionReason = "Actionable issues exist but could not be grouped into fix batches";
    }
  }

  // Select nextBestBatch: highest-impact batch that is low or medium risk
  const nextBestBatch = selectNextBestBatch(enrichedBatches);

  // Build abort signals — conditions where the agent should stop entirely
  const abortSignals = buildAbortSignals(result);

  // Build report trust from the analysis trust summary
  const reportTrust = result.trustSummary;

  return {
    abortSignals,
    ...(abstentionReason === undefined ? {} : { abstentionReason }),
    actionableIssues: budgetedIssues,
    enrichedBatches,
    executionOrder,
    expectedScoreImprovement,
    fixBatches,
    nextBestBatch,
    reportTrust,
    stopConditions,
    suppressedCount,
    suppressionReasons,
    verificationPlan,
    verificationSteps,
  };
}

/**
 * Select the best next batch: highest-impact low-risk batch.
 * If no low-risk batch exists, choose highest-impact medium-risk.
 * Never auto-select high-risk batches.
 */
function selectNextBestBatch(enrichedBatches: EnrichedFixBatch[]): EnrichedFixBatch | undefined {
  // Already sorted by impact desc, risk asc
  const lowRisk = enrichedBatches.find((bb) => bb.risk === "low");
  if (lowRisk) {
    return lowRisk;
  }
  const mediumRisk = enrichedBatches.find((bb) => bb.risk === "medium");
  if (mediumRisk) {
    return mediumRisk;
  }
  // Never auto-select high-risk batches
  return undefined;
}

/**
 * Build abort signals from the analysis result.
 */
function buildAbortSignals(result: AnalysisResult): AbortCondition[] {
  const signals: AbortCondition[] = [
    {
      condition: "Trust becomes abstained after applying fixes",
      reason: "Re-analysis shows abstained trust — further iteration is not justified",
    },
    {
      condition: "TypeScript compilation fails (tsc --noEmit exits non-zero)",
      reason: "Fixes introduced type errors — roll back the last batch",
    },
    {
      condition: "Test suite fails (vitest run exits non-zero)",
      reason: "Fixes broke existing tests — roll back the last batch",
    },
    {
      condition: "Score regresses by more than 5 points after a batch",
      reason: "Fix batch worsened overall quality — roll back and stop",
    },
  ];

  // Add batch-touches-public-API signal when any batch requires human review
  if (result.autofixSummary?.fixBatches.some((bb) => bb.requiresPublicApiChange)) {
    signals.push({
      condition: "Batch modifies public API surface without human review",
      reason: "Public API changes require human approval — do not auto-apply",
    });
  }

  return signals;
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
 * Compute source-mode priority boost for an issue.
 * Boosts priority for source-owned, exported-surface, declaration-affecting,
 * and directly fixable issues.
 */
function computeSourceModeIssuePriority(issue: Issue): number {
  let boost = 0;

  // Source-owned issues are most actionable
  if (issue.ownership === "source-owned") {
    boost += 20;
  }

  // Exported-surface dimensions affect API quality
  if (issue.dimension === "apiSpecificity" || issue.dimension === "semanticLift") {
    boost += 15;
  }

  // Declaration-affecting fix kinds improve type output
  if (
    issue.suggestedFixKind === "add-type-annotation" ||
    issue.suggestedFixKind === "replace-any" ||
    issue.suggestedFixKind === "strengthen-generic"
  ) {
    boost += 10;
  }

  // Directly fixable issues can be resolved immediately
  if (issue.fixability === "direct") {
    boost += 10;
  }

  return boost;
}

/**
 * Render an agent report as JSON suitable for consumption.
 */
export function renderAgentJson(report: AgentReport): string {
  return JSON.stringify(
    {
      abortSignals: report.abortSignals,
      ...(report.abstentionReason === undefined
        ? {}
        : { abstentionReason: report.abstentionReason }),
      actionableIssueCount: report.actionableIssues.length,
      enrichedBatches: report.enrichedBatches,
      executionOrder: report.executionOrder,
      expectedScoreImprovement: report.expectedScoreImprovement,
      fixBatches: report.fixBatches,
      issues: report.actionableIssues,
      nextBestBatch: report.nextBestBatch ?? null,
      reportTrust: report.reportTrust ?? null,
      stopConditions: report.stopConditions,
      suppressedCount: report.suppressedCount,
      suppressionReasons: report.suppressionReasons,
      verificationPlan: report.verificationPlan,
      verificationSteps: report.verificationSteps,
    },
    null,
    2,
  );
}
