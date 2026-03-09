import type {
  AnalysisMode,
  AnalysisProfile,
  CompositeKey,
  CompositeScore,
  DimensionResult,
  Grade,
} from "./types.js";
import { PROFILE_WEIGHT_ADJUSTMENTS } from "./constants.js";

export function computeGrade(score: number | null): Grade {
  if (score === null) {
    return "N/A";
  }
  if (score >= 95) {
    return "A+";
  }
  if (score >= 85) {
    return "A";
  }
  if (score >= 70) {
    return "B";
  }
  if (score >= 55) {
    return "C";
  }
  if (score >= 40) {
    return "D";
  }
  return "F";
}

export function computeComposites(
  dimensions: DimensionResult[],
  mode: AnalysisMode,
  profile?: AnalysisProfile,
): CompositeScore[] {
  // Apply profile-aware weight adjustments if a profile is active
  const adjustedDimensions = profile ? applyProfileWeights(dimensions, profile) : dimensions;

  const consumerApi = computeComposite("consumerApi", adjustedDimensions, mode);
  const implementationQuality = computeComposite("implementationQuality", adjustedDimensions, mode);
  const typeSafety = computeComposite("typeSafety", adjustedDimensions, mode);
  const agentReadiness = computeComposite("agentReadiness", adjustedDimensions, mode);

  return [agentReadiness, consumerApi, typeSafety, implementationQuality];
}

/**
 * Apply profile-specific weight adjustments to dimension results.
 * Returns a new array with adjusted weights (does not mutate originals).
 */
function applyProfileWeights(
  dimensions: DimensionResult[],
  profile: AnalysisProfile,
): DimensionResult[] {
  const adjustments = PROFILE_WEIGHT_ADJUSTMENTS[profile];
  if (!adjustments || adjustments.length === 0) {
    return dimensions;
  }

  const adjustmentMap = new Map(adjustments.map((adj) => [adj.dimension, adj.weight]));

  return dimensions.map((dim) => {
    const multiplier = adjustmentMap.get(dim.key);
    if (!multiplier || multiplier === 1) {
      return dim;
    }

    // Shallow-clone and adjust all composite weights by the multiplier
    const adjustedWeights: Record<string, number> = {};
    for (const [compositeKey, weight] of Object.entries(dim.weights)) {
      adjustedWeights[compositeKey] = weight * multiplier;
    }

    return { ...dim, weights: adjustedWeights };
  });
}

function computeComposite(
  key: CompositeKey,
  dimensions: DimensionResult[],
  mode: AnalysisMode,
): CompositeScore {
  // Filter: enabled, has score, has weight, and applicable (not_applicable excluded entirely)
  const contributing = dimensions.filter(
    (dim) =>
      dim.enabled &&
      dim.score !== null &&
      dim.weights[key] !== undefined &&
      (dim.weights[key] ?? 0) > 0 &&
      dim.applicability !== "not_applicable",
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
    const baseWeight = dim.weights[key] ?? 0;
    const score = dim.score ?? 0;
    // Reduce weight for insufficient_evidence dimensions (half weight)
    const weight = dim.applicability === "insufficient_evidence" ? baseWeight * 0.5 : baseWeight;
    totalWeight += weight;
    weightedSum += score * weight;
    const suffix = dim.applicability === "insufficient_evidence" ? " [insufficient evidence]" : "";
    rationale.push(`${dim.label}: ${Math.round(score)} (w=${weight.toFixed(2)})${suffix}`);
  }

  const rawScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const { confidence, reasons } = computeConfidence(contributing);

  // Confidence-weighted score moderation:
  // When confidence is low, moderate the score toward a conservative baseline.
  // This prevents high scores from packages with thin or contradictory evidence.
  // Only applies when confidence < 0.7 and raw score is above baseline.
  const MODERATION_BASELINE = 50;
  const MODERATION_THRESHOLD = 0.7;
  let score = rawScore;
  if (confidence < MODERATION_THRESHOLD && rawScore > MODERATION_BASELINE) {
    // Linear interpolation: at confidence=0.7 no moderation, at confidence=0.3 full moderation
    const moderationStrength = Math.min(1, (MODERATION_THRESHOLD - confidence) / 0.4);
    const pullDown = (rawScore - MODERATION_BASELINE) * moderationStrength * 0.3;
    score = Math.round(rawScore - pullDown);
    if (pullDown >= 1) {
      reasons.push(
        `Score moderated by ${Math.round(pullDown)} points (confidence=${confidence}, raw=${rawScore})`,
      );
    }
  }

  return {
    compositeConfidenceReasons: reasons,
    confidence,
    grade: computeGrade(score),
    key,
    rationale,
    score,
  };
}

function computeConfidence(contributing: DimensionResult[]): {
  confidence: number;
  reasons: string[];
} {
  if (contributing.length === 0) {
    return { confidence: 0, reasons: ["No contributing dimensions"] };
  }

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
    reasons.push(
      `Average dimension confidence (${Math.round(avgConfidence * 100)}%) higher than bottleneck`,
    );
  }

  return { confidence, reasons };
}
