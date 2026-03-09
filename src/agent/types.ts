import type { FixBatch, Issue } from "../types.js";

export type { AutofixSummary, FixBatch, Issue } from "../types.js";

/** Agent report with actionable findings and fix batches */
export interface AgentReport {
  /** Only high-confidence, actionable findings */
  actionableIssues: Issue[];
  /** Grouped fix batches for sequential execution */
  fixBatches: FixBatch[];
  /** Count of issues suppressed */
  suppressedCount: number;
  /** Breakdown of suppression reasons */
  suppressionReasons: { category: string; count: number }[];
  /** Suggested execution order (batch IDs) */
  executionOrder: string[];
  /** Expected total score improvement */
  expectedScoreImprovement: number;
}
