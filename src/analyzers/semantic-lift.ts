import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface, SurfacePosition } from "../surface/index.js";
import { analyzePrecision } from "../utils/type-utils.js";
import type { TypeNode } from "ts-morph";
import type { SurfaceTypeParam } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "semanticLift")!;
const BASELINE = 40;

const ADVANCED_FEATURES = new Set([
  "branded",
  "conditional-type",
  "constrained-generic",
  "discriminated-union",
  "indexed-access",
  "infer",
  "literal-union",
  "mapped-type",
  "template-literal",
  "tuple",
]);

function countGenericCorrelation(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: Array<{ name: string; typeNode: TypeNode | undefined }>,
  returnTypeNode: TypeNode | undefined,
): number {
  if (typeParams.length === 0 || !returnTypeNode) {return 0;}
  let count = 0;
  const paramNames = new Set(typeParams.map((tp) => tp.name));
  const returnText = returnTypeNode.getText();
  for (const name of paramNames) {
    const usedInParams = paramTypeNodes.some((p) => {
      return p.typeNode && p.typeNode.getText().includes(name);
    });
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
  let totalLift = 0;
  let correlationCount = 0;
  const featuresSeen = new Set<string>();

  function processPosition(pos: SurfacePosition): void {
    totalPositions++;
    const result = analyzePrecision(pos.type);
    const hasAdvanced = result.features.some((f) => ADVANCED_FEATURES.has(f));
    if (hasAdvanced && result.score > BASELINE) {
      liftedPositions++;
      totalLift += result.score - BASELINE;
      for (const f of result.features) {
        if (ADVANCED_FEATURES.has(f)) {featuresSeen.add(f);}
      }
    }
  }

  for (const decl of surface.declarations) {
    if (decl.kind === "enum") {continue;}

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
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: { correlationCount: 0, featureCount: 0, liftedPositions: 0, totalPositions: 0 },
      negatives: ["No exported type positions found"],
      positives: [],
      score: 0,
      weights: CONFIG.weights,
    };
  }

  const featureRatio = liftedPositions / totalPositions;
  const meanLift = liftedPositions > 0 ? totalLift / liftedPositions : 0;
  const correlationBonus = Math.min(correlationCount * 8, 20);

  let score = Math.round(featureRatio * 40 + meanLift * 0.6 + correlationBonus);
  score = Math.max(0, Math.min(100, score));

  // Build positives/negatives
  if (featuresSeen.size > 0) {
    positives.push(`Advanced features: ${[...featuresSeen].sort().join(", ")}`);
  }
  if (liftedPositions > 0) {
    positives.push(`${liftedPositions}/${totalPositions} positions use advanced typing above baseline`);
  }
  if (correlationCount > 0) {
    positives.push(`${correlationCount} correlated generic(s)`);
  }
  if (score < 15) {
    negatives.push("Limited use of advanced type-system features for semantic lift");
  }

  return {
    confidence: Math.min(1, totalPositions / 20),
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      correlationBonus,
      correlationCount,
      featureCount: featuresSeen.size,
      featureRatio: Math.round(featureRatio * 100) / 100,
      liftedPositions,
      meanLift: Math.round(meanLift * 100) / 100,
      totalPositions,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
