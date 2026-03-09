import type {
  AnalysisResult,
  ComparisonDecisionReport,
  ComparisonOutcome,
  MetricDelta,
  MetricProvenance,
  TrustSummary,
} from "./types.js";
import { type ScorePackageOptions, scorePackage } from "./package-scorer.js";

/** Minimum composite delta to be considered significant */
const SIGNIFICANCE_THRESHOLD = 5;

/** Balanced-trust composite weights for decision scoring */
const DECISION_WEIGHTS: Record<string, number> = {
  agentReadiness: 0.15,
  consumerApi: 0.25,
  typeSafety: 0.35,
};

/** Dimension weights used when composites include dimension-level metrics */
const DIMENSION_DECISION_WEIGHTS: Record<string, number> = {
  boundaryDiscipline: 0.1,
  declarationFidelity: 0.15,
};

export interface CompareOptions extends ScorePackageOptions {
  /** If true, include rendered text comparison in the result */
  render?: boolean;
}

export interface CompareResult {
  resultA: AnalysisResult;
  resultB: AnalysisResult;
  rendered?: string;
  /** Decision report with recommendation, blockers, and provenance */
  decision: ComparisonDecisionReport;
}

/**
 * Compare two packages side-by-side on type precision quality.
 *
 * @example
 * ```ts
 * import { comparePackages } from "typegrade";
 * const { resultA, resultB, decision } = comparePackages("zod", "yup");
 * console.log(decision.outcome, decision.winner);
 * ```
 */
export function comparePackages(
  pkgA: string,
  pkgB: string,
  options?: CompareOptions,
): CompareResult {
  const scoreOpts: ScorePackageOptions = {};
  if (options?.domain !== undefined) {
    scoreOpts.domain = options.domain;
  }
  if (options?.typesVersion !== undefined) {
    scoreOpts.typesVersion = options.typesVersion;
  }
  if (options?.noCache !== undefined) {
    scoreOpts.noCache = options.noCache;
  }
  const resultA = scorePackage(pkgA, scoreOpts);
  const resultB = scorePackage(pkgB, scoreOpts);

  const decision = computeDecisionReport({ nameA: pkgA, nameB: pkgB, resultA, resultB });
  const result: CompareResult = { decision, resultA, resultB };

  if (options?.render) {
    result.rendered = renderTextComparison({ nameA: pkgA, nameB: pkgB, resultA, resultB });
  }

  return result;
}

interface DecisionInput {
  nameA: string;
  nameB: string;
  resultA: AnalysisResult;
  resultB: AnalysisResult;
}

/**
 * Compute a comparison decision report from two analysis results.
 */
function computeDecisionReport(input: DecisionInput): ComparisonDecisionReport {
  const { nameA, nameB, resultA, resultB } = input;
  const trustA = resultA.trustSummary ?? buildFallbackTrust(resultA);
  const trustB = resultB.trustSummary ?? buildFallbackTrust(resultB);

  const blockingReasons: string[] = [];

  // Abstention: either result is abstained
  if (trustA.classification === "abstained") {
    blockingReasons.push(`${nameA} analysis abstained: ${trustA.reasons[0] ?? "unknown"}`);
  }
  if (trustB.classification === "abstained") {
    blockingReasons.push(`${nameB} analysis abstained: ${trustB.reasons[0] ?? "unknown"}`);
  }
  if (blockingReasons.length > 0) {
    return buildAbstainedReport(blockingReasons, trustA, trustB);
  }

  // Incomparability: either result not comparable
  if (resultA.scoreValidity === "not-comparable") {
    blockingReasons.push(`${nameA} scores are not comparable`);
  }
  if (resultB.scoreValidity === "not-comparable") {
    blockingReasons.push(`${nameB} scores are not comparable`);
  }
  if (!trustA.canCompare) {
    blockingReasons.push(`${nameA} trust does not support comparison`);
  }
  if (!trustB.canCompare) {
    blockingReasons.push(`${nameB} trust does not support comparison`);
  }
  if (blockingReasons.length > 0) {
    return buildIncomparableReport(blockingReasons, trustA, trustB);
  }

  // Compute metric deltas — composites + dimension-level metrics
  const compositeKeys = ["consumerApi", "agentReadiness", "typeSafety"] as const;
  const metricDeltas: MetricDelta[] = [];
  const metricProvenance: MetricProvenance[] = [];

  for (const key of compositeKeys) {
    const compA = resultA.composites.find((cc) => cc.key === key);
    const compB = resultB.composites.find((cc) => cc.key === key);
    const valueA = compA?.score ?? null;
    const valueB = compB?.score ?? null;
    const delta = valueA !== null && valueB !== null ? valueA - valueB : null;
    const significant = delta !== null && Math.abs(delta) >= SIGNIFICANCE_THRESHOLD;

    metricDeltas.push({ delta, metric: key, significant, valueA, valueB });

    // Provenance
    const penalties: string[] = [];
    if (compA?.rationale) {
      for (const rr of compA.rationale) {
        if (rr.toLowerCase().includes("cap") || rr.toLowerCase().includes("penalty")) {
          penalties.push(`${nameA}: ${rr}`);
        }
      }
    }
    if (compB?.rationale) {
      for (const rr of compB.rationale) {
        if (rr.toLowerCase().includes("cap") || rr.toLowerCase().includes("penalty")) {
          penalties.push(`${nameB}: ${rr}`);
        }
      }
    }

    metricProvenance.push({
      confidence: Math.min(compA?.confidence ?? 0.5, compB?.confidence ?? 0.5),
      inputs: [`${nameA}.${key} = ${valueA ?? "null"}`, `${nameB}.${key} = ${valueB ?? "null"}`],
      metric: key,
      penaltiesApplied: penalties,
    });
  }

  // Dimension-level metrics: declarationFidelity, boundaryDiscipline
  for (const dimKey of Object.keys(DIMENSION_DECISION_WEIGHTS)) {
    const dimA = resultA.dimensions.find((dd) => dd.key === dimKey);
    const dimB = resultB.dimensions.find((dd) => dd.key === dimKey);
    const valueA = dimA?.score ?? null;
    const valueB = dimB?.score ?? null;
    const delta = valueA !== null && valueB !== null ? valueA - valueB : null;
    const significant = delta !== null && Math.abs(delta) >= SIGNIFICANCE_THRESHOLD;

    metricDeltas.push({ delta, metric: dimKey, significant, valueA, valueB });
    metricProvenance.push({
      confidence: Math.min(dimA?.confidence ?? 0.5, dimB?.confidence ?? 0.5),
      inputs: [
        `${nameA}.${dimKey} = ${valueA ?? "null"}`,
        `${nameB}.${dimKey} = ${valueB ?? "null"}`,
      ],
      metric: dimKey,
      penaltiesApplied: [],
    });
  }

  // Domain score delta (if both have domain scores for the same domain)
  if (
    resultA.domainScore &&
    resultB.domainScore &&
    resultA.domainScore.domain === resultB.domainScore.domain
  ) {
    const delta = resultA.domainScore.score - resultB.domainScore.score;
    metricDeltas.push({
      delta,
      metric: `domainFit:${resultA.domainScore.domain}`,
      significant: Math.abs(delta) >= SIGNIFICANCE_THRESHOLD,
      valueA: resultA.domainScore.score,
      valueB: resultB.domainScore.score,
    });
  }

  // Scenario score delta (if both have scenario scores for the same domain)
  if (
    resultA.scenarioScore &&
    resultB.scenarioScore &&
    resultA.scenarioScore.domain === resultB.scenarioScore.domain
  ) {
    const delta = resultA.scenarioScore.score - resultB.scenarioScore.score;
    metricDeltas.push({
      delta,
      metric: `scenario:${resultA.scenarioScore.domain}`,
      significant: Math.abs(delta) >= SIGNIFICANCE_THRESHOLD,
      valueA: resultA.scenarioScore.score,
      valueB: resultB.scenarioScore.score,
    });
  }

  // Compute decision scores (weighted sum of composites with penalties)
  const decisionScoreA = computeDecisionScore(resultA, nameA);
  const decisionScoreB = computeDecisionScore(resultB, nameB);

  // Decision confidence
  const decisionConfidence = computeDecisionConfidence({
    resultA,
    resultB,
    scoreA: decisionScoreA,
    scoreB: decisionScoreB,
    trustA,
    trustB,
  });

  // Count significant deltas favoring each side
  const significantDeltas = metricDeltas.filter((md) => md.significant && md.delta !== null);
  const favorA = significantDeltas.filter((md) => md.delta! > 0).length;
  const favorB = significantDeltas.filter((md) => md.delta! < 0).length;
  const scoreDelta = Math.abs((decisionScoreA ?? 0) - (decisionScoreB ?? 0));

  // Determine outcome
  let outcome: ComparisonOutcome = "equivalent";
  let winner: string | null = null;

  if (significantDeltas.length === 0 || scoreDelta < 3) {
    outcome = "equivalent";
  } else if (favorA >= 2 && scoreDelta >= 8 && decisionConfidence >= 0.6) {
    outcome = "clear-winner";
    winner = nameA;
  } else if (favorB >= 2 && scoreDelta >= 8 && decisionConfidence >= 0.6) {
    outcome = "clear-winner";
    winner = nameB;
  } else if (
    favorA > favorB ||
    (favorA === favorB && (decisionScoreA ?? 0) > (decisionScoreB ?? 0))
  ) {
    outcome = "marginal-winner";
    winner = nameA;
  } else if (
    favorB > favorA ||
    (favorA === favorB && (decisionScoreB ?? 0) > (decisionScoreA ?? 0))
  ) {
    outcome = "marginal-winner";
    winner = nameB;
  }

  // Build top reasons with granular explanations
  const topReasons = buildTopReasons({
    deltas: metricDeltas,
    nameA,
    nameB,
    resultA,
    resultB,
  });

  return {
    blockingReasons: [],
    decisionConfidence,
    decisionScoreA,
    decisionScoreB,
    metricDeltas,
    metricProvenance,
    outcome,
    topReasons,
    trustA,
    trustB,
    winner,
  };
}

/**
 * Compute a weighted decision score for a single package result.
 * Uses composites + dimension-level metrics with penalty adjustments.
 */
function computeDecisionScore(result: AnalysisResult, _name: string): number | null {
  let totalWeight = 0;
  let weightedSum = 0;
  let nullCount = 0;

  // Composite-level metrics
  for (const [key, weight] of Object.entries(DECISION_WEIGHTS)) {
    const comp = result.composites.find((cc) => cc.key === key);
    if (comp?.score !== null && comp?.score !== undefined) {
      weightedSum += comp.score * weight;
      totalWeight += weight;
    } else {
      nullCount++;
    }
  }

  // Dimension-level metrics (declarationFidelity, boundaryDiscipline)
  for (const [dimKey, weight] of Object.entries(DIMENSION_DECISION_WEIGHTS)) {
    const dim = result.dimensions.find((dd) => dd.key === dimKey);
    if (dim?.score !== null && dim?.score !== undefined) {
      weightedSum += dim.score * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0 || nullCount === Object.keys(DECISION_WEIGHTS).length) {
    return null;
  }

  // Renormalize weights for missing metrics
  let score = weightedSum / totalWeight;

  // Apply penalties
  if (result.status === "degraded") {
    score -= 25;
  }
  if (result.scoreValidity === "partially-comparable") {
    score -= 15;
  }
  if (result.coverageDiagnostics?.undersampled) {
    score -= 10;
  }
  if (result.coverageDiagnostics?.coverageFailureMode === "fallback-glob") {
    score -= 10;
  }
  // Domain mismatch penalty: missing domain detection penalizes slightly
  if (result.domainInference && result.domainInference.confidence < 0.5) {
    score -= 5;
  }
  // Low publish quality penalty
  const publishDim = result.dimensions.find((dd) => dd.key === "publishQuality");
  if (publishDim?.score !== null && publishDim?.score !== undefined && publishDim.score < 40) {
    score -= 5;
  }

  return Math.max(0, Math.round(score * 10) / 10);
}

interface ConfidenceInput {
  trustA: TrustSummary;
  trustB: TrustSummary;
  resultA: AnalysisResult;
  resultB: AnalysisResult;
  scoreA: number | null;
  scoreB: number | null;
}

/**
 * Compute confidence in the comparison decision.
 */
function computeDecisionConfidence(input: ConfidenceInput): number {
  const { trustA, trustB, resultA, resultB, scoreA, scoreB } = input;
  // Trust score: min of both
  const trustScoreMap: Record<string, number> = {
    abstained: 0,
    directional: 0.6,
    trusted: 1,
  };
  const tA = trustScoreMap[trustA.classification] ?? 0.5;
  const tB = trustScoreMap[trustB.classification] ?? 0.5;
  const trustScore = Math.min(tA, tB);

  // Coverage score: average of both
  const csA = resultA.confidenceSummary;
  const csB = resultB.confidenceSummary;
  const covA = csA ? (csA.sampleCoverage + csA.graphResolution) / 2 : 0.5;
  const covB = csB ? (csB.sampleCoverage + csB.graphResolution) / 2 : 0.5;
  const coverageScore = (covA + covB) / 2;

  // Delta clarity: larger score differences are more confident
  const deltaClarity =
    scoreA !== null && scoreB !== null ? Math.min(Math.abs(scoreA - scoreB) / 12, 1) : 0;

  const confidence = 0.5 * trustScore + 0.3 * coverageScore + 0.2 * deltaClarity;
  return Math.round(confidence * 100) / 100;
}

interface TopReasonsInput {
  deltas: MetricDelta[];
  nameA: string;
  nameB: string;
  resultA?: AnalysisResult;
  resultB?: AnalysisResult;
}

/**
 * Build top reasons from significant metric deltas with granular explanations.
 */
function buildTopReasons(input: TopReasonsInput): string[] {
  const { deltas, nameA, nameB, resultA, resultB } = input;
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    boundaryDiscipline: "Boundary Discipline",
    consumerApi: "Consumer API",
    declarationFidelity: "Declaration Fidelity",
    typeSafety: "Type Safety",
  };

  return deltas
    .filter((md) => md.significant && md.delta !== null)
    .toSorted((lhs, rhs) => Math.abs(rhs.delta!) - Math.abs(lhs.delta!))
    .slice(0, 5)
    .map((md) => {
      const label = labels[md.metric] ?? md.metric;
      const favors = md.delta! > 0 ? nameA : nameB;
      const detail = buildReasonDetail({ md, nameA, nameB, resultA, resultB });
      if (detail) {
        return `${label}: ${favors} leads by ${Math.abs(md.delta!)} points (${detail})`;
      }
      return `${label}: ${favors} leads by ${Math.abs(md.delta!)} points`;
    });
}

interface ReasonDetailInput {
  md: MetricDelta;
  nameA: string;
  nameB: string;
  resultA?: AnalysisResult | undefined;
  resultB?: AnalysisResult | undefined;
}

/**
 * Build a detail explanation for a specific metric delta.
 */
function buildReasonDetail(input: ReasonDetailInput): string | null {
  const { md, nameA, nameB, resultA, resultB } = input;
  if (!resultA || !resultB) {
    return null;
  }

  // For composite metrics, look at underlying dimension contributions
  if (md.metric === "typeSafety") {
    const anyA = resultA.dimensions.find((dd) => dd.key === "anyLeakage");
    const anyB = resultB.dimensions.find((dd) => dd.key === "anyLeakage");
    const scoreA = anyA?.score;
    const scoreB = anyB?.score;
    if (
      scoreA !== null &&
      scoreA !== undefined &&
      scoreB !== null &&
      scoreB !== undefined &&
      Math.abs(scoreA - scoreB) >= 5
    ) {
      const better = scoreA > scoreB ? nameA : nameB;
      return `${better} has less any-type leakage`;
    }
  }

  if (md.metric === "consumerApi") {
    const specA = resultA.dimensions.find((dd) => dd.key === "apiSpecificity");
    const specB = resultB.dimensions.find((dd) => dd.key === "apiSpecificity");
    const scoreA = specA?.score;
    const scoreB = specB?.score;
    if (
      scoreA !== null &&
      scoreA !== undefined &&
      scoreB !== null &&
      scoreB !== undefined &&
      Math.abs(scoreA - scoreB) >= 5
    ) {
      const better = scoreA > scoreB ? nameA : nameB;
      return `${better} has more specific API types`;
    }
  }

  if (md.metric === "declarationFidelity") {
    return "measures how well declaration files represent the implementation";
  }

  if (md.metric === "boundaryDiscipline") {
    return "measures validation of data crossing trust boundaries";
  }

  if (md.metric.startsWith("domainFit:")) {
    return "domain-adjusted scoring for this library category";
  }

  if (md.metric.startsWith("scenario:")) {
    return "consumer benchmark scenario tests";
  }

  return null;
}

/**
 * Build a fallback trust summary when trustSummary is not present.
 */
function buildFallbackTrust(result: AnalysisResult): TrustSummary {
  if (result.status === "degraded") {
    return {
      canCompare: false,
      canGate: false,
      classification: "abstained",
      reasons: [result.degradedReason ?? "Analysis degraded"],
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
  return {
    canCompare: true,
    canGate: true,
    classification: "trusted",
    reasons: [],
  };
}

function buildAbstainedReport(
  blockingReasons: string[],
  trustA: TrustSummary,
  trustB: TrustSummary,
): ComparisonDecisionReport {
  return {
    blockingReasons,
    decisionConfidence: 0,
    decisionScoreA: null,
    decisionScoreB: null,
    metricDeltas: [],
    metricProvenance: [],
    outcome: "abstained",
    topReasons: [],
    trustA,
    trustB,
    winner: null,
  };
}

function buildIncomparableReport(
  blockingReasons: string[],
  trustA: TrustSummary,
  trustB: TrustSummary,
): ComparisonDecisionReport {
  return {
    blockingReasons,
    decisionConfidence: 0,
    decisionScoreA: null,
    decisionScoreB: null,
    metricDeltas: [],
    metricProvenance: [],
    outcome: "incomparable",
    topReasons: [],
    trustA,
    trustB,
    winner: null,
  };
}

interface ComparisonInput {
  nameA: string;
  nameB: string;
  resultA: AnalysisResult;
  resultB: AnalysisResult;
}

function renderTextComparison(input: ComparisonInput): string {
  const { nameA, nameB, resultA, resultB } = input;
  const lines: string[] = [
    "",
    "  typegrade comparison",
    "",
    `  ${"".padEnd(22)}${nameA.padEnd(16)}${nameB.padEnd(16)}${"Delta"}`,
    `  ${"─".repeat(60)}`,
  ];

  const compositeKeys = ["consumerApi", "agentReadiness", "typeSafety"] as const;
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    consumerApi: "Consumer API",
    typeSafety: "Type Safety",
  };

  for (const key of compositeKeys) {
    const scoreA = resultA.composites.find((comp) => comp.key === key)?.score ?? 0;
    const scoreB = resultB.composites.find((comp) => comp.key === key)?.score ?? 0;
    const delta = scoreA - scoreB;
    let deltaStr = "0";
    if (delta > 0) {
      deltaStr = `+${delta}`;
    } else if (delta < 0) {
      deltaStr = `${delta}`;
    }
    const label = (labels[key] ?? key).padEnd(22);
    lines.push(`  ${label}${String(scoreA).padEnd(16)}${String(scoreB).padEnd(16)}${deltaStr}`);
  }

  // Domain scores if available
  if (resultA.domainScore || resultB.domainScore) {
    lines.push("");
    const domA = resultA.domainScore?.score ?? "n/a";
    const domB = resultB.domainScore?.score ?? "n/a";
    const domainLabel =
      `Domain Fit (${resultA.domainScore?.domain ?? resultB.domainScore?.domain ?? "?"})`.padEnd(
        22,
      );
    lines.push(`  ${domainLabel}${String(domA).padEnd(16)}${String(domB).padEnd(16)}`);
  }

  lines.push("");
  return lines.join("\n");
}
