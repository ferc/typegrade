import {
  ANALYSIS_SCHEMA_VERSION,
  type AbstentionKind,
  type AnalysisResult,
  type CandidateFitAssessment,
  type ComparabilityStatus,
  type ComparisonOutcome,
  type FitCompareDecision,
  type FitCompareResult,
  type FitSignal,
  type MigrationComplexity,
  type MigrationRiskReport,
} from "./types.js";
import { type ScorePackageOptions, scorePackage } from "./package-scorer.js";
import { analyzeProject } from "./analyzer.js";

export interface FitCompareOptions extends ScorePackageOptions {
  /** Path to the codebase to compare against */
  codebasePath: string;
  /** If true, allow cross-domain comparisons that would otherwise be abstained */
  forceCrossDomain?: boolean;
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

  // Compute fit assessments with codebase relevance
  const candidateA = computeFitAssessment(pkgA, resultA, codebase);
  const candidateB = computeFitAssessment(pkgB, resultB, codebase);

  // Compute adoption decision
  const adoptionDecision = computeAdoptionDecision(
    candidateA,
    candidateB,
    options.forceCrossDomain,
  );

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

  // Compute codebase relevance
  const { relevance, evidence } = computeCodebaseRelevance(result, codebase, domainCompatibility);

  return {
    codebaseRelevance: relevance,
    decisionScore,
    domainCompatibility,
    fitScore,
    fitSignals,
    migrationRisk,
    packageName,
    relevanceEvidence: evidence,
    result,
  };
}

/**
 * Compute codebase relevance for a candidate library against a codebase.
 * Combines domain compatibility, boundary pattern overlap, and type alignment.
 */
function computeCodebaseRelevance(
  candidate: AnalysisResult,
  codebase: AnalysisResult,
  domainCompatibility: number,
): { relevance: number; evidence: string[] } {
  const evidence: string[] = [];
  let relevanceScore = 0;
  let totalWeight = 0;

  // Domain compatibility (40% weight)
  relevanceScore += domainCompatibility * 0.4;
  totalWeight += 0.4;
  if (domainCompatibility >= 70) {
    evidence.push(`Domain match: compatible (${domainCompatibility})`);
  } else if (domainCompatibility >= 50) {
    evidence.push(`Domain match: partial (${domainCompatibility})`);
  } else {
    evidence.push(`Domain match: poor (${domainCompatibility})`);
  }

  // Type safety alignment (30% weight)
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
    relevanceScore += alignScore * 0.3;
    totalWeight += 0.3;
    if (gap < 10) {
      evidence.push(`Type safety aligned (gap: ${gap})`);
    } else {
      evidence.push(`Type safety gap: ${gap} points`);
    }
  }

  // Boundary pattern overlap (30% weight)
  const candidateBd = candidate.dimensions.find((dd) => dd.key === "boundaryDiscipline")?.score;
  const codebaseBd = codebase.dimensions.find((dd) => dd.key === "boundaryDiscipline")?.score;
  if (
    candidateBd !== null &&
    candidateBd !== undefined &&
    codebaseBd !== null &&
    codebaseBd !== undefined
  ) {
    const bdGap = Math.abs(candidateBd - codebaseBd);
    const bdAlign = Math.max(0, 100 - bdGap * 1.5);
    relevanceScore += bdAlign * 0.3;
    totalWeight += 0.3;
    if (bdGap < 15) {
      evidence.push(`Boundary discipline aligned (gap: ${bdGap})`);
    } else {
      evidence.push(`Boundary discipline mismatch: ${bdGap} points`);
    }
  }

  const relevance = totalWeight > 0 ? Math.round(relevanceScore / totalWeight) : 50;
  return { evidence, relevance: Math.min(100, Math.max(0, relevance)) };
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

  // Cross-cutting libraries are moderately compatible with any domain
  if (BROADLY_APPLICABLE_DOMAINS.has(candidateDomain)) {
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

  // Concrete migration metrics
  const candidateDecls = candidate.coverageDiagnostics?.measuredDeclarations ?? 0;
  const codebaseDecls = codebase.coverageDiagnostics?.measuredDeclarations ?? 0;
  const apiSurfaceDelta = Math.abs(candidateDecls - codebaseDecls);

  const candidateBoundaryCoverage = candidate.boundarySummary?.boundaryCoverage ?? 0;
  const codebaseBoundaryCoverage = codebase.boundarySummary?.boundaryCoverage ?? 0;
  const boundaryCoverageGap =
    Math.round(Math.abs(candidateBoundaryCoverage - codebaseBoundaryCoverage) * 100) / 100;

  const codebaseTsScore = codebase.composites.find((cc) => cc.key === "typeSafety")?.score ?? 50;
  const typeSafetyGap = Math.abs(typeSafetyScore - codebaseTsScore);

  const estimatedCallSiteChanges = estimatedTouchPoints * 3;

  const migrationComplexity = classifyMigrationComplexity({
    apiMismatchRisk,
    boundaryRisk,
    estimatedTouchPoints,
    typingRisk,
  });

  return {
    apiMismatchRisk,
    apiSurfaceDelta,
    boundaryCoverageGap,
    boundaryRisk,
    estimatedBatchCount,
    estimatedCallSiteChanges,
    estimatedTouchPoints,
    migrationComplexity,
    requiresHumanReview,
    typeSafetyGap,
    typingRisk,
  };
}

/** Classify overall migration complexity from risk signals */
function classifyMigrationComplexity(opts: {
  apiMismatchRisk: "low" | "medium" | "high";
  boundaryRisk: "low" | "medium" | "high";
  estimatedTouchPoints: number;
  typingRisk: "low" | "medium" | "high";
}): MigrationComplexity {
  const riskMap = { high: 3, low: 1, medium: 2 };
  const totalRisk =
    riskMap[opts.apiMismatchRisk] + riskMap[opts.typingRisk] + riskMap[opts.boundaryRisk];
  const highCount = [opts.apiMismatchRisk, opts.typingRisk, opts.boundaryRisk].filter(
    (rr) => rr === "high",
  ).length;

  if (highCount >= 2 && opts.estimatedTouchPoints > 30) {
    return "major";
  }
  if (highCount >= 1 || opts.estimatedTouchPoints > 15) {
    return "significant";
  }
  if (totalRisk > 4 || opts.estimatedTouchPoints > 5) {
    return "moderate";
  }
  return "trivial";
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

/** Minimum codebase relevance to allow a fit-compare recommendation */
const MIN_CODEBASE_RELEVANCE = 40;

/** Minimum fit score delta for a recommendation when confidence is below 0.70 */
const MIN_FIT_DELTA_LOW_CONFIDENCE = 8;

/** Domains whose libraries are commonly used across all project types */
const BROADLY_APPLICABLE_DOMAINS = new Set([
  "general",
  "utility",
  "validation",
  "schema",
  "testing",
]);

/** Domains that are considered compatible with any other domain (for candidate-vs-candidate check) */
const CROSS_DOMAIN_COMPATIBLE = new Set(["general", "utility", "validation", "schema", "testing"]);

/**
 * Build an abstained fit-compare decision.
 */
function buildFitAbstention(
  blockingReasons: string[],
  abstentionKind: AbstentionKind,
): FitCompareDecision {
  return {
    abstentionKind,
    blockingReasons,
    comparabilityStatus: "not-comparable",
    decisionConfidence: 0,
    outcome: "abstained",
    topReasons: [],
    winner: null,
  };
}

/**
 * Compute the adoption decision from two fit assessments.
 */
function computeAdoptionDecision(
  candidateA: CandidateFitAssessment,
  candidateB: CandidateFitAssessment,
  forceCrossDomain?: boolean,
): FitCompareDecision {
  const blockingReasons: string[] = [];

  // Check for abstention: degraded analysis
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
    return buildFitAbstention(blockingReasons, "degraded-analysis");
  }

  // Domain mismatch: abstain unless forced or compatible
  const domainA = candidateA.result.domainInference?.domain;
  const domainB = candidateB.result.domainInference?.domain;
  const domainsKnown = domainA && domainB;
  const domainsMismatch = domainsKnown && domainA !== domainB;
  const eitherCrossDomainCompatible =
    CROSS_DOMAIN_COMPATIBLE.has(domainA ?? "") || CROSS_DOMAIN_COMPATIBLE.has(domainB ?? "");
  let comparabilityStatus: ComparabilityStatus = "fully-comparable";

  if (domainsMismatch && !eitherCrossDomainCompatible) {
    if (!forceCrossDomain) {
      return buildFitAbstention(
        [
          `Domain mismatch: ${candidateA.packageName} is "${domainA}", ${candidateB.packageName} is "${domainB}" — use --force-cross-domain to compare anyway`,
        ],
        "domain-mismatch",
      );
    }
    comparabilityStatus = "cross-domain-forced";
  }

  // Codebase relevance: abstain when both candidates have low relevance
  if (
    (candidateA.codebaseRelevance ?? 0) < MIN_CODEBASE_RELEVANCE &&
    (candidateB.codebaseRelevance ?? 0) < MIN_CODEBASE_RELEVANCE
  ) {
    return buildFitAbstention(
      [
        `Both candidates have low codebase relevance: ${candidateA.packageName} (${candidateA.codebaseRelevance ?? 0}) and ${candidateB.packageName} (${candidateB.codebaseRelevance ?? 0}) — neither fits the codebase well`,
      ],
      "low-codebase-relevance",
    );
  }

  // Both require human review with high migration risk: abstain
  if (
    candidateA.migrationRisk.requiresHumanReview &&
    candidateB.migrationRisk.requiresHumanReview
  ) {
    const riskA = migrationRiskLevel(candidateA.migrationRisk);
    const riskB = migrationRiskLevel(candidateB.migrationRisk);
    // Both high risk = abstain
    if (riskA >= 7 && riskB >= 7) {
      return buildFitAbstention(
        [
          `Both ${candidateA.packageName} and ${candidateB.packageName} require human review with high migration risk`,
        ],
        "both-require-human-review",
      );
    }
  }

  // Track directional-only status
  if (trustA?.classification === "directional" || trustB?.classification === "directional") {
    comparabilityStatus = "directional-only";
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

  // Confidence: blend of trust, fit delta clarity, and domain compatibility
  const trustConfA = trustClassificationToScore(trustA?.classification);
  const trustConfB = trustClassificationToScore(trustB?.classification);
  const trustConfidence = Math.min(trustConfA, trustConfB);
  const deltaClarity = Math.min(Math.abs(fitDelta) / 20, 1);
  const domainConf = (candidateA.domainCompatibility + candidateB.domainCompatibility) / 200;
  const decisionConfidence =
    Math.round((0.4 * trustConfidence + 0.3 * deltaClarity + 0.3 * domainConf) * 100) / 100;

  // Determine outcome with stricter thresholds
  let outcome: ComparisonOutcome = "equivalent";
  let winner: string | null = null;

  if (Math.abs(fitDelta) >= 5) {
    if (Math.abs(fitDelta) < MIN_FIT_DELTA_LOW_CONFIDENCE && decisionConfidence < 0.7) {
      // Close delta with low confidence: stay equivalent
    } else {
      ({ outcome, winner } = determineFitOutcome(
        fitDelta,
        candidateA.packageName,
        candidateB.packageName,
      ));
    }
  }

  return {
    blockingReasons: [],
    comparabilityStatus,
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
  const risk = candidate.migrationRisk;

  const codebaseIssues = codebase.dimensions.flatMap((dd) => dd.issues);
  const directIssues = codebaseIssues.filter((ii) => ii.fixability === "direct");

  if (directIssues.length > 0) {
    const count = Math.min(directIssues.length, 10);
    batches.push(`Fix ${count} directly fixable type issues in your codebase`);
  }

  if (risk.apiMismatchRisk !== "low") {
    const touchPoints = risk.estimatedTouchPoints;
    const callSites = risk.estimatedCallSiteChanges ?? touchPoints * 3;
    batches.push(
      `Review API surface compatibility — ${touchPoints} files, ~${callSites} call sites may need updates`,
    );
  }

  if (risk.typeSafetyGap !== undefined && risk.typeSafetyGap > 10) {
    batches.push(
      `Close the ${Math.round(risk.typeSafetyGap)}-point type safety gap by adding strict return types`,
    );
  }

  if (risk.boundaryCoverageGap !== undefined && risk.boundaryCoverageGap > 0.2) {
    batches.push(
      `Bridge boundary coverage gap (${Math.round(risk.boundaryCoverageGap * 100)}%) — add validation at I/O boundaries`,
    );
  }

  if (candidate.result.domainScore) {
    const { domain } = candidate.result.domainScore;
    batches.push(`Verify domain-specific patterns align with ${domain} conventions`);
  }

  if (risk.requiresHumanReview) {
    batches.push("Human review required before adoption — high typing or API risk detected");
  }

  return batches;
}
