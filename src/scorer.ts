import type { AnalysisMode, CompositeKey, CompositeScore, DimensionResult, Grade } from "./types.js";
import { AGENT_READINESS_WEIGHTS } from "./constants.js";

export function computeGrade(score: number | null): Grade {
  if (score === null) {return "N/A";}
  if (score >= 95) {return "A+";}
  if (score >= 85) {return "A";}
  if (score >= 70) {return "B";}
  if (score >= 55) {return "C";}
  if (score >= 40) {return "D";}
  return "F";
}

export function computeComposites(
  dimensions: DimensionResult[],
  mode: AnalysisMode,
): CompositeScore[] {
  const consumerApi = computeComposite("consumerApi", dimensions, mode);
  const implementationQuality = computeComposite("implementationQuality", dimensions, mode);
  const agentReadiness = computeAgentReadiness(consumerApi, implementationQuality, mode);

  return [agentReadiness, consumerApi, implementationQuality];
}

function computeComposite(
  key: CompositeKey,
  dimensions: DimensionResult[],
  mode: AnalysisMode,
): CompositeScore {
  const contributing = dimensions.filter(
    (dim) => dim.enabled && dim.score !== null && dim.weights[key] !== undefined && dim.weights[key]! > 0,
  );

  if (contributing.length === 0) {
    const isSourceOnly = key === "implementationQuality" && mode === "package";
    return {
      grade: isSourceOnly ? "N/A" : "F",
      key,
      rationale: isSourceOnly
        ? ["Not applicable for published declarations"]
        : ["No contributing dimensions"],
      score: isSourceOnly ? null : 0,
    };
  }

  let totalWeight = 0;
  let weightedSum = 0;
  const rationale: string[] = [];

  for (const dim of contributing) {
    const weight = dim.weights[key]!;
    totalWeight += weight;
    weightedSum += dim.score! * weight;
    rationale.push(`${dim.label}: ${Math.round(dim.score!)} (w=${weight})`);
  }

  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const confidence = computeConfidence(contributing);
  return { confidence, grade: computeGrade(score), key, rationale, score };
}

function computeConfidence(contributing: DimensionResult[]): number {
  if (contributing.length === 0) {return 0;}
  const sum = contributing.reduce((acc, dim) => acc + (dim.confidence ?? 0.8), 0);
  return Math.round((sum / contributing.length) * 100) / 100;
}

function computeAgentReadiness(
  consumerApi: CompositeScore,
  implementationQuality: CompositeScore,
  mode: AnalysisMode,
): CompositeScore {
  const rationale: string[] = [];

  if (mode === "package") {
    const {score} = consumerApi;
    rationale.push(`Package mode: 100% Consumer API (${score ?? "n/a"})`);
    return { grade: computeGrade(score), key: "agentReadiness", rationale, score };
  }

  if (consumerApi.score === null) {
    return { grade: "N/A", key: "agentReadiness", rationale: ["No data"], score: null };
  }

  const implScore = implementationQuality.score ?? 0;
  const sourceWeights = AGENT_READINESS_WEIGHTS.source;
  const score = Math.round(
    sourceWeights.consumerApi * consumerApi.score + sourceWeights.implementationQuality * implScore,
  );
  rationale.push(
    `${sourceWeights.consumerApi * 100}% Consumer API (${consumerApi.score}) + ${sourceWeights.implementationQuality * 100}% Implementation (${implScore})`,
  );

  return { grade: computeGrade(score), key: "agentReadiness", rationale, score };
}
