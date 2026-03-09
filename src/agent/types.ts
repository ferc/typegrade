import type { FixBatch, Issue } from "../types.js";

export type { AutofixSummary, FixBatch, Issue } from "../types.js";

/** Condition that signals the agent should stop iterating */
export interface StopCondition {
  kind:
    | "no-actionable-issues"
    | "all-batches-applied"
    | "score-target-met"
    | "diminishing-returns"
    | "max-iterations";
  met: boolean;
  reason: string;
}

/** Expected code change description for a fix batch */
export interface FixBatchDiff {
  changeDescription: string;
  file: string;
  linesAffected: number;
}

/** Risk assessment for rolling back a fix batch */
export interface RollbackRisk {
  affectsPublicApi: boolean;
  affectsTests: boolean;
  level: "trivial" | "safe" | "caution" | "dangerous";
  reason: string;
}

/** Enriched fix batch with agent-specific metadata */
export interface EnrichedFixBatch extends FixBatch {
  /** Expected code change diffs for this batch */
  expectedDiffs?: FixBatchDiff[] | undefined;
  /** Estimated score delta from applying this batch */
  expectedScoreDelta: number;
  /** Rollback risk assessment */
  rollbackRisk?: RollbackRisk | undefined;
  /** Commands to run after applying this batch */
  verificationCommands: string[];
}

/** Agent report with actionable findings and fix batches */
export interface AgentReport {
  /** Only high-confidence, actionable findings */
  actionableIssues: Issue[];
  /** Grouped fix batches for sequential execution */
  fixBatches: FixBatch[];
  /** Enriched fix batches with score deltas and verification commands */
  enrichedBatches: EnrichedFixBatch[];
  /** Count of issues suppressed */
  suppressedCount: number;
  /** Breakdown of suppression reasons */
  suppressionReasons: { category: string; count: number }[];
  /** Suggested execution order (batch IDs) */
  executionOrder: string[];
  /** Expected total score improvement */
  expectedScoreImprovement: number;
  /** Stop conditions — when should the agent stop iterating */
  stopConditions: StopCondition[];
  /** Typed verification plan for post-fix validation */
  verificationPlan?: { commands: { command: string; description: string; mustPass: boolean }[] };
  /** Verification steps for the entire report */
  verificationSteps: string[];
  /** Why no fix batches were emitted (when empty) */
  abstentionReason?: string;
}
