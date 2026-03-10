import type { AbortCondition, AcceptanceCheck, FixBatch, Issue, TrustSummary } from "../types.js";

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
  /** High-level goal of this batch */
  goal: string;
  /** Why this batch should be applied now */
  whyNow: string;
  /** Concrete code change hints for the agent */
  patchHints: string[];
  /** Acceptance checks that must pass after applying this batch */
  acceptanceChecks: AcceptanceCheck[];
  /** Conditions under which the agent should abort this batch */
  abortIf: AbortCondition[];
  /** Rollback instructions as text */
  rollbackPlan: string;
  /** Agent-oriented prompt/instructions for applying this batch */
  agentInstructions: string;
  /** Files that should be reverted if the batch fails */
  rollbackFiles: string[];
  /** Structured hint for how to roll back */
  rollbackHint: string;
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
  /** The single best batch to apply next (highest-impact, low/medium risk) */
  nextBestBatch?: EnrichedFixBatch | undefined;
  /** Trust summary for the report itself */
  reportTrust?: TrustSummary | undefined;
  /** Abort signals — conditions under which the agent should stop entirely */
  abortSignals: AbortCondition[];
  /** Caveat when lower-impact batches were pruned */
  prunedBatchCaveat?: string | undefined;
}
