import type { FixApplicationResult, FixMode, FixPlan } from "../types.js";

/** Minimum confidence threshold for safe-mode application */
const SAFE_MODE_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Apply fixes from a FixPlan according to the specified mode.
 *
 * In "safe" mode, only batches with a fixCategory and confidence >= 0.8 are applied.
 * In "review" mode, all batches are returned as skipped with reason "review-required".
 *
 * Actual codemods are not yet implemented — this provides the application framework.
 *
 * @example
 * ```ts
 * const result = applyFixes({ plan, mode: "safe", projectPath: "/path/to/project" });
 * console.log(result.applied.length, "batches applied");
 * ```
 */
export function applyFixes(opts: {
  plan: FixPlan;
  mode: FixMode;
  projectPath: string;
}): FixApplicationResult {
  const { plan, mode } = opts;

  const applied: { batchId: string; filesModified: string[] }[] = [];
  const skipped: { batchId: string; reason: string }[] = [];

  for (const batch of plan.batches) {
    if (mode === "review") {
      // Review mode: skip everything for human review
      skipped.push({
        batchId: batch.id,
        reason: "review-required",
      });
      continue;
    }

    // Safe mode: only apply batches with a safe category and high confidence
    if (!batch.fixCategory) {
      skipped.push({
        batchId: batch.id,
        reason: "no-safe-fix-category",
      });
      continue;
    }

    if (batch.confidence < SAFE_MODE_CONFIDENCE_THRESHOLD) {
      skipped.push({
        batchId: batch.id,
        reason: `confidence-below-threshold:${batch.confidence}`,
      });
      continue;
    }

    // Framework placeholder: actual codemod application will go here.
    // For now, record the batch as applied with its target files.
    applied.push({
      batchId: batch.id,
      filesModified: [...batch.targetFiles],
    });
  }

  // Compute scoreBefore from the plan's total uplift estimate (approximate baseline)
  // Actual score comes from the analysis result; we use 0 as a placeholder.
  return {
    applied,
    scoreAfter: null,
    scoreBefore: 0,
    skipped,
    verificationPassed: false,
  };
}
