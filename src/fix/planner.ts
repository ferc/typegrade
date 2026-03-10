import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type FixPlan,
  type FixPlanBatch,
  type Issue,
  type SafeFixCategory,
  type SuggestedFixKind,
} from "../types.js";
import { filterIssues } from "../origin/filter.js";

/**
 * Map from SuggestedFixKind to SafeFixCategory where there is a safe, deterministic mapping.
 * Not all fix kinds have a safe category — those are left unmapped.
 */
const FIX_KIND_TO_SAFE_CATEGORY: Partial<Record<SuggestedFixKind, SafeFixCategory>> = {
  "add-env-parsing": "add-env-parsing",
  "add-type-annotation": "add-explicit-return-type",
  "hoist-validation": "hoist-validation",
  "insert-satisfies": "insert-satisfies",
  "narrow-overloads": "narrow-overloads",
  "replace-any": "replace-any-with-unknown",
  "wrap-json-parse": "wrap-json-parse",
};

/** Default verification commands appended to every fix plan */
const DEFAULT_VERIFICATION_COMMANDS = [
  "npx tsc --noEmit",
  "npx vitest run",
  "npx typegrade analyze --json",
];

/** Severity weight used for uplift estimation */
const SEVERITY_WEIGHTS: Record<string, number> = {
  error: 3,
  info: 0.5,
  warning: 1.5,
};

/**
 * Build a FixPlan from an AnalysisResult.
 *
 * Filters to source-owned, directly fixable issues, groups them into
 * dependency-ordered batches with confidence and uplift estimates.
 *
 * @example
 * ```ts
 * const plan = buildFixPlan(analysisResult);
 * console.log(plan.totalExpectedUplift);
 * ```
 */
export function buildFixPlan(result: AnalysisResult): FixPlan {
  // Collect all issues from dimensions
  const allIssues = result.dimensions.flatMap((dim) => dim.issues);

  // Filter to source-owned, directly fixable, unsuppressed issues using shared filter
  const { actionable: actionableIssues } = filterIssues(allIssues, {
    includeGenerated: false,
    includeIndirect: false,
  });

  // Group by file + dimension
  const groups = groupByFileDimension(actionableIssues);

  // Build batches from groups
  const batches = buildBatches(groups);

  // Detect inter-batch dependencies
  assignDependencies(batches);

  // Sort: dependencies first, then by expected impact descending
  sortBatches(batches);

  // Compute aggregate plan metadata
  const totalExpectedUplift = batches.reduce((sum, batch) => sum + batch.expectedScoreUplift, 0);

  const rollbackNotes = batches.map((batch) => `[${batch.id}] ${batch.rollbackNotes}`);

  return {
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    batches,
    rollbackNotes,
    totalExpectedUplift: Math.min(totalExpectedUplift, 40),
    verificationCommands: [...DEFAULT_VERIFICATION_COMMANDS],
  };
}

/**
 * Group issues by file path and dimension key.
 */
function groupByFileDimension(issues: Issue[]): Map<string, Issue[]> {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const groupKey = `${issue.file}::${issue.dimension}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(issue);
    } else {
      groups.set(groupKey, [issue]);
    }
  }
  return groups;
}

/**
 * Build FixPlanBatch objects from grouped issues.
 */
function buildBatches(groups: Map<string, Issue[]>): FixPlanBatch[] {
  const batches: FixPlanBatch[] = [];
  let batchIndex = 0;

  for (const [groupKey, groupIssues] of groups) {
    const [filePath, dimension] = groupKey.split("::");
    if (!filePath || !dimension) {
      continue;
    }

    batchIndex++;
    const batchId = `fix-${batchIndex}`;
    const fileName = filePath.split("/").pop() ?? filePath;

    // Compute confidence as average of issue confidences
    const confidence = computeAverageConfidence(groupIssues);

    // Map issues to safe fix category if possible
    const fixCategory = inferFixCategory(groupIssues);

    // Determine risk based on issue characteristics
    const hasPublicApiChange = groupIssues.some(
      (iss) =>
        iss.suggestedFixKind === "add-overload" ||
        iss.suggestedFixKind === "strengthen-generic" ||
        iss.suggestedFixKind === "add-type-annotation",
    );
    const risk = computeRisk(groupIssues, hasPublicApiChange);

    // Estimate score uplift from severity and count
    const expectedScoreUplift = estimateUplift(groupIssues);

    // Compute expected impact (priority-weighted)
    const avgPriority =
      groupIssues.reduce((sum, iss) => sum + (iss.agentPriority ?? 50), 0) / groupIssues.length;
    const expectedImpact = Math.round(avgPriority * groupIssues.length * 0.1);

    const requiresHumanReview = hasPublicApiChange || risk === "high" || !fixCategory;

    const targetFiles = [filePath];
    const batch: FixPlanBatch = {
      agentInstructions: buildBatchAgentInstructions({
        dimension,
        issues: groupIssues,
        risk,
        targetFiles,
      }),
      confidence,
      dependsOn: [],
      expectedImpact,
      expectedScoreUplift,
      id: batchId,
      issueIds: groupIssues.map((iss) => `${iss.file}:${iss.line}:${iss.column}`),
      rationale: `Fix ${groupIssues.length} ${dimension} issue(s) in ${fileName}`,
      requiresHumanReview,
      requiresPublicApiChange: hasPublicApiChange,
      risk,
      rollbackFiles: targetFiles,
      rollbackHint: `Revert ${fileName}: git checkout -- ${filePath}`,
      rollbackNotes: `Revert changes to ${fileName} for batch ${batchId}`,
      targetFiles,
      title: `${dimension}: ${groupIssues.length} fix(es) in ${fileName}`,
      verificationCommands: [...DEFAULT_VERIFICATION_COMMANDS],
      ...(fixCategory ? { fixCategory } : {}),
    };

    batches.push(batch);
  }

  return batches;
}

/**
 * Compute the average confidence across a set of issues.
 * Issues without confidence default to 0.5.
 */
function computeAverageConfidence(issues: Issue[]): number {
  if (issues.length === 0) {
    return 0;
  }
  const total = issues.reduce((sum, iss) => sum + (iss.confidence ?? 0.5), 0);
  return Math.round((total / issues.length) * 100) / 100;
}

/**
 * Infer a SafeFixCategory from the issues in a group.
 * Returns the most common safe category if one dominates, otherwise undefined.
 */
function inferFixCategory(issues: Issue[]): SafeFixCategory | undefined {
  const categoryCounts = new Map<SafeFixCategory, number>();

  for (const issue of issues) {
    if (!issue.suggestedFixKind) {
      continue;
    }
    const safeCategory = FIX_KIND_TO_SAFE_CATEGORY[issue.suggestedFixKind];
    if (safeCategory) {
      categoryCounts.set(safeCategory, (categoryCounts.get(safeCategory) ?? 0) + 1);
    }
  }

  if (categoryCounts.size === 0) {
    return undefined;
  }

  // Return the most frequent safe category
  let bestCategory: SafeFixCategory | undefined = undefined;
  let bestCount = 0;
  for (const [category, count] of categoryCounts) {
    if (count > bestCount) {
      bestCategory = category;
      bestCount = count;
    }
  }

  return bestCategory;
}

/**
 * Compute risk level for a batch based on issue characteristics.
 */
function computeRisk(issues: Issue[], hasPublicApiChange: boolean): "low" | "medium" | "high" {
  if (hasPublicApiChange) {
    return "high";
  }

  const hasErrors = issues.some((iss) => iss.severity === "error");
  if (hasErrors) {
    return "medium";
  }

  return "low";
}

/**
 * Estimate score uplift from a set of issues based on severity distribution.
 */
function estimateUplift(issues: Issue[]): number {
  let uplift = 0;
  for (const issue of issues) {
    const weight = SEVERITY_WEIGHTS[issue.severity] ?? 0.5;
    uplift += weight;
  }
  // Cap per-batch uplift at 10 points
  return Math.min(Math.round(uplift * 10) / 10, 10);
}

/**
 * Collect modifier IDs from a file map that are not the given batch ID.
 */
function collectDependencies(opts: {
  batchId: string;
  issueIds: string[];
  fileToModifiers: Map<string, string[]>;
}): string[] {
  const dependencies = new Set<string>();
  for (const issueId of opts.issueIds) {
    // Issue IDs are formatted as "file:line:column"
    const issueFile = issueId.split(":").slice(0, -2).join(":");
    const modifiers = opts.fileToModifiers.get(issueFile) ?? [];
    for (const modifierId of modifiers) {
      // Do not depend on self
      if (modifierId !== opts.batchId) {
        dependencies.add(modifierId);
      }
    }
  }
  return [...dependencies];
}

/**
 * Detect and assign inter-batch dependencies.
 * Batch B depends on batch A if A modifies a file that B references.
 */
function assignDependencies(batches: FixPlanBatch[]): void {
  // Build a map of file -> batches that modify it
  const fileToModifiers = new Map<string, string[]>();
  for (const batch of batches) {
    for (const targetFile of batch.targetFiles) {
      const existing = fileToModifiers.get(targetFile);
      if (existing) {
        existing.push(batch.id);
      } else {
        fileToModifiers.set(targetFile, [batch.id]);
      }
    }
  }

  // For each batch, check if any of its issue files are modified by another batch
  for (const batch of batches) {
    batch.dependsOn = collectDependencies({
      batchId: batch.id,
      fileToModifiers,
      issueIds: batch.issueIds,
    });
  }
}

/**
 * Sort batches: dependencies first, then by expected score uplift descending.
 * Uses a simple topological awareness: batches with no dependencies come first.
 */
function sortBatches(batches: FixPlanBatch[]): void {
  batches.sort((lhs, rhs) => {
    // Batches with no dependencies come first
    const depDiff = lhs.dependsOn.length - rhs.dependsOn.length;
    if (depDiff !== 0) {
      return depDiff;
    }
    // Then by expected uplift descending
    return rhs.expectedScoreUplift - lhs.expectedScoreUplift;
  });
}

/**
 * Build agent-oriented instructions for a fix plan batch.
 */
function buildBatchAgentInstructions(opts: {
  dimension: string;
  issues: Issue[];
  risk: "low" | "medium" | "high";
  targetFiles: string[];
}): string {
  const { dimension, issues, targetFiles, risk } = opts;
  const lines: string[] = [
    `Fix ${issues.length} ${dimension} issue(s) in ${targetFiles.map((tf) => tf.split("/").pop()).join(", ")}.`,
    `Risk: ${risk}.`,
  ];

  // Summarize fix kinds
  const fixKinds = new Set(issues.map((ii) => ii.suggestedFixKind).filter(Boolean));
  if (fixKinds.size > 0) {
    lines.push(`Approaches: ${[...fixKinds].join(", ")}.`);
  }

  // Top issues
  const top = issues.slice(0, 5);
  for (const issue of top) {
    lines.push(`- ${issue.file}:${issue.line}: ${issue.message}`);
  }
  if (issues.length > 5) {
    lines.push(`... and ${issues.length - 5} more.`);
  }

  lines.push("After: run tsc --noEmit and test suite.");
  return lines.join("\n");
}
