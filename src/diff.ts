import type {
  AnalysisResult,
  CompositeDiff,
  CompositeKey,
  DiffResult,
  DimensionDiff,
  Issue,
} from "./types.js";
import pc from "picocolors";

// --- Issue Fingerprinting ---

/** Build a stable fingerprint for issue deduplication */
function issueFingerprint(issue: Issue): string {
  return `${issue.file}:${issue.line}:${issue.dimension}:${issue.message}`;
}

// --- Composite Diffing ---

const COMPOSITE_KEYS: CompositeKey[] = [
  "consumerApi",
  "agentReadiness",
  "typeSafety",
  "implementationQuality",
];

/** Compare composite scores between baseline and target */
function diffComposites(opts: {
  baseline: AnalysisResult;
  target: AnalysisResult;
}): CompositeDiff[] {
  const diffs: CompositeDiff[] = [];

  for (const key of COMPOSITE_KEYS) {
    const baseComp = opts.baseline.composites.find((comp) => comp.key === key);
    const targetComp = opts.target.composites.find((comp) => comp.key === key);
    const baseScore = baseComp?.score ?? 0;
    const targetScore = targetComp?.score ?? 0;

    diffs.push({
      baseline: baseScore,
      delta: targetScore - baseScore,
      key,
      target: targetScore,
    });
  }

  return diffs;
}

// --- Dimension Diffing ---

/** Compare dimension scores between baseline and target */
function diffDimensions(opts: {
  baseline: AnalysisResult;
  target: AnalysisResult;
}): DimensionDiff[] {
  const diffs: DimensionDiff[] = [];
  const allKeys = new Set<string>();

  for (const dim of opts.baseline.dimensions) {
    allKeys.add(dim.key);
  }
  for (const dim of opts.target.dimensions) {
    allKeys.add(dim.key);
  }

  for (const key of allKeys) {
    const baseDim = opts.baseline.dimensions.find((dim) => dim.key === key);
    const targetDim = opts.target.dimensions.find((dim) => dim.key === key);
    const baseScore = baseDim?.score ?? 0;
    const targetScore = targetDim?.score ?? 0;
    const label = targetDim?.label ?? baseDim?.label ?? key;

    diffs.push({
      baseline: baseScore,
      delta: targetScore - baseScore,
      key,
      label,
      target: targetScore,
    });
  }

  return diffs;
}

// --- Issue Diffing ---

/** Find new issues present in target but not in baseline */
function findNewIssues(opts: { baseline: AnalysisResult; target: AnalysisResult }): Issue[] {
  const baselineFingerprints = new Set(opts.baseline.topIssues.map(issueFingerprint));
  return opts.target.topIssues.filter(
    (issue) => !baselineFingerprints.has(issueFingerprint(issue)),
  );
}

/** Find resolved issues present in baseline but not in target */
function findResolvedIssues(opts: { baseline: AnalysisResult; target: AnalysisResult }): Issue[] {
  const targetFingerprints = new Set(opts.target.topIssues.map(issueFingerprint));
  return opts.baseline.topIssues.filter(
    (issue) => !targetFingerprints.has(issueFingerprint(issue)),
  );
}

// --- Summary Generation ---

/** Generate a human-readable summary of the diff */
function buildSummary(opts: {
  compositeDiffs: CompositeDiff[];
  newIssues: Issue[];
  resolvedIssues: Issue[];
}): string {
  const parts: string[] = [];

  // Summarize composite score changes
  const improved = opts.compositeDiffs.filter((diff) => diff.delta > 0);
  const regressed = opts.compositeDiffs.filter((diff) => diff.delta < 0);
  const unchanged = opts.compositeDiffs.filter((diff) => diff.delta === 0);

  if (improved.length > 0) {
    const labels = improved.map((diff) => `${compositeLabel(diff.key)} (+${diff.delta})`);
    parts.push(`Improved: ${labels.join(", ")}`);
  }
  if (regressed.length > 0) {
    const labels = regressed.map((diff) => `${compositeLabel(diff.key)} (${diff.delta})`);
    parts.push(`Regressed: ${labels.join(", ")}`);
  }
  if (unchanged.length === opts.compositeDiffs.length) {
    parts.push("No composite score changes");
  }

  // Summarize issue changes
  if (opts.newIssues.length > 0) {
    parts.push(`${opts.newIssues.length} new issue(s)`);
  }
  if (opts.resolvedIssues.length > 0) {
    parts.push(`${opts.resolvedIssues.length} resolved issue(s)`);
  }
  if (opts.newIssues.length === 0 && opts.resolvedIssues.length === 0) {
    parts.push("No issue changes");
  }

  return `${parts.join(". ")}.`;
}

// --- Label Helpers ---

/** Get a human-readable label for a composite key */
function compositeLabel(key: CompositeKey): string {
  switch (key) {
    case "consumerApi": {
      return "Consumer API";
    }
    case "agentReadiness": {
      return "Agent Readiness";
    }
    case "typeSafety": {
      return "Type Safety";
    }
    case "implementationQuality": {
      return "Implementation";
    }
    default: {
      return key;
    }
  }
}

// --- Public API ---

/**
 * Compare two analysis results and produce a structured diff.
 *
 * @example
 * ```ts
 * import { computeDiff } from "./diff.js";
 * const diff = computeDiff({ baseline: before, target: after });
 * ```
 */
export function computeDiff(opts: {
  baseline: AnalysisResult;
  target: AnalysisResult;
}): DiffResult {
  const compositeDiffs = diffComposites(opts);
  const dimensionDiffs = diffDimensions(opts);
  const newIssues = findNewIssues(opts);
  const resolvedIssues = findResolvedIssues(opts);
  const summary = buildSummary({ compositeDiffs, newIssues, resolvedIssues });

  return {
    baseline: opts.baseline,
    compositeDiffs,
    dimensionDiffs,
    newIssues,
    resolvedIssues,
    summary,
    target: opts.target,
  };
}

// --- Rendering ---

/** Format a delta value with sign and color */
function formatDelta(delta: number): string {
  if (delta > 0) {
    return pc.green(`+${delta}`);
  }
  if (delta < 0) {
    return pc.red(`${delta}`);
  }
  return pc.dim("0");
}

/** Minimum absolute delta to show a dimension in the report */
const SIGNIFICANT_DELTA_THRESHOLD = 2;

/**
 * Render a colored terminal report from a DiffResult.
 *
 * @example
 * ```ts
 * import { computeDiff, renderDiffReport } from "./diff.js";
 * console.log(renderDiffReport(computeDiff({ baseline, target })));
 * ```
 */
export function renderDiffReport(diff: DiffResult): string {
  const lines: string[] = [
    "",
    pc.bold("  typegrade diff"),
    `  ${pc.dim(diff.baseline.projectName)} \u2192 ${pc.dim(diff.target.projectName)}`,
    "",
    pc.bold("  Composite Scores:"),
  ];

  // Composite score changes
  for (const comp of diff.compositeDiffs) {
    const label = compositeLabel(comp.key).padEnd(22);
    const baseStr = String(comp.baseline).padEnd(6);
    const targetStr = String(comp.target).padEnd(6);
    const deltaStr = formatDelta(comp.delta);
    lines.push(`    ${label}${baseStr}\u2192  ${targetStr}${deltaStr}`);
  }
  lines.push("");

  // Dimension changes (significant only)
  const significantDims = diff.dimensionDiffs.filter(
    (dim) => Math.abs(dim.delta) >= SIGNIFICANT_DELTA_THRESHOLD,
  );

  if (significantDims.length > 0) {
    lines.push(pc.bold(`  Dimension Changes (>= ${SIGNIFICANT_DELTA_THRESHOLD} pts):`));
    for (const dim of significantDims) {
      const label = dim.label.padEnd(22);
      const baseStr = String(dim.baseline).padEnd(6);
      const targetStr = String(dim.target).padEnd(6);
      const deltaStr = formatDelta(dim.delta);
      lines.push(`    ${label}${baseStr}\u2192  ${targetStr}${deltaStr}`);
    }
    lines.push("");
  }

  // New issues
  if (diff.newIssues.length > 0) {
    lines.push(pc.bold(`  New Issues (${diff.newIssues.length}):`));
    for (const issue of diff.newIssues.slice(0, 10)) {
      const loc = issue.file ? `${issue.file}:${issue.line}` : "";
      lines.push(`    ${pc.red("\u2716")}  ${pc.dim(loc)} \u2014 ${issue.message}`);
    }
    if (diff.newIssues.length > 10) {
      lines.push(`    ${pc.dim(`... and ${diff.newIssues.length - 10} more`)}`);
    }
    lines.push("");
  }

  // Resolved issues
  if (diff.resolvedIssues.length > 0) {
    lines.push(pc.bold(`  Resolved Issues (${diff.resolvedIssues.length}):`));
    for (const issue of diff.resolvedIssues.slice(0, 10)) {
      const loc = issue.file ? `${issue.file}:${issue.line}` : "";
      lines.push(`    ${pc.green("\u2714")}  ${pc.dim(loc)} \u2014 ${issue.message}`);
    }
    if (diff.resolvedIssues.length > 10) {
      lines.push(`    ${pc.dim(`... and ${diff.resolvedIssues.length - 10} more`)}`);
    }
    lines.push("");
  }

  // Summary
  lines.push(`  ${pc.dim(diff.summary)}`);
  lines.push("");

  return lines.join("\n");
}
