import type { ConfidenceSignal, DimensionResult, Issue } from "../types.js";
import type { PublicSurface, SurfacePosition, SurfaceTypeParam } from "../surface/index.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { TypeNode } from "ts-morph";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "semanticLift")!;

const ADVANCED_FEATURES = new Set([
  "branded",
  "conditional-type",
  "constrained-generic",
  "constraint-basic",
  "constraint-strong",
  "constraint-structural",
  "discriminated-union",
  "indexed-access",
  "infer",
  "literal-union",
  "mapped-type",
  "template-literal",
  "tuple",
]);

/** Per-feature widened baselines — what the score would be without the feature */
const FEATURE_BASELINES: Record<string, number> = {
  // Unbranded primitive
  branded: 40,
  "conditional-type": 40,
  // Unconstrained generic equivalent
  "constrained-generic": 35,
  "constraint-basic": 35,
  "constraint-strong": 35,
  "constraint-structural": 35,
  // Avg-of-members-without-discriminant approx
  "discriminated-union": 40,
  "indexed-access": 40,
  infer: 40,
  // Wide primitive equivalent
  "literal-union": 40,
  "mapped-type": 40,
  // Wide string equivalent
  "template-literal": 40,
  tuple: 40,
};

const DEFAULT_BASELINE = 40;

/** Per-feature scaling — how much actual semantic benefit each feature provides */
const FEATURE_LIFT_SCALE: Record<string, number> = {
  // High: fully eliminates type confusion
  branded: 1.2,
  // Medium: can be opaque
  "conditional-type": 0.9,
  // Standard
  "constrained-generic": 1,
  // Low: minimal narrowing
  "constraint-basic": 0.7,
  // Above standard
  "constraint-strong": 1.1,
  "constraint-structural": 0.9,
  // High: enables exhaustive matching
  "discriminated-union": 1.3,
  "indexed-access": 0.8,
  infer: 1,
  // High: very specific
  "literal-union": 1.1,
  // Medium: can be complex without benefit
  "mapped-type": 0.8,
  "template-literal": 0.9,
  tuple: 0.9,
};

interface PerFeatureLiftStats {
  count: number;
  totalLift: number;
  avgLift: number;
}

/** Count how many features in a list are "advanced" */
function countAdvancedFeatures(features: string[]): number {
  let count = 0;
  for (const feat of features) {
    if (ADVANCED_FEATURES.has(feat)) {
      count++;
    }
  }
  return count;
}

/**
 * Complexity discount: if a position uses >3 advanced features but
 * the actual precision score is < 50, the features aren't actually
 * helping the consumer — reduce the lift to penalize type-level
 * complexity theater.
 *
 * Returns a multiplier in (0, 1] — 1 means no discount.
 */
function computeComplexityDiscount(features: string[], precisionScore: number): number {
  const advancedCount = countAdvancedFeatures(features);
  if (advancedCount > 3 && precisionScore < 50) {
    // The more features with a low score, the harsher the discount.
    // 4 features → 0.7, 5 → 0.6, 6+ → 0.5
    return Math.max(0.5, 1 - (advancedCount - 3) * 0.1);
  }
  return 1;
}

function computeWidenedBaseline(features: string[]): number {
  let maxBaseline = 0;
  let hasAdvanced = false;

  for (const feat of features) {
    if (ADVANCED_FEATURES.has(feat)) {
      hasAdvanced = true;
      const baseline = FEATURE_BASELINES[feat] ?? DEFAULT_BASELINE;
      maxBaseline = Math.max(maxBaseline, baseline);
    }
  }

  if (!hasAdvanced) {
    // Signals no advanced features — position has no lift
    return -1;
  }

  return maxBaseline;
}

/** Identify the primary advanced feature for a position (highest-scaling one) */
function getPrimaryFeature(features: string[]): string | undefined {
  let best: string | undefined = undefined;
  let bestScale = -1;
  for (const feat of features) {
    if (!ADVANCED_FEATURES.has(feat)) {
      continue;
    }
    const scale = FEATURE_LIFT_SCALE[feat] ?? 1;
    if (scale > bestScale) {
      bestScale = scale;
      best = feat;
    }
  }
  return best;
}

function countGenericCorrelation(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: { name: string; typeNode: TypeNode | undefined }[],
  returnTypeNode: TypeNode | undefined,
): number {
  if (typeParams.length === 0 || !returnTypeNode) {
    return 0;
  }
  let count = 0;
  const paramNames = new Set(typeParams.map((tp) => tp.name));
  const returnText = returnTypeNode.getText();
  for (const name of paramNames) {
    const usedInParams = paramTypeNodes.some(
      (pt) => pt.typeNode && pt.typeNode.getText().includes(name),
    );
    if (usedInParams && returnText.includes(name)) {
      count++;
    }
  }
  return count;
}

export function analyzeSemanticLift(surface: PublicSurface): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  let totalPositions = 0;
  let liftedPositions = 0;
  let totalScaledLift = 0;
  let correlationCount = 0;
  const featuresSeen = new Set<string>();
  const perFeatureLift = new Map<string, PerFeatureLiftStats>();

  // Instantiated baseline: for generic declarations, check if the generic
  // Structure adds real value when instantiated (not just type-level complexity)
  let instantiatedLiftPositions = 0;

  // New metrics
  // Positions with lift > 15 above baseline
  let effectiveLiftPositions = 0;
  // Positions where complexity discount applied
  let complexityDiscountedPositions = 0;
  // Highest single-position lift value
  let maxLift = 0;

  function processPosition(pos: SurfacePosition): void {
    totalPositions++;
    const result = analyzePrecision(pos.type);
    const widenedBaseline = computeWidenedBaseline(result.features);

    // Baseline A: widened (erase advanced typing)
    const baselineA = widenedBaseline >= 0 ? widenedBaseline : -1;

    // Baseline B: instantiated — for generic positions, check if the type
    // Would still be meaningful when generics are specialized.
    // A generic that constrains well lifts more than one that stays opaque.
    const baselineB = computeInstantiatedBaseline(pos, result.features);

    // Use the better (higher) baseline — lift must exceed both
    const effectiveBaseline = Math.max(baselineA, baselineB);

    if (effectiveBaseline >= 0 && result.score > effectiveBaseline) {
      liftedPositions++;
      if (baselineB > baselineA && baselineB >= 0) {
        instantiatedLiftPositions++;
      }
      const rawLift = result.score - effectiveBaseline;
      const primaryFeature = getPrimaryFeature(result.features);
      const scale = primaryFeature ? (FEATURE_LIFT_SCALE[primaryFeature] ?? 1) : 1;

      // Apply complexity discount — penalize positions with many advanced
      // Features that don't actually produce a high precision score
      const discount = computeComplexityDiscount(result.features, result.score);
      if (discount < 1) {
        complexityDiscountedPositions++;
      }

      const scaledLift = rawLift * scale * discount;
      totalScaledLift += scaledLift;

      // Track max single-position lift
      if (scaledLift > maxLift) {
        maxLift = scaledLift;
      }

      // Track effective lift — positions with meaningful improvement (>15 above baseline)
      if (rawLift > 15) {
        effectiveLiftPositions++;
      }

      for (const feat of result.features) {
        if (!ADVANCED_FEATURES.has(feat)) {
          continue;
        }
        featuresSeen.add(feat);
        if (feat === primaryFeature) {
          const existing = perFeatureLift.get(feat);
          if (existing) {
            existing.count++;
            existing.totalLift += scaledLift;
            existing.avgLift = existing.totalLift / existing.count;
          } else {
            perFeatureLift.set(feat, { avgLift: scaledLift, count: 1, totalLift: scaledLift });
          }
        }
      }
    }
  }

  for (const decl of surface.declarations) {
    if (decl.kind === "enum") {
      continue;
    }

    // Process declaration positions
    for (const pos of decl.positions) {
      processPosition(pos);
    }

    // Process interface method positions (not in declaration.positions for interfaces)
    if (decl.kind === "interface" && decl.methods) {
      for (const method of decl.methods) {
        for (const pos of method.positions) {
          processPosition(pos);
        }
        // Generic correlation for interface methods
        correlationCount += countGenericCorrelation(
          method.typeParameters,
          method.paramTypeNodes,
          method.returnTypeNode,
        );
      }
    }

    // Generic correlation for functions
    if (decl.kind === "function") {
      correlationCount += countGenericCorrelation(
        decl.typeParameters,
        decl.paramTypeNodes ?? [],
        decl.returnTypeNode,
      );
    }

    // Generic correlation for class methods
    if (decl.kind === "class" && decl.methods) {
      for (const method of decl.methods) {
        correlationCount += countGenericCorrelation(
          method.typeParameters,
          method.paramTypeNodes,
          method.returnTypeNode,
        );
      }
    }
  }

  if (totalPositions === 0) {
    return {
      applicability: "applicable",
      applicabilityReasons: [],
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: {
        complexityDiscountedPositions: 0,
        correlationCount: 0,
        diversityBonus: 0,
        effectiveLiftBonus: 0,
        effectiveLiftPositions: 0,
        featureCount: 0,
        liftedPositions: 0,
        maxLift: 0,
        totalPositions: 0,
      },
      negatives: ["No exported type positions found"],
      positives: [],
      score: 0,
      weights: CONFIG.weights,
    };
  }

  const liftRatio = liftedPositions / totalPositions;
  const scaledMeanLift = totalScaledLift / Math.max(1, liftedPositions);
  const correlationBonus = Math.min(correlationCount * 8, 20);
  const diversityBonus = Math.min(featuresSeen.size * 2, 10);

  // Effective lift bonus — reward libraries where advanced types actually help consumers
  // Each position with lift > 15 contributes a small bonus (capped at 8)
  const effectiveLiftRatio = effectiveLiftPositions / Math.max(1, totalPositions);
  const effectiveLiftBonus = Math.min(Math.round(effectiveLiftRatio * 16), 8);

  let score = Math.round(
    liftRatio * 35 + scaledMeanLift * 0.7 + correlationBonus + diversityBonus + effectiveLiftBonus,
  );
  score = Math.max(0, Math.min(100, score));

  // Build positives/negatives — include top features by lift contribution
  const sortedFeatures = [...perFeatureLift.entries()].toSorted(
    (lhs, rhs) => rhs[1].totalLift - lhs[1].totalLift,
  );

  if (sortedFeatures.length > 0) {
    const topFeatures = sortedFeatures
      .slice(0, 3)
      .map(
        ([name, stats]) =>
          `${name} (${stats.count}x, avg lift ${Math.round(stats.avgLift * 10) / 10})`,
      );
    positives.push(`Top features by lift: ${topFeatures.join(", ")}`);
  }
  if (featuresSeen.size > 0) {
    positives.push(`Advanced features: ${[...featuresSeen].toSorted().join(", ")}`);
  }
  if (liftedPositions > 0) {
    positives.push(
      `${liftedPositions}/${totalPositions} positions use advanced typing above baseline`,
    );
  }
  if (correlationCount > 0) {
    positives.push(`${correlationCount} correlated generic(s)`);
  }
  if (featuresSeen.size >= 3) {
    positives.push(
      `Feature diversity bonus: +${diversityBonus} (${featuresSeen.size} distinct features)`,
    );
  }
  if (instantiatedLiftPositions > 0) {
    positives.push(`${instantiatedLiftPositions} positions with lift above instantiated baseline`);
  }
  if (effectiveLiftPositions > 0) {
    positives.push(
      `${effectiveLiftPositions} positions with effective lift (>15 above baseline, bonus +${effectiveLiftBonus})`,
    );
  }
  if (complexityDiscountedPositions > 0) {
    negatives.push(
      `${complexityDiscountedPositions} positions have complex typing that doesn't improve precision`,
    );
  }
  if (score < 15) {
    negatives.push("Limited use of advanced type-system features for semantic lift");
  }

  // Build per-feature lift metrics for reporting
  const perFeatureMetrics: Record<string, string> = {};
  for (const [feature, stats] of perFeatureLift) {
    perFeatureMetrics[`lift_${feature}`] =
      `${stats.count}x, avg=${Math.round(stats.avgLift * 10) / 10}`;
  }

  const confidence = Math.min(1, totalPositions / 20);
  const confidenceSignals: ConfidenceSignal[] = [
    {
      reason: `${totalPositions} positions analyzed (20 = full confidence)`,
      source: "sample-coverage",
      value: confidence,
    },
  ];

  // Applicability: semantic lift requires advanced type features
  let applicability: "applicable" | "not_applicable" | "insufficient_evidence" = "applicable";
  let applicabilityReasons: string[] = [];
  if (liftedPositions === 0 && totalPositions > 0) {
    applicability = "not_applicable";
    applicabilityReasons = [
      "No positions use advanced type features above baseline — no semantic lift axis",
    ];
  } else if (liftedPositions > 0 && liftedPositions < 3) {
    applicability = "insufficient_evidence";
    applicabilityReasons = [
      `Only ${liftedPositions} position(s) with advanced type features — weak semantic lift evidence`,
    ];
  }

  return {
    applicability,
    applicabilityReasons,
    confidence,
    confidenceSignals,
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      complexityDiscountedPositions,
      correlationBonus,
      correlationCount,
      diversityBonus,
      effectiveLiftBonus,
      effectiveLiftPositions,
      featureCount: featuresSeen.size,
      instantiatedLiftPositions,
      liftRatio: Math.round(liftRatio * 100) / 100,
      liftedPositions,
      maxLift: Math.round(maxLift * 100) / 100,
      scaledMeanLift: Math.round(scaledMeanLift * 100) / 100,
      totalPositions,
      ...perFeatureMetrics,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

/**
 * Compute instantiated baseline for a position.
 * For generic positions, this estimates the precision score
 * the type would have if generics were instantiated with concrete types.
 *
 * A constrained generic that specializes well should have a high
 * instantiated baseline (meaning the lift from features must be real,
 * not just type-level complexity).
 *
 * Returns -1 if no instantiated baseline applies.
 */
function computeInstantiatedBaseline(pos: SurfacePosition, features: string[]): number {
  const typeText = pos.type.getText();

  // Check if this position involves generic type parameters
  const hasGenericRef = /\b[A-Z]\b/.test(typeText) || /\b[A-Z][a-z]+[A-Z]/.test(typeText);
  if (!hasGenericRef) {
    return -1;
  }

  // If the type is just a raw generic T without features, no lift to measure
  if (features.length === 0) {
    return -1;
  }

  // ── Mapped type positions ──
  // The mapped structure is preserved when instantiated (Record<K,V> → concrete keys/values)
  // But the mapping itself contributes baseline precision
  if (features.includes("mapped-type")) {
    return 45;
  }

  // ── Conditional type positions ──
  // Conditional resolution helps narrow the type when instantiated,
  // So the baseline is slightly above raw generic
  if (features.includes("conditional-type")) {
    return 42;
  }

  // ── Constrained generics ──
  // For constrained generics, the instantiated version would typically score
  // At the constraint's precision level
  const hasConstraint = features.some(
    (feat) =>
      feat === "constraint-basic" ||
      feat === "constraint-strong" ||
      feat === "constraint-structural" ||
      feat === "constrained-generic",
  );

  if (hasConstraint) {
    // Structural constraints (extends { key: Type, ... }) — the constraint's
    // Shape gives real structural precision when instantiated. Score the
    // Constraint itself via analyzePrecision on the constraint type if available.
    if (features.includes("constraint-structural")) {
      // Structural constraints provide meaningful shape info; the instantiated
      // Type would have at least that shape's precision
      const constraintScore = estimateConstraintPrecision(pos);
      if (constraintScore > 0) {
        return constraintScore;
      }
      // Fallback: structural constraint is fairly precise
      return 48;
    }

    // Strong constraints — often string literal or union constraints
    if (features.includes("constraint-strong")) {
      // Check for union constraints (extends "a" | "b") vs single literal
      if (hasUnionConstraint(typeText)) {
        // Union constraint is quite specific
        return 60;
      }
      if (hasStringLiteralConstraint(typeText)) {
        // String literal constraint is specific when instantiated
        return 55;
      }
      return 50;
    }

    // Basic constraints (extends string, extends number, etc.)
    return 42;
  }

  // Unconstrained generic with advanced features: check if the features
  // Add real semantic value beyond what instantiation alone provides
  return -1;
}

/**
 * Estimate the precision of a structural constraint (extends { ... }).
 * Looks at the constraint type on the position's type and runs
 * analyzePrecision on it to get a real score.
 *
 * Returns 0 if no constraint type is available.
 */
function estimateConstraintPrecision(pos: SurfacePosition): number {
  try {
    const { type } = pos;
    // For type parameters, get the constraint
    const constraint = type.getConstraint?.();
    if (constraint) {
      const result = analyzePrecision(constraint);
      return result.score;
    }
  } catch {
    // Constraint extraction can fail for complex types; fall back
  }
  return 0;
}

/** Check if the type text suggests a union constraint (extends "a" | "b") */
function hasUnionConstraint(typeText: string): boolean {
  // Look for extends ... | ... pattern with literal members
  return /extends\s+(?:"[^"]*"|'[^']*'|\w+)\s*\|/.test(typeText);
}

/** Check if the type text suggests a string literal constraint (extends "foo") */
function hasStringLiteralConstraint(typeText: string): boolean {
  return /extends\s+(?:"[^"]*"|'[^']*')/.test(typeText);
}
