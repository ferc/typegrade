import type { AnalysisMode, CompositeKey, CompositeScore, DimensionResult, Grade } from "./types.js";

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
  const typeSafety = computeComposite("typeSafety", dimensions, mode);
  const agentReadiness = computeComposite("agentReadiness", dimensions, mode);

  return [agentReadiness, consumerApi, typeSafety, implementationQuality];
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
  const { confidence, reasons } = computeConfidence(contributing);
  return {
    compositeConfidenceReasons: reasons,
    confidence,
    grade: computeGrade(score),
    key,
    rationale,
    score,
  };
}

function computeConfidence(contributing: DimensionResult[]): { confidence: number; reasons: string[] } {
  if (contributing.length === 0) {return { confidence: 0, reasons: ["No contributing dimensions"] };}

  const reasons: string[] = [];
  let minConfidence = 1;
  let minDimension = "";

  for (const dim of contributing) {
    const dimConfidence = dim.confidence ?? 0.8;
    if (dimConfidence < minConfidence) {
      minConfidence = dimConfidence;
      minDimension = dim.label;
    }
  }

  if (minDimension) {
    reasons.push(`Bottleneck: ${minDimension} (confidence=${minConfidence})`);
  }

  // Weighted evidence score: use weighted average with min as floor
  let totalWeight = 0;
  let weightedConfidence = 0;
  for (const dim of contributing) {
    const dimConf = dim.confidence ?? 0.8;
    totalWeight += 1;
    weightedConfidence += dimConf;
  }
  const avgConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // Composite = 60% min + 40% average (evidence-weighted)
  const composite = 0.6 * minConfidence + 0.4 * avgConfidence;
  const confidence = Math.round(composite * 100) / 100;

  if (avgConfidence > minConfidence + 0.1) {
    reasons.push(`Average dimension confidence (${Math.round(avgConfidence * 100)}%) higher than bottleneck`);
  }

  return { confidence, reasons };
}
