import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type ExecutionDiagnostics,
  type FitCompareResult,
  type SmartCliResult,
  type SmartComparePayload,
  type SmartNextAction,
  type SmartSummary,
  type SmartSupplements,
  type SmartTargetKind,
  type TrustSummary,
} from "./types.js";
import {
  type ClassifiedTarget,
  classifyTarget,
  isLocalTarget,
  isPackageTarget,
} from "./cli-targets.js";
import type { DomainType } from "./domain.js";

/** Options for the smart root command */
export interface SmartOptions {
  json?: boolean;
  improve?: boolean;
  against?: string;
  domain?: "auto" | "off" | DomainType;
  verbose?: boolean;
  explain?: boolean;
  minScore?: number;
  color?: boolean;
  noCache?: boolean;
}

/** Dispatch result before rendering */
export interface SmartDispatchResult {
  result: SmartCliResult;
  exitCode: number;
}

/** Error with guidance for the user */
export class SmartUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartUsageError";
  }
}

interface RunContext {
  opts: SmartOptions;
  startMs: number;
}

interface PairRunContext extends RunContext {
  targetA: ClassifiedTarget;
  targetB: ClassifiedTarget;
}

/**
 * Run the smart root command with zero, one, or two positional arguments.
 *
 * All synchronous validation errors are wrapped as rejected promises so
 * callers can use a single `.catch()` / `try-await` pattern.
 */
export function runSmart(args: string[], opts: SmartOptions): Promise<SmartDispatchResult> {
  try {
    const ctx: RunContext = { opts, startMs: Date.now() };

    if (args.length === 0) {
      return runRepoAudit(".", ctx);
    }

    if (args.length === 1) {
      return dispatchSingleTarget(args[0]!, ctx);
    }

    if (args.length === 2) {
      return dispatchPairTargets(args[0]!, args[1]!, ctx);
    }

    throw new SmartUsageError(
      "Too many arguments. Expected: typegrade [target] or typegrade <left> <right>",
    );
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

// ---------------------------------------------------------------------------
// Single target dispatch
// ---------------------------------------------------------------------------

function dispatchSingleTarget(raw: string, ctx: RunContext): Promise<SmartDispatchResult> {
  try {
    if (ctx.opts.against) {
      throw new SmartUsageError(
        "--against requires two package targets: typegrade <pkgA> <pkgB> --against <repo>",
      );
    }

    const target = classifyTarget(raw);

    if (target.kind === "invalid") {
      throw new SmartUsageError(target.error ?? `Cannot classify target "${raw}"`);
    }

    if (isLocalTarget(target)) {
      if (target.kind === "package-path" && !ctx.opts.improve) {
        return runPackageScore(target, ctx);
      }
      return runRepoAudit(target.resolvedPath ?? raw, ctx);
    }

    if (ctx.opts.improve) {
      throw new SmartUsageError(
        "--improve is only valid for local projects: typegrade <path> --improve",
      );
    }
    return runPackageScore(target, ctx);
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

// ---------------------------------------------------------------------------
// Pair target dispatch
// ---------------------------------------------------------------------------

function dispatchPairTargets(
  rawA: string,
  rawB: string,
  ctx: RunContext,
): Promise<SmartDispatchResult> {
  try {
    if (ctx.opts.improve) {
      throw new SmartUsageError("--improve is not valid when comparing two targets");
    }

    const targetA = classifyTarget(rawA);
    const targetB = classifyTarget(rawB);

    if (targetA.kind === "invalid") {
      throw new SmartUsageError(targetA.error ?? `Cannot classify target "${rawA}"`);
    }
    if (targetB.kind === "invalid") {
      throw new SmartUsageError(targetB.error ?? `Cannot classify target "${rawB}"`);
    }

    const pairCtx: PairRunContext = { ...ctx, targetA, targetB };

    if (ctx.opts.against) {
      if (!isPackageTarget(targetA) || !isPackageTarget(targetB)) {
        throw new SmartUsageError(
          "--against requires two package targets, but got a local repo/workspace path",
        );
      }
      return runFitCompare(pairCtx);
    }

    if (isPackageTarget(targetA) && isPackageTarget(targetB)) {
      return runPackageCompare(pairCtx);
    }

    if (isLocalTarget(targetA) || isLocalTarget(targetB)) {
      throw new SmartUsageError(
        "Cannot compare a repo/workspace with a package. To compare packages: typegrade <pkgA> <pkgB>",
      );
    }

    return runPackageCompare(pairCtx);
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

// ---------------------------------------------------------------------------
// Mode runners
// ---------------------------------------------------------------------------

async function runRepoAudit(path: string, ctx: RunContext): Promise<SmartDispatchResult> {
  const { analyzeProject } = await import("./analyzer.js");
  const isImproveMode = Boolean(ctx.opts.improve);

  const analyzeOpts: Parameters<typeof analyzeProject>[1] = {
    agent: isImproveMode,
    domain: isImproveMode ? "off" : (ctx.opts.domain ?? "auto"),
    explain: Boolean(ctx.opts.explain),
    skipDeclEmit: isImproveMode,
  };
  if (isImproveMode) {
    analyzeOpts.profile = "autofix-agent";
  }
  const result = analyzeProject(path, analyzeOpts);

  const supplements: SmartSupplements = {};

  if (result.boundaryQuality || result.boundarySummary) {
    supplements.boundaries = {
      hotspots: result.boundaryHotspots ?? [],
      quality: result.boundaryQuality ?? null,
      summary: result.boundarySummary ?? null,
    };
  }

  if (result.monorepoHealth) {
    supplements.monorepo = result.monorepoHealth;
  }

  if (isImproveMode && result.autofixSummary) {
    const { buildAgentReport } = await import("./agent/index.js");
    supplements.agentReport = buildAgentReport(result);
  }

  const trust = result.trustSummary ?? buildDefaultTrust(result);
  const summary = buildRepoSummary(result, isImproveMode);
  const nextAction = buildNextAction(result, isImproveMode);
  const targetKind: SmartTargetKind = result.monorepoHealth ? "workspace" : "repo";

  return {
    exitCode: computeExitCode(result, ctx.opts),
    result: {
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      executionDiagnostics: result.executionDiagnostics ?? buildFallbackDiagnostics(ctx.startMs),
      mode: "repo-audit",
      nextAction,
      primary: result,
      resultKind: "smart-cli",
      summary,
      supplements,
      targetKind,
      trust,
    },
  };
}

async function runPackageScore(
  target: ClassifiedTarget,
  ctx: RunContext,
): Promise<SmartDispatchResult> {
  const { scorePackage } = await import("./package-scorer.js");
  const scoreOpts: Parameters<typeof scorePackage>[1] = {
    domain: ctx.opts.domain ?? "auto",
  };
  if (ctx.opts.noCache) {
    scoreOpts.noCache = true;
  }
  const result = scorePackage(target.raw, scoreOpts);

  const trust = result.trustSummary ?? buildDefaultTrust(result);
  const summary = buildPackageSummary(result);
  const nextAction: SmartNextAction = {
    files: [],
    kind: "none",
    title: "Review complete",
    verification: "",
    why: "Package scored successfully",
  };

  return {
    exitCode: computeExitCode(result, ctx.opts),
    result: {
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      executionDiagnostics: result.executionDiagnostics ?? buildFallbackDiagnostics(ctx.startMs),
      mode: "package-score",
      nextAction,
      primary: result,
      resultKind: "smart-cli",
      summary,
      supplements: {},
      targetKind: "package",
      trust,
    },
  };
}

async function runPackageCompare(ctx: PairRunContext): Promise<SmartDispatchResult> {
  const { comparePackages } = await import("./compare.js");
  const compareOpts: Parameters<typeof comparePackages>[2] = {
    domain: ctx.opts.domain ?? "auto",
  };
  if (ctx.opts.noCache) {
    compareOpts.noCache = true;
  }
  const compareResult = comparePackages(ctx.targetA.raw, ctx.targetB.raw, compareOpts);

  const payload: SmartComparePayload = {
    decision: compareResult.decision,
    resultA: compareResult.resultA,
    resultB: compareResult.resultB,
  };

  const trust = buildCompareTrust(compareResult.resultA, compareResult.resultB);
  const summary = buildCompareSummary({
    decision: compareResult.decision,
    nameA: ctx.targetA.raw,
    nameB: ctx.targetB.raw,
    resultA: compareResult.resultA,
    resultB: compareResult.resultB,
  });
  const nextAction = buildCompareNextAction(compareResult.decision);

  return {
    exitCode: 0,
    result: {
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      executionDiagnostics: buildFallbackDiagnostics(ctx.startMs),
      mode: "package-compare",
      nextAction,
      primary: payload,
      resultKind: "smart-cli",
      summary,
      supplements: {},
      targetKind: "pair",
      trust,
    },
  };
}

async function runFitCompare(ctx: PairRunContext): Promise<SmartDispatchResult> {
  const { fitCompare } = await import("./fit-compare.js");
  const fitOpts: Parameters<typeof fitCompare>[2] = {
    codebasePath: ctx.opts.against ?? ".",
    domain: ctx.opts.domain ?? "auto",
  };
  if (ctx.opts.noCache) {
    fitOpts.noCache = true;
  }
  const result = fitCompare(ctx.targetA.raw, ctx.targetB.raw, fitOpts);

  const trust: TrustSummary = {
    canCompare: true,
    canGate: true,
    classification: "trusted",
    reasons: [],
  };

  if (result.codebase.status === "degraded") {
    trust.classification = "directional";
    trust.reasons.push("Codebase analysis was degraded");
  }

  const decision = result.adoptionDecision;
  const summary = buildFitSummary(ctx.targetA.raw, ctx.targetB.raw, result);
  const nextAction: SmartNextAction = {
    files: [],
    kind: decision.outcome === "abstained" ? "investigate" : "adopt",
    title: decision.winner ? `Adopt ${decision.winner}` : "Review both options",
    verification: "Run typegrade after adoption to verify type quality",
    why: decision.topReasons[0] ?? "Fit comparison complete",
  };

  return {
    exitCode: 0,
    result: {
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      executionDiagnostics: buildFallbackDiagnostics(ctx.startMs),
      mode: "fit-compare",
      nextAction,
      primary: result,
      resultKind: "smart-cli",
      summary,
      supplements: {},
      targetKind: "pair",
      trust,
    },
  };
}

// ---------------------------------------------------------------------------
// Summary builders
// ---------------------------------------------------------------------------

function buildRepoSummary(result: AnalysisResult, improveMode: boolean): SmartSummary {
  const verdict = resultToVerdict(result);
  const scorecard = buildScorecard(result);
  const topReasons: string[] = [];
  const topRisks: string[] = [];

  for (const comp of result.composites) {
    if (comp.score !== null && comp.score >= 80) {
      topReasons.push(`${formatCompositeLabel(comp.key)}: ${comp.score}/100 (${comp.grade})`);
    }
    if (comp.score !== null && comp.score < 60) {
      topRisks.push(`${formatCompositeLabel(comp.key)}: ${comp.score}/100 — needs improvement`);
    }
  }

  if (result.boundaryQuality && result.boundaryQuality.score < 50) {
    topRisks.push(`Boundary quality is low (${result.boundaryQuality.score}/100)`);
  }

  const headline = improveMode
    ? `${result.projectName}: ${verdict === "good" ? "healthy" : verdict} — ${topRisks[0] ?? "no critical issues"}`
    : buildRepoHeadline(result.projectName, verdict);

  return {
    headline,
    scorecard,
    topReasons: topReasons.slice(0, 3),
    topRisks: topRisks.slice(0, 3),
    verdict,
  };
}

function buildRepoHeadline(projectName: string, verdict: SmartSummary["verdict"]): string {
  if (verdict === "good") {
    return `${projectName}: good type quality`;
  }
  if (verdict === "needs-work") {
    return `${projectName}: type quality needs work`;
  }
  return `${projectName}: ${verdict}`;
}

function buildPackageSummary(result: AnalysisResult): SmartSummary {
  const verdict = resultToVerdict(result);
  const scorecard = buildScorecard(result);
  const topReasons: string[] = [];
  const topRisks: string[] = [];

  for (const comp of result.composites) {
    if (comp.score !== null && comp.score >= 80) {
      topReasons.push(`${formatCompositeLabel(comp.key)}: ${comp.score}/100`);
    }
    if (comp.score !== null && comp.score < 60) {
      topRisks.push(`${formatCompositeLabel(comp.key)}: ${comp.score}/100`);
    }
  }

  if (result.coverageDiagnostics.undersampled) {
    topRisks.push("Package surface is undersampled — scores may not be fully representative");
  }

  const headline = buildPackageHeadline(result.projectName, verdict);

  return {
    headline,
    scorecard,
    topReasons: topReasons.slice(0, 3),
    topRisks: topRisks.slice(0, 3),
    verdict,
  };
}

function buildPackageHeadline(projectName: string, verdict: SmartSummary["verdict"]): string {
  if (verdict === "good") {
    return `${projectName}: well-typed`;
  }
  if (verdict === "needs-work") {
    return `${projectName}: mixed type quality`;
  }
  return `${projectName}: ${verdict}`;
}

interface CompareSummaryInput {
  nameA: string;
  nameB: string;
  decision: SmartComparePayload["decision"];
  resultA: AnalysisResult;
  resultB: AnalysisResult;
}

function buildCompareSummary(input: CompareSummaryInput): SmartSummary {
  const { nameA, nameB, decision, resultA, resultB } = input;
  const verdict = computeCompareVerdict(decision.outcome);

  const scorecardA = buildScorecard(resultA).map((en) =>
    Object.assign(en, { label: `${nameA} ${en.label}` }),
  );
  const scorecardB = buildScorecard(resultB).map((en) =>
    Object.assign(en, { label: `${nameB} ${en.label}` }),
  );
  const scorecard = [...scorecardA, ...scorecardB];

  const headline = buildCompareHeadline(nameA, nameB, decision);

  return {
    headline,
    scorecard,
    topReasons: decision.topReasons.slice(0, 3),
    topRisks: decision.blockingReasons.slice(0, 3),
    verdict,
  };
}

function computeCompareVerdict(outcome: string): SmartSummary["verdict"] {
  if (outcome === "abstained") {
    return "abstained";
  }
  if (outcome === "incomparable") {
    return "degraded";
  }
  return "good";
}

function buildCompareHeadline(
  nameA: string,
  nameB: string,
  decision: SmartComparePayload["decision"],
): string {
  if (decision.outcome === "clear-winner" || decision.outcome === "marginal-winner") {
    return `${decision.winner} is the better choice`;
  }
  if (decision.outcome === "equivalent") {
    return `${nameA} and ${nameB} are equivalent`;
  }
  return `Cannot confidently compare ${nameA} and ${nameB}`;
}

function buildFitSummary(nameA: string, nameB: string, result: FitCompareResult): SmartSummary {
  const decision = result.adoptionDecision;
  const headline = buildFitHeadline(nameA, nameB, decision);
  const verdict: SmartSummary["verdict"] = decision.outcome === "abstained" ? "abstained" : "good";

  return {
    headline,
    scorecard: [
      { grade: null, key: "fitA", label: `${nameA} Fit`, score: result.candidateA.fitScore },
      { grade: null, key: "fitB", label: `${nameB} Fit`, score: result.candidateB.fitScore },
    ],
    topReasons: decision.topReasons.slice(0, 3),
    topRisks: decision.blockingReasons.slice(0, 3),
    verdict,
  };
}

function buildFitHeadline(
  nameA: string,
  nameB: string,
  decision: FitCompareResult["adoptionDecision"],
): string {
  if (decision.winner) {
    return `${decision.winner} is a better fit for your codebase`;
  }
  if (decision.outcome === "equivalent") {
    return `${nameA} and ${nameB} fit your codebase equally`;
  }
  return `Cannot determine fit between ${nameA} and ${nameB}`;
}

// ---------------------------------------------------------------------------
// Next action builders
// ---------------------------------------------------------------------------

function buildNextAction(result: AnalysisResult, improveMode: boolean): SmartNextAction {
  if (improveMode && result.autofixSummary) {
    const [batch] = result.autofixSummary.fixBatches;
    if (batch) {
      return {
        files: batch.targetFiles.slice(0, 5),
        kind: "fix",
        title: batch.title,
        verification: "Re-run typegrade after applying fixes to verify improvement",
        why: `Expected impact: ${batch.expectedImpact}`,
      };
    }
  }

  const [topIssue] = result.topIssues;
  if (topIssue) {
    return {
      files: topIssue.file ? [topIssue.file] : [],
      kind: "fix",
      title: topIssue.message.slice(0, 80),
      verification: "Re-run typegrade to verify improvement",
      why: `Affects ${topIssue.dimensionKey} score`,
    };
  }

  const rec = result.recommendations?.[0];
  if (rec) {
    return {
      files: [],
      kind: "investigate",
      title: rec.action,
      verification: "",
      why: rec.reason,
    };
  }

  return {
    files: [],
    kind: "none",
    title: "No immediate action needed",
    verification: "",
    why: "Analysis looks good",
  };
}

function buildCompareNextAction(decision: SmartComparePayload["decision"]): SmartNextAction {
  if (decision.winner) {
    return {
      files: [],
      kind: "adopt",
      title: `Use ${decision.winner}`,
      verification: "Run typegrade after adoption to verify type quality",
      why: decision.topReasons[0] ?? `${decision.winner} scored higher`,
    };
  }
  return {
    files: [],
    kind: "investigate",
    title: "Review both options manually",
    verification: "",
    why: decision.blockingReasons[0] ?? "No clear winner",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resultToVerdict(result: AnalysisResult): SmartSummary["verdict"] {
  if (result.status === "degraded" || result.status === "invalid-input") {
    return "degraded";
  }
  if (result.trustSummary?.classification === "abstained") {
    return "abstained";
  }
  const arScore = result.composites.find((comp) => comp.key === "agentReadiness")?.score;
  if (arScore === null || arScore === undefined) {
    return "degraded";
  }
  if (arScore >= 70) {
    return "good";
  }
  if (arScore >= 45) {
    return "needs-work";
  }
  return "poor";
}

function buildScorecard(result: AnalysisResult): SmartSummary["scorecard"] {
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    consumerApi: "Consumer API",
    typeSafety: "Type Safety",
  };
  return result.composites.map((comp) => ({
    grade: comp.grade,
    key: comp.key,
    label: labels[comp.key] ?? comp.key,
    score: comp.score,
  }));
}

function formatCompositeLabel(key: string): string {
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    consumerApi: "Consumer API",
    typeSafety: "Type Safety",
  };
  return labels[key] ?? key;
}

function buildDefaultTrust(result: AnalysisResult): TrustSummary {
  if (result.status === "degraded") {
    return {
      canCompare: false,
      canGate: false,
      classification: "abstained",
      reasons: ["Degraded result"],
    };
  }
  if (result.scoreValidity === "not-comparable") {
    return {
      canCompare: false,
      canGate: false,
      classification: "directional",
      reasons: ["Scores not comparable"],
    };
  }
  return { canCompare: true, canGate: true, classification: "trusted", reasons: [] };
}

function buildCompareTrust(resultA: AnalysisResult, resultB: AnalysisResult): TrustSummary {
  const reasons: string[] = [];
  if (resultA.status === "degraded") {
    reasons.push(`${resultA.projectName} is degraded`);
  }
  if (resultB.status === "degraded") {
    reasons.push(`${resultB.projectName} is degraded`);
  }
  if (reasons.length > 0) {
    return { canCompare: false, canGate: false, classification: "abstained", reasons };
  }
  if (
    resultA.scoreValidity !== "fully-comparable" ||
    resultB.scoreValidity !== "fully-comparable"
  ) {
    return {
      canCompare: true,
      canGate: false,
      classification: "directional",
      reasons: ["Reduced comparability"],
    };
  }
  return { canCompare: true, canGate: true, classification: "trusted", reasons: [] };
}

function computeExitCode(result: AnalysisResult, opts: SmartOptions): number {
  if (typeof opts.minScore !== "number") {
    return 0;
  }
  if (result.trustSummary?.classification === "abstained") {
    return 1;
  }
  if (result.scoreValidity === "not-comparable") {
    return 1;
  }
  const arScore = result.composites.find((comp) => comp.key === "agentReadiness")?.score;
  if (arScore !== null && arScore !== undefined && arScore < opts.minScore) {
    return 1;
  }
  return 0;
}

function buildFallbackDiagnostics(startMs: number): ExecutionDiagnostics {
  return {
    analysisPath: "smart-cli",
    fallbacksApplied: [],
    phaseTimings: { total: Date.now() - startMs },
    resourceWarnings: [],
  };
}
