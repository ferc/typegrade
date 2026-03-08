import type { ConfidenceSignal, DimensionResult, Issue } from "../types.js";
import { Node, type Type, TypeFlags } from "ts-morph";
import type { PublicSurface, SurfaceDeclaration, SurfacePosition } from "../surface/index.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSpecificity")!;
const MAX_SAMPLES_PER_GROUP = 12;

// Per-position feature bonuses
const FEATURE_BONUSES: Record<string, number> = {
  branded: 8,
  "conditional-type": 4,
  "constrained-generic": 5,
  "constraint-basic": 3,
  "constraint-strong": 8,
  "constraint-structural": 5,
  "discriminated-union": 6,
  "indexed-access": 4,
  infer: 5,
  "key-remapping": 5,
  "literal-union": 3,
  "mapped-type": 5,
  never: 2,
  "recursive-type": 6,
  "template-literal": 5,
  tuple: 3,
};

interface WeightedSample {
  score: number;
  weight: number;
  features: string[];
  containsAny: boolean;
}

interface OverloadStats {
  escapeHatchCount: number;
  broadFallbackCount: number;
}

interface RelationStats {
  correlatedGenericCount: number;
  keyPreservingTransforms: number;
  pathParamInference: number;
  helperChainOpacity: number;
  catchAllBagCount: number;
  latentDiscriminantCount: number;
  instantiatedSpecificityPotential: number;
}

export function analyzeApiSpecificity(surface: PublicSurface): DimensionResult {
  const issues: Issue[] = [];
  const samples: WeightedSample[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];
  const overloadStats: OverloadStats = { broadFallbackCount: 0, escapeHatchCount: 0 };
  const relationStats: RelationStats = {
    catchAllBagCount: 0,
    correlatedGenericCount: 0,
    helperChainOpacity: 0,
    instantiatedSpecificityPotential: 0,
    keyPreservingTransforms: 0,
    latentDiscriminantCount: 0,
    pathParamInference: 0,
  };

  for (const decl of surface.declarations) {
    switch (decl.kind) {
      case "function": {
        collectFunctionSamples({ decl, issues, overloadStats, relationStats, samples });
        break;
      }
      case "interface": {
        collectCappedPositionSamples(decl.positions, samples);
        detectInterfaceRelations(decl, relationStats);
        break;
      }
      case "type-alias": {
        collectAllPositionSamples(decl.positions, samples);
        detectTypeAliasRelations(decl, relationStats);
        break;
      }
      case "class": {
        collectClassSamples(decl, samples, relationStats);
        break;
      }
      case "enum": {
        samples.push({ containsAny: false, features: [], score: 85, weight: 0.75 });
        break;
      }
      case "variable": {
        collectVariableSamples(decl, samples, issues);
        break;
      }
    }
  }

  if (samples.length === 0) {
    return {
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: {
        correlatedGenerics: 0,
        escapeHatchOverloads: 0,
        sampleCount: 0,
        weakPositionCount: 0,
      },
      negatives: ["No exported type positions found"],
      positives: [],
      score: 0,
      weights: CONFIG.weights,
    };
  }

  // Per-position feature-model scoring
  let totalWeight = 0;
  let weightedSum = 0;
  const featureDensities = new Map<string, number>();
  let samplesWithFeature = 0;
  let weakPositionCount = 0;

  for (const sample of samples) {
    let featureBonus = 0;
    const seenFeatures = new Set<string>();
    for (const feature of sample.features) {
      if (seenFeatures.has(feature)) {
        continue;
      }
      seenFeatures.add(feature);
      const bonus = FEATURE_BONUSES[feature] ?? 0;
      featureBonus += bonus;
    }

    const positionScore = Math.max(0, Math.min(100, sample.score + featureBonus));
    weightedSum += positionScore * sample.weight;
    totalWeight += sample.weight;

    if (sample.score < 40) {
      weakPositionCount++;
    }

    if (seenFeatures.size > 0) {
      samplesWithFeature++;
    }
    for (const feature of seenFeatures) {
      featureDensities.set(feature, (featureDensities.get(feature) ?? 0) + 1);
    }
  }

  let score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Feature density bonus
  const featureDensityRatio = samplesWithFeature / samples.length;
  if (featureDensityRatio > 0.5) {
    score += Math.round((featureDensityRatio - 0.5) * 10);
  }

  // Penalty: any leakage in containers
  const anyContainers = samples.filter((sample) => sample.containsAny).length;
  if (anyContainers > 0) {
    score -= Math.min(anyContainers * 4, 20);
  }

  // Penalty: record-like dominating
  const recordLikeCount = featureDensities.get("record-like") ?? 0;
  if (recordLikeCount > samples.length * 0.3) {
    score -= 8;
  }

  // Penalty: weak-guidance
  if (samples.length > 0 && weakPositionCount / samples.length > 0.3) {
    score -= 5;
    negatives.push(
      `Weak guidance: ${weakPositionCount}/${samples.length} positions score below 40`,
    );
  }

  // Penalty: low-return-value
  const returnSamples: SurfacePosition[] = [];
  for (const decl of surface.declarations) {
    if (decl.kind !== "function" && decl.kind !== "class") {
      continue;
    }
    for (const pos of decl.positions) {
      if (pos.role === "return") {
        returnSamples.push(pos);
      }
    }
    for (const mt of decl.methods ?? []) {
      for (const pos of mt.positions) {
        if (pos.role === "return") {
          returnSamples.push(pos);
        }
      }
    }
  }
  if (returnSamples.length > 0) {
    const voidOrAnyReturns = returnSamples.filter((pos) => {
      const flags = pos.type.getFlags();
      return Boolean(flags & (TypeFlags.Void | TypeFlags.Any));
    }).length;
    if (voidOrAnyReturns / returnSamples.length > 0.5) {
      score -= 5;
      negatives.push(
        `Low return value quality: ${voidOrAnyReturns}/${returnSamples.length} returns are void or any`,
      );
    }
  }

  // --- Relation-aware bonuses and penalties (new) ---

  // Key-preserving transforms: +4 per detected transform (max +12)
  if (relationStats.keyPreservingTransforms > 0) {
    const bonus = Math.min(relationStats.keyPreservingTransforms * 4, 12);
    score += bonus;
    positives.push(
      `${relationStats.keyPreservingTransforms} key-preserving transforms detected (+${bonus})`,
    );
  }

  // Path-param inference: +5 per pattern (max +15)
  if (relationStats.pathParamInference > 0) {
    const bonus = Math.min(relationStats.pathParamInference * 5, 15);
    score += bonus;
    positives.push(`${relationStats.pathParamInference} path-param inference patterns (+${bonus})`);
  }

  // Latent discriminants: +3 per discriminant (max +9)
  if (relationStats.latentDiscriminantCount > 0) {
    const bonus = Math.min(relationStats.latentDiscriminantCount * 3, 9);
    score += bonus;
    positives.push(
      `${relationStats.latentDiscriminantCount} latent discriminants in generic outputs (+${bonus})`,
    );
  }

  // Instantiated specificity potential: bonus for generics that specialize well
  if (relationStats.instantiatedSpecificityPotential > 0) {
    const bonus = Math.min(relationStats.instantiatedSpecificityPotential * 3, 12);
    score += bonus;
    positives.push(
      `${relationStats.instantiatedSpecificityPotential} declarations with high instantiated specificity potential (+${bonus})`,
    );
  }

  // Catch-all object bag penalty: -4 per bag (max -12)
  if (relationStats.catchAllBagCount > 0) {
    const penalty = Math.min(relationStats.catchAllBagCount * 4, 12);
    score -= penalty;
    negatives.push(`${relationStats.catchAllBagCount} catch-all object bag patterns (-${penalty})`);
  }

  // Helper-chain opacity penalty: -3 per opaque chain (max -9)
  if (relationStats.helperChainOpacity > 0) {
    const penalty = Math.min(relationStats.helperChainOpacity * 3, 9);
    score -= penalty;
    negatives.push(
      `${relationStats.helperChainOpacity} opaque helper-chain patterns (-${penalty})`,
    );
  }

  score = Math.max(0, Math.min(100, score));

  // Build diagnostics
  const confidence = Math.min(1, samples.length / 20);
  const confidenceSignals: ConfidenceSignal[] = [
    {
      reason: `${samples.length} positions analyzed (20 = full confidence)`,
      source: "sample-coverage",
      value: confidence,
    },
  ];
  positives.push(`${samples.length} exported type positions analyzed`);
  if (featureDensityRatio > 0.3) {
    const topFeatures = [...featureDensities.entries()]
      .toSorted((lhs, rhs) => rhs[1] - lhs[1])
      .slice(0, 5)
      .map(([feat, cnt]) => `${feat}(${cnt})`);
    positives.push(`Feature density: ${topFeatures.join(", ")}`);
  }
  if (relationStats.correlatedGenericCount > 0) {
    positives.push(`${relationStats.correlatedGenericCount} functions with correlated generic I/O`);
  }
  if (overloadStats.escapeHatchCount > 0) {
    negatives.push(`${overloadStats.escapeHatchCount} escape-hatch overloads detected`);
  }
  if (score >= 70) {
    positives.push("High type specificity across exports");
  }
  if (score < 40) {
    negatives.push("Many exported types use broad/imprecise types");
  }

  return {
    confidence,
    confidenceSignals,
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      catchAllBagCount: relationStats.catchAllBagCount,
      correlatedGenerics: relationStats.correlatedGenericCount,
      escapeHatchOverloads: overloadStats.escapeHatchCount,
      featureDensityRatio: Math.round(featureDensityRatio * 100) / 100,
      helperChainOpacity: relationStats.helperChainOpacity,
      instantiatedSpecificityPotential: relationStats.instantiatedSpecificityPotential,
      keyPreservingTransforms: relationStats.keyPreservingTransforms,
      latentDiscriminants: relationStats.latentDiscriminantCount,
      pathParamInference: relationStats.pathParamInference,
      sampleCount: samples.length,
      samplesWithFeature,
      weakPositionCount,
      weightedAverage: score,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

// --- Collectors ---

interface CollectFunctionSamplesOpts {
  decl: SurfaceDeclaration;
  samples: WeightedSample[];
  issues: Issue[];
  overloadStats: OverloadStats;
  relationStats: RelationStats;
}

function collectFunctionSamples(opts: CollectFunctionSamplesOpts): void {
  const { decl, samples, issues, overloadStats, relationStats } = opts;
  const declSamples: WeightedSample[] = [];
  let samplesFromDecl = 0;
  for (const pos of decl.positions) {
    if (samplesFromDecl >= MAX_SAMPLES_PER_GROUP) {
      break;
    }
    const result = analyzePrecision(pos.type);
    declSamples.push({
      containsAny: result.containsAny,
      features: result.features,
      score: result.score,
      weight: pos.weight,
    });
    samplesFromDecl++;

    if (result.score <= 20) {
      const message =
        pos.role === "return"
          ? `${decl.name}() has low return type specificity (${result.score}/100)`
          : `parameter '${pos.name}' in ${decl.name}() has low specificity (${result.score}/100)`;
      issues.push({
        column: pos.column,
        dimension: CONFIG.label,
        file: pos.filePath,
        line: pos.line,
        message,
        severity: result.score === 0 ? "error" : "warning",
      });
    }
  }

  // Escape-hatch overload detection
  detectOverloadPenalties(decl, declSamples, overloadStats);

  // Correlated generic I/O bonus
  const correlatedBonus = computeCorrelatedGenericBonus(decl);
  if (correlatedBonus > 0) {
    relationStats.correlatedGenericCount++;
    for (const ds of declSamples) {
      ds.score = Math.min(100, ds.score + correlatedBonus);
    }
  }

  // Detect catch-all object bag params (Record<string, any> or {[key: string]: any})
  for (const pos of decl.positions) {
    if (pos.role === "param" && isCatchAllObjectBag(pos.type)) {
      relationStats.catchAllBagCount++;
    }
  }

  // Detect path-param inference patterns (template literal params that propagate to output)
  if (decl.typeParameters.length > 0) {
    detectPathParamInference(decl, relationStats);
  }

  samples.push(...declSamples);
}

function collectCappedPositionSamples(
  positions: SurfacePosition[],
  samples: WeightedSample[],
): void {
  let samplesFromDecl = 0;
  for (const pos of positions) {
    if (samplesFromDecl >= MAX_SAMPLES_PER_GROUP) {
      break;
    }
    const result = analyzePrecision(pos.type);
    samples.push({
      containsAny: result.containsAny,
      features: result.features,
      score: result.score,
      weight: pos.weight,
    });
    samplesFromDecl++;
  }
}

function collectAllPositionSamples(positions: SurfacePosition[], samples: WeightedSample[]): void {
  for (const pos of positions) {
    const result = analyzePrecision(pos.type);
    samples.push({
      containsAny: result.containsAny,
      features: result.features,
      score: result.score,
      weight: pos.weight,
    });
  }
}

function collectClassSamples(
  decl: SurfaceDeclaration,
  samples: WeightedSample[],
  relationStats: RelationStats,
): void {
  const ctorPositions = decl.positions.filter((pos) => pos.role === "ctor-param");
  collectCappedPositionSamples(ctorPositions, samples);

  for (const method of decl.methods ?? []) {
    collectCappedPositionSamples(method.positions, samples);

    // Detect correlated generic I/O in class methods
    if (method.typeParameters.length > 0) {
      const typeParamNames = method.typeParameters.map((tp) => tp.name);
      const paramTexts = method.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "").join(" ");
      const returnText = method.returnTypeNode?.getText() ?? "";

      const hasCorrelation = typeParamNames.some(
        (name) => paramTexts.includes(name) && returnText.includes(name),
      );
      if (hasCorrelation) {
        relationStats.correlatedGenericCount++;
      }
    }
  }

  const otherPositions = decl.positions.filter(
    (pos) => pos.role === "property" || pos.role === "getter" || pos.role === "setter-param",
  );
  collectAllPositionSamples(otherPositions, samples);
}

function collectVariableSamples(
  decl: SurfaceDeclaration,
  samples: WeightedSample[],
  issues: Issue[],
): void {
  for (const pos of decl.positions) {
    const result = analyzePrecision(pos.type);
    samples.push({
      containsAny: result.containsAny,
      features: result.features,
      score: result.score,
      weight: pos.weight,
    });

    if (result.score <= 20) {
      issues.push({
        column: pos.column,
        dimension: CONFIG.label,
        file: pos.filePath,
        line: pos.line,
        message: `exported '${pos.name}' has low specificity (${result.score}/100)`,
        severity: result.score === 0 ? "error" : "warning",
      });
    }
  }
}

function detectOverloadPenalties(
  decl: SurfaceDeclaration,
  declSamples: WeightedSample[],
  overloadStats: OverloadStats,
): void {
  if ((decl.overloadCount ?? 0) <= 0) {
    return;
  }
  const fnNode = decl.node;
  if (!Node.isFunctionDeclaration(fnNode)) {
    return;
  }
  const overloads = fnNode.getOverloads();
  if (overloads.length === 0) {
    return;
  }

  const lastOverload = overloads.at(-1)!;
  const lastParams = lastOverload.getParameters();
  const allParamsAny =
    lastParams.length > 0 && lastParams.every((pm) => pm.getType().getFlags() & TypeFlags.Any);
  const returnIsAny = lastOverload.getReturnType().getFlags() & TypeFlags.Any;
  if (allParamsAny || returnIsAny) {
    overloadStats.escapeHatchCount++;
    for (const ds of declSamples) {
      ds.score = Math.max(0, ds.score - 8);
    }
  }

  // Broad fallback overload detection
  const implParams = fnNode.getParameters();
  const hasWiderImpl = implParams.some((implP) => {
    const implFlags = implP.getType().getFlags();
    return Boolean(implFlags & (TypeFlags.Any | TypeFlags.Unknown));
  });
  if (hasWiderImpl && !allParamsAny && !returnIsAny) {
    overloadStats.broadFallbackCount++;
    for (const ds of declSamples) {
      ds.score = Math.max(0, ds.score - 5);
    }
  }
}

// --- Relation-aware detection helpers ---

/**
 * Detect correlated generic I/O: a generic type parameter appears in both
 * input (params) and output (return type). Awards +3 per correlated param, max +9.
 */
function computeCorrelatedGenericBonus(decl: SurfaceDeclaration): number {
  if (decl.typeParameters.length === 0) {
    return 0;
  }

  const paramPositions = decl.positions.filter((pos) => pos.role === "param");
  const returnPositions = decl.positions.filter((pos) => pos.role === "return");
  if (paramPositions.length === 0 || returnPositions.length === 0) {
    return 0;
  }

  let correlatedCount = 0;
  for (const tp of decl.typeParameters) {
    const tpName = tp.name;
    const inInput = paramPositions.some((pos) => typeTextContainsParam(pos.type, tpName));
    const inOutput = returnPositions.some((pos) => typeTextContainsParam(pos.type, tpName));
    if (inInput && inOutput) {
      correlatedCount++;
    }
  }

  return Math.min(correlatedCount * 3, 9);
}

function typeTextContainsParam(type: Type, paramName: string): boolean {
  const text = type.getText();
  const pattern = new RegExp(`\\b${paramName}\\b`);
  return pattern.test(text);
}

/** Detect catch-all object bag: Record<string, any>, {[key: string]: any}, or similar */
function isCatchAllObjectBag(type: Type): boolean {
  const text = type.getText();
  // Record<string, any> or Record<string, unknown>
  if (/Record<string,\s*(any|unknown)>/.test(text)) {
    return true;
  }
  // {[key: string]: any}
  if (/\[\w+:\s*string\]:\s*any/.test(text)) {
    return true;
  }
  return false;
}

/** Detect path-param inference (template literal in params that flow to output) */
function detectPathParamInference(decl: SurfaceDeclaration, stats: RelationStats): void {
  for (const tp of decl.typeParameters) {
    const { constraint } = tp;
    if (!constraint) {
      continue;
    }
    const constraintText = constraint.getText();
    // Template literal constraint like `/${string}` or containing template literal syntax
    if (constraintText.includes("`") || constraintText.includes("template-literal")) {
      // Check if it flows to output
      const returnPositions = decl.positions.filter((pos) => pos.role === "return");
      const inOutput = returnPositions.some((pos) => typeTextContainsParam(pos.type, tp.name));
      if (inOutput) {
        stats.pathParamInference++;
      }
    }
  }

  // Also detect string template patterns in param type nodes
  for (const paramNode of decl.paramTypeNodes ?? []) {
    const text = paramNode.typeNode?.getText() ?? "";
    if (text.includes("`") && text.includes("${")) {
      stats.pathParamInference++;
    }
  }
}

/** Detect key-preserving transforms in type aliases (mapped types with keyof) */
function detectTypeAliasRelations(decl: SurfaceDeclaration, stats: RelationStats): void {
  if (!decl.bodyTypeNode) {
    return;
  }
  const bodyText = decl.bodyTypeNode.getText();

  // Key-preserving: mapped type using keyof or in keyof patterns
  if (decl.typeParameters.length > 0 && /\[.*\s+in\s+keyof\s/.test(bodyText)) {
    stats.keyPreservingTransforms++;
  }

  // Latent discriminants: generic output with discriminant properties (type/kind/tag)
  if (decl.typeParameters.length > 0 && /\|\s*\{/.test(bodyText) && /["']?(type|kind|tag|_tag|status)["']?\s*:/.test(bodyText)) {
    stats.latentDiscriminantCount++;
  }

  // Instantiated specificity potential: constrained generics with complex output
  if (decl.typeParameters.length > 0) {
    const hasConstraints = decl.typeParameters.some((tp) => tp.constraint !== undefined);
    const hasComplexOutput =
      bodyText.length > 50 &&
      (bodyText.includes("|") || bodyText.includes("&") || bodyText.includes("<"));
    if (hasConstraints && hasComplexOutput) {
      stats.instantiatedSpecificityPotential++;
    }
  }
}

/** Detect relation patterns in interfaces */
function detectInterfaceRelations(decl: SurfaceDeclaration, stats: RelationStats): void {
  // Check methods for helper-chain opacity (methods returning opaque helper types)
  for (const method of decl.methods ?? []) {
    const returnText = method.returnTypeNode?.getText() ?? "";
    // Opaque helper chain: return type references multiple internal type aliases
    const typeRefs = returnText.match(/[A-Z]\w+</g) ?? [];
    if (typeRefs.length > 3) {
      stats.helperChainOpacity++;
    }
  }

  // Check for key-preserving generic methods
  if (decl.typeParameters.length > 0) {
    for (const method of decl.methods ?? []) {
      if (method.typeParameters.length > 0) {
        const paramTexts = method.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "").join(" ");
        const returnText = method.returnTypeNode?.getText() ?? "";
        // If method param includes keyof and return preserves the key type
        if (paramTexts.includes("keyof") && returnText.includes("keyof")) {
          stats.keyPreservingTransforms++;
        }
      }
    }
  }
}
