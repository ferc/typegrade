import type { EnrichedFixBatch, FixBatchDiff, RollbackRisk } from "./types.js";
import type { FixBatch, Issue } from "../types.js";
import { dirname } from "node:path";

/**
 * Group related issues into fix batches for sequential agent execution.
 *
 * Grouping strategy:
 * 1. Group by file (issues in the same file are likely related)
 * 2. Within a file, group by dimension
 * 3. Assign risk based on whether public API changes are needed
 * 4. Order by expected impact (high confidence + high severity first)
 */
export function groupFixBatches(issues: Issue[], opts?: { clusterByModule?: boolean }): FixBatch[] {
  // Group by file (or module directory) + dimension
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const fileKey = opts?.clusterByModule ? dirname(issue.file) : issue.file;
    const key = `${fileKey}::${issue.dimension}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      groups.set(key, [issue]);
    }
  }

  const batches: FixBatch[] = [];
  let batchIndex = 0;

  for (const [groupKey, groupIssues] of groups) {
    const [fileOrDir, dimension] = groupKey.split("::");
    if (!fileOrDir || !dimension) {
      continue;
    }

    // Determine risk
    const hasPublicApiIssue = groupIssues.some(
      (iss) =>
        iss.suggestedFixKind === "add-overload" ||
        iss.suggestedFixKind === "strengthen-generic" ||
        iss.suggestedFixKind === "add-type-annotation",
    );
    const risk = computeBatchRisk(groupIssues, hasPublicApiIssue);

    // Compute expected impact from agent priorities
    const avgPriority =
      groupIssues.reduce((sum, iss) => sum + (iss.agentPriority ?? 50), 0) / groupIssues.length;
    const expectedImpact = Math.round(avgPriority * groupIssues.length * 0.1);

    const requiresHumanReview =
      hasPublicApiIssue ||
      groupIssues.some((iss) => iss.fixability === "indirect") ||
      risk === "high";

    // Collect unique target files (may differ from fileOrDir in module-cluster mode)
    const targetFiles = [...new Set(groupIssues.map((iss) => iss.file))];
    const displayName = fileOrDir.split("/").pop() ?? fileOrDir;

    batchIndex++;
    batches.push({
      expectedImpact,
      id: `batch-${batchIndex}`,
      issueIds: groupIssues.map((iss) => `${iss.file}:${iss.line}:${iss.column}`),
      rationale: `Fix ${groupIssues.length} ${dimension} issue(s) in ${displayName}`,
      requiresHumanReview,
      requiresPublicApiChange: hasPublicApiIssue,
      risk,
      targetFiles,
      title: `${dimension}: ${groupIssues.length} fix(es) in ${displayName}`,
    });
  }

  // Sort by expected impact (descending), then risk (ascending)
  const riskOrder: Record<string, number> = { high: 2, low: 0, medium: 1 };
  batches.sort((lhs, rhs) => {
    const impactDiff = rhs.expectedImpact - lhs.expectedImpact;
    if (impactDiff !== 0) {
      return impactDiff;
    }
    return (riskOrder[lhs.risk] ?? 1) - (riskOrder[rhs.risk] ?? 1);
  });

  return batches;
}

function computeBatchRisk(issues: Issue[], hasPublicApiChange: boolean): "low" | "medium" | "high" {
  if (hasPublicApiChange) {
    return "high";
  }

  const hasHighSeverity = issues.some((iss) => iss.severity === "error");
  const hasExternalDeps = issues.some(
    (iss) => iss.fixability === "external" || iss.ownership === "dependency-owned",
  );

  if (hasExternalDeps) {
    return "high";
  }
  if (hasHighSeverity) {
    return "medium";
  }
  return "low";
}

/**
 * Determine execution order for batches.
 * Low-risk, high-impact batches go first.
 */
export function computeExecutionOrder(batches: FixBatch[]): string[] {
  // Already sorted by impact/risk in groupFixBatches
  return batches.map((batch) => batch.id);
}

/**
 * Enrich fix batches with estimated score deltas and verification commands.
 */
export function enrichFixBatches(batches: FixBatch[], issues: Issue[]): EnrichedFixBatch[] {
  // Build a lookup from issue ID to issue for severity counting
  const issueById = new Map<string, Issue>();
  for (const issue of issues) {
    const id = `${issue.file}:${issue.line}:${issue.column}`;
    issueById.set(id, issue);
  }

  return batches.map((batch) => {
    // Count error and warning issues in this batch
    let errorCount = 0;
    let warningCount = 0;
    for (const issueId of batch.issueIds) {
      const issue = issueById.get(issueId);
      if (issue?.severity === "error") {
        errorCount++;
      } else if (issue?.severity === "warning") {
        warningCount++;
      }
    }

    // Estimate score delta: errors worth 2 points, warnings worth 1
    const expectedScoreDelta = Math.min(errorCount * 2 + warningCount, 15);

    // Compute expected diffs
    const expectedDiffs = computeExpectedDiffs(batch, issueById);

    // Compute rollback risk
    const rollbackRisk = computeRollbackRisk(batch, issueById);

    return {
      ...batch,
      expectedDiffs,
      expectedScoreDelta,
      rollbackRisk,
      verificationCommands: ["npx tsc --noEmit"],
    };
  });
}

function computeExpectedDiffs(batch: FixBatch, issueById: Map<string, Issue>): FixBatchDiff[] {
  // Group issues by file to produce per-file diffs
  const fileIssues = new Map<string, Issue[]>();
  for (const issueId of batch.issueIds) {
    const issue = issueById.get(issueId);
    if (!issue) {
      continue;
    }
    const existing = fileIssues.get(issue.file);
    if (existing) {
      existing.push(issue);
    } else {
      fileIssues.set(issue.file, [issue]);
    }
  }

  const diffs: FixBatchDiff[] = [];
  for (const [file, issues] of fileIssues) {
    const dimensions = [...new Set(issues.map((iss) => iss.dimension))];
    diffs.push({
      changeDescription: `Fix ${issues.length} ${dimensions.join(", ")} issue(s)`,
      file,
      linesAffected: issues.length,
    });
  }

  return diffs;
}

function computeRollbackRisk(batch: FixBatch, issueById: Map<string, Issue>): RollbackRisk {
  const affectsPublicApi = batch.requiresPublicApiChange;
  const affectsTests = batch.targetFiles.some(
    (tf) => tf.includes(".test.") || tf.includes(".spec.") || tf.includes("__tests__"),
  );

  // Count high-severity issues
  let errorCount = 0;
  for (const issueId of batch.issueIds) {
    const issue = issueById.get(issueId);
    if (issue?.severity === "error") {
      errorCount++;
    }
  }

  let level: RollbackRisk["level"] = "trivial";
  let reason = "Low-risk internal changes only";

  if (affectsPublicApi && errorCount > 0) {
    level = "dangerous";
    reason = "Modifies public API with error-severity issues";
  } else if (affectsPublicApi) {
    level = "caution";
    reason = "Modifies public API surface";
  } else if (errorCount > 0 || affectsTests) {
    level = "safe";
    reason = affectsTests ? "Modifies test files" : "Internal changes with error-severity issues";
  } else {
    level = "trivial";
    reason = "Low-risk internal changes only";
  }

  return { affectsPublicApi, affectsTests, level, reason };
}
