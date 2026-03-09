import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type CandidateFitAssessment,
  type ComparisonOutcome,
  type FitCompareDecision,
  type FitCompareResult,
  type FitSignal,
  type MigrationRiskReport,
} from "./types.js";
import { type ScorePackageOptions, scorePackage } from "./package-scorer.js";
import { analyzeProject } from "./analyzer.js";

export interface FitCompareOptions extends ScorePackageOptions {
  /** Path to the codebase to compare against */
  codebasePath: string;
}

/**
 * Compare two packages for fit against a specific codebase.
 *
 * Combines package quality scoring with codebase context analysis
 * to produce an adoption recommendation.
 *
 * @example
 * ```ts
 * import { fitCompare } from "typegrade";
 * const result = fitCompare("zod", "yup", { codebasePath: "./my-app" });
 * console.log(result.adoptionDecision.outcome, result.adoptionDecision.winner);
 * ```
 */
export function fitCompare(
  pkgA: string,
  pkgB: string,
  options: FitCompareOptions,
): FitCompareResult {
  const scoreOpts: ScorePackageOptions = {};
  if (options.domain !== undefined) {
    scoreOpts.domain = options.domain;
  }
  if (options.noCache !== undefined) {
    scoreOpts.noCache = options.noCache;
  }

  // Score both packages
  const resultA = scorePackage(pkgA, scoreOpts);
  const resultB = scorePackage(pkgB, scoreOpts);

  // Analyze the codebase
  const analyzeOpts: Parameters<typeof analyzeProject>[1] = { mode: "source" };
  if (options.domain !== undefined) {
    analyzeOpts.domain = options.domain;
  }
  const codebase = analyzeProject(options.codebasePath, analyzeOpts);

  // Compute fit assessments
  const candidateA = computeFitAssessment(pkgA, resultA, codebase);
  const candidateB = computeFitAssessment(pkgB, resultB, codebase);

  // Compute adoption decision
  const adoptionDecision = computeAdoptionDecision(candidateA, candidateB);

  // Compute first migration batches for the winner
  const winnerAssessment = adoptionDecision.winner === pkgA ? candidateA : candidateB;
  const firstMigrationBatches = computeFirstMigrationBatches(winnerAssessment, codebase);

  return {
    adoptionDecision,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    candidateA,
    candidateB,
    codebase,
    firstMigrationBatches,
  };
}

/**
 * Compute a fit assessment for a single candidate against a codebase.
 */
function computeFitAssessment(
  packageName: string,
  result: AnalysisResult,
  codebase: AnalysisResult,
): CandidateFitAssessment {
  const fitSignals = computeFitSignals(result, codebase);
  const domainCompatibility = computeDomainCompatibility(result, codebase);
  const decisionScore = computePackageDecisionScore(result);
  const migrationRisk = assessMigrationRisk(result, codebase);

  // Overall fit score: 40% package quality + 30% domain compatibility + 30% fit signals
  const signalAvg =
    fitSignals.length > 0
      ? fitSignals.reduce((sum, fs) => sum + fs.score, 0) / fitSignals.length
      : 50;

  const fitScore = Math.round(
    (decisionScore ?? 50) * 0.4 + domainCompatibility * 0.3 + signalAvg * 0.3,
  );

  return {
    decisionScore,
    domainCompatibility,
    fitScore,
    fitSignals,
    migrationRisk,
    packageName,
    result,
  };
}

/**
 * Compute fit signals from codebase context.
 */
function computeFitSignals(candidate: AnalysisResult, codebase: AnalysisResult): FitSignal[] {
  const signals: FitSignal[] = [];

  // Type safety alignment: how close is the candidate's type safety to the codebase's
  const candidateTs = candidate.composites.find((cc) => cc.key === "typeSafety")?.score;
  const codebaseTs = codebase.composites.find((cc) => cc.key === "typeSafety")?.score;
  if (
    candidateTs !== null &&
    candidateTs !== undefined &&
    codebaseTs !== null &&
    codebaseTs !== undefined
  ) {
    const gap = Math.abs(candidateTs - codebaseTs);
    const alignScore = Math.max(0, 100 - gap * 2);
    const explanation =
      gap < 10
        ? "Type safety levels are well aligned"
        : `Type safety gap of ${gap} points may cause friction`;
    signals.push({ explanation, name: "type-safety-alignment", score: alignScore });
  }

  // Agent readiness: how well the candidate supports agent workflows
  const agentScore = candidate.composites.find((cc) => cc.key === "agentReadiness")?.score;
  if (agentScore !== null && agentScore !== undefined) {
    const explanation =
      agentScore >= 70
        ? "Strong agent readiness supports AI-assisted development"
        : "Weak agent readiness may hinder AI tooling integration";
    signals.push({ explanation, name: "agent-readiness", score: agentScore });
  }

  // Consumer API quality
  const apiScore = candidate.composites.find((cc) => cc.key === "consumerApi")?.score;
  if (apiScore !== null && apiScore !== undefined) {
    const explanation =
      apiScore >= 70 ? "Well-typed public API surface" : "Public API has type precision gaps";
    signals.push({ explanation, name: "api-quality", score: apiScore });
  }

  // Boundary discipline compatibility
  const candidateBd = candidate.dimensions.find((dd) => dd.key === "boundaryDiscipline");
  const codebaseBd = codebase.dimensions.find((dd) => dd.key === "boundaryDiscipline");
  if (
    candidateBd?.score !== null &&
    candidateBd?.score !== undefined &&
    codebaseBd?.score !== null &&
    codebaseBd?.score !== undefined
  ) {
    const meetsStandards = candidateBd.score >= codebaseBd.score;
    const compatScore = meetsStandards
      ? Math.min(100, candidateBd.score)
      : Math.max(0, candidateBd.score - (codebaseBd.score - candidateBd.score));
    const explanation = meetsStandards
      ? "Candidate meets or exceeds codebase boundary standards"
      : "Candidate boundary discipline is below codebase standards";
    signals.push({ explanation, name: "boundary-compatibility", score: compatScore });
  }

  // Trust quality
  const trust = candidate.trustSummary;
  if (trust) {
    let trustScore = 0;
    if (trust.classification === "trusted") {
      trustScore = 100;
    } else if (trust.classification === "directional") {
      trustScore = 50;
    }
    signals.push({
      explanation: `Analysis trust: ${trust.classification}`,
      name: "trust-quality",
      score: trustScore,
    });
  }

  return signals;
}

/**
 * Compute domain compatibility between candidate and codebase.
 */
function computeDomainCompatibility(candidate: AnalysisResult, codebase: AnalysisResult): number {
  const candidateDomain = candidate.domainInference?.domain;
  const codebaseDomain = codebase.domainInference?.domain;

  if (!candidateDomain || !codebaseDomain) {
    return 50;
  }

  if (candidateDomain === codebaseDomain) {
    const confidence = Math.min(
      candidate.domainInference?.confidence ?? 0.5,
      codebase.domainInference?.confidence ?? 0.5,
    );
    return Math.round(70 + confidence * 30);
  }

  // General-purpose libraries are moderately compatible with any domain
  if (candidateDomain === "general" || candidateDomain === "utility") {
    return 60;
  }

  return 30;
}

/**
 * Compute a decision score for a single package (simplified from compare.ts).
 */
function computePackageDecisionScore(result: AnalysisResult): number | null {
  const weights: Record<string, number> = {
    agentReadiness: 0.15,
    consumerApi: 0.25,
    typeSafety: 0.35,
  };
  const dimWeights: Record<string, number> = {
    boundaryDiscipline: 0.1,
    declarationFidelity: 0.15,
  };

  let totalWeight = 0;
  let weightedSum = 0;
  let nullCount = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const comp = result.composites.find((cc) => cc.key === key);
    if (comp?.score !== null && comp?.score !== undefined) {
      weightedSum += comp.score * weight;
      totalWeight += weight;
    } else {
      nullCount++;
    }
  }

  for (const [dimKey, weight] of Object.entries(dimWeights)) {
    const dim = result.dimensions.find((dd) => dd.key === dimKey);
    if (dim?.score !== null && dim?.score !== undefined) {
      weightedSum += dim.score * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0 || nullCount === Object.keys(weights).length) {
    return null;
  }

  let score = weightedSum / totalWeight;
  if (result.status === "degraded") {
    score -= 25;
  }
  if (result.coverageDiagnostics?.undersampled) {
    score -= 10;
  }

  return Math.max(0, Math.round(score * 10) / 10);
}

/**
 * Assess migration risk for a candidate against a codebase.
 */
function assessMigrationRisk(
  candidate: AnalysisResult,
  codebase: AnalysisResult,
): MigrationRiskReport {
  const codebaseIssueCount = codebase.dimensions.flatMap((dd) => dd.issues).length;
  const estimatedTouchPoints = Math.min(
    codebase.filesAnalyzed,
    Math.max(1, Math.ceil(codebaseIssueCount / 5)),
  );

  const apiSpec = candidate.dimensions.find((dd) => dd.key === "apiSpecificity")?.score ?? 50;
  const apiMismatchRisk = scoreToRisk(apiSpec);

  const typeSafetyScore = candidate.composites.find((cc) => cc.key === "typeSafety")?.score ?? 50;
  const typingRisk = scoreToRisk(typeSafetyScore);

  const bdScore = candidate.dimensions.find((dd) => dd.key === "boundaryDiscipline")?.score ?? 50;
  const boundaryRisk = scoreToRisk(bdScore);

  const estimatedBatchCount = Math.max(1, Math.ceil(estimatedTouchPoints / 3));
  const requiresHumanReview = apiMismatchRisk === "high" || typingRisk === "high";

  return {
    apiMismatchRisk,
    boundaryRisk,
    estimatedBatchCount,
    estimatedTouchPoints,
    requiresHumanReview,
    typingRisk,
  };
}

/** Convert a 0-100 score to a risk level. */
function scoreToRisk(score: number): "low" | "medium" | "high" {
  if (score >= 70) {
    return "low";
  }
  if (score >= 40) {
    return "medium";
  }
  return "high";
}

/** Determine the fit outcome and winner from the fit delta. */
function determineFitOutcome(
  fitDelta: number,
  nameA: string,
  nameB: string,
): { outcome: ComparisonOutcome; winner: string | null } {
  if (Math.abs(fitDelta) < 5) {
    return { outcome: "equivalent", winner: null };
  }
  const winner = fitDelta > 0 ? nameA : nameB;
  if (Math.abs(fitDelta) >= 15) {
    return { outcome: "clear-winner", winner };
  }
  return { outcome: "marginal-winner", winner };
}

/**
 * Compute the adoption decision from two fit assessments.
 */
function computeAdoptionDecision(
  candidateA: CandidateFitAssessment,
  candidateB: CandidateFitAssessment,
): FitCompareDecision {
  const blockingReasons: string[] = [];

  // Check for abstention
  const trustA = candidateA.result.trustSummary;
  const trustB = candidateB.result.trustSummary;
  if (trustA?.classification === "abstained") {
    blockingReasons.push(
      `${candidateA.packageName}: analysis abstained — ${trustA.reasons[0] ?? "unknown"}`,
    );
  }
  if (trustB?.classification === "abstained") {
    blockingReasons.push(
      `${candidateB.packageName}: analysis abstained — ${trustB.reasons[0] ?? "unknown"}`,
    );
  }

  if (blockingReasons.length > 0) {
    return {
      blockingReasons,
      decisionConfidence: 0,
      outcome: "abstained",
      topReasons: [],
      winner: null,
    };
  }

  // Compare fit scores
  const fitDelta = candidateA.fitScore - candidateB.fitScore;
  const topReasons: string[] = [];

  // Build reasons from fit signals
  for (const signal of candidateA.fitSignals) {
    const matchB = candidateB.fitSignals.find((fs) => fs.name === signal.name);
    if (matchB && Math.abs(signal.score - matchB.score) >= 10) {
      const favors = signal.score > matchB.score ? candidateA.packageName : candidateB.packageName;
      topReasons.push(`${signal.name}: ${favors} scores higher (${signal.explanation})`);
    }
  }

  // Migration risk comparison
  const riskA = migrationRiskLevel(candidateA.migrationRisk);
  const riskB = migrationRiskLevel(candidateB.migrationRisk);
  if (riskA !== riskB) {
    const lower = riskA < riskB ? candidateA.packageName : candidateB.packageName;
    topReasons.push(`Migration risk: ${lower} has lower migration risk`);
  }

  // Determine outcome
  const { outcome, winner } = determineFitOutcome(
    fitDelta,
    candidateA.packageName,
    candidateB.packageName,
  );

  // Confidence: blend of trust, fit delta clarity, and domain compatibility
  const trustConfA = trustClassificationToScore(trustA?.classification);
  const trustConfB = trustClassificationToScore(trustB?.classification);
  const trustConfidence = Math.min(trustConfA, trustConfB);
  const deltaClarity = Math.min(Math.abs(fitDelta) / 20, 1);
  const domainConf = (candidateA.domainCompatibility + candidateB.domainCompatibility) / 200;
  const decisionConfidence =
    Math.round((0.4 * trustConfidence + 0.3 * deltaClarity + 0.3 * domainConf) * 100) / 100;

  return {
    blockingReasons: [],
    decisionConfidence,
    outcome,
    topReasons: topReasons.slice(0, 5),
    winner,
  };
}

/** Convert trust classification to a numeric confidence score. */
function trustClassificationToScore(classification?: string): number {
  if (classification === "trusted") {
    return 1;
  }
  if (classification === "directional") {
    return 0.6;
  }
  return 0.2;
}

/**
 * Convert migration risk to a numeric level for comparison.
 */
function migrationRiskLevel(risk: MigrationRiskReport): number {
  const riskMap = { high: 3, low: 1, medium: 2 };
  return riskMap[risk.apiMismatchRisk] + riskMap[risk.typingRisk] + riskMap[risk.boundaryRisk];
}

/**
 * Compute first migration batches for the winning candidate.
 */
function computeFirstMigrationBatches(
  candidate: CandidateFitAssessment,
  codebase: AnalysisResult,
): string[] {
  const batches: string[] = [];

  const codebaseIssues = codebase.dimensions.flatMap((dd) => dd.issues);
  const directIssues = codebaseIssues.filter((ii) => ii.fixability === "direct");

  if (directIssues.length > 0) {
    const count = Math.min(directIssues.length, 10);
    batches.push(`Fix ${count} directly fixable type issues in your codebase`);
  }

  if (candidate.migrationRisk.apiMismatchRisk !== "low") {
    const touchPoints = candidate.migrationRisk.estimatedTouchPoints;
    batches.push(`Review API surface compatibility — ${touchPoints} files may need updates`);
  }

  if (candidate.result.domainScore) {
    const { domain } = candidate.result.domainScore;
    batches.push(`Verify domain-specific patterns align with ${domain} conventions`);
  }

  if (candidate.migrationRisk.requiresHumanReview) {
    batches.push("Human review required before adoption — high typing or API risk detected");
  }

  return batches;
}
