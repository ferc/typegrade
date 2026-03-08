import type { ConfidenceSignal, DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface, SurfaceDeclaration, SurfacePosition } from "../surface/index.js";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSpecificity")!;
const MAX_SAMPLES_PER_GROUP = 12;

// Per-position feature bonuses
const FEATURE_BONUSES: Record<string, number> = {
  "branded": 8,
  "conditional-type": 4,
  "constraint-basic": 3,
  "constraint-strong": 8,
  "constraint-structural": 5,
  "constrained-generic": 5,
  "discriminated-union": 6,
  "mapped-type": 5,
  "template-literal": 5,
};

interface WeightedSample {
  score: number;
  weight: number;
  features: string[];
  containsAny: boolean;
}

export function analyzeApiSpecificity(surface: PublicSurface): DimensionResult {
  const issues: Issue[] = [];
  const samples: WeightedSample[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const decl of surface.declarations) {
    switch (decl.kind) {
      case "function":
        collectFunctionSamples(decl, samples, issues);
        break;
      case "interface":
        collectCappedPositionSamples(decl.positions, samples);
        break;
      case "type-alias":
        collectAllPositionSamples(decl.positions, samples);
        break;
      case "class":
        collectClassSamples(decl, samples);
        break;
      case "enum":
        samples.push({ containsAny: false, features: [], score: 85, weight: 0.75 });
        break;
      case "variable":
        collectVariableSamples(decl, samples, issues);
        break;
    }
  }

  if (samples.length === 0) {
    return {
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: { sampleCount: 0 },
      negatives: ["No exported type positions found"],
      positives: [],
      score: 0,
      weights: CONFIG.weights,
    };
  }

  // Per-position feature-model scoring:
  // Each position score = clamp(basePrecision + sum of feature bonuses)
  // Then compute weighted average across all positions
  let totalWeight = 0;
  let weightedSum = 0;
  const featureDensities = new Map<string, number>();
  let samplesWithFeature = 0;

  for (const sample of samples) {
    // Compute per-position feature bonus
    let featureBonus = 0;
    const seenFeatures = new Set<string>();
    for (const feature of sample.features) {
      if (seenFeatures.has(feature)) {continue;}
      seenFeatures.add(feature);
      const bonus = FEATURE_BONUSES[feature] ?? 0;
      featureBonus += bonus;
    }

    const positionScore = Math.max(0, Math.min(100, sample.score + featureBonus));
    weightedSum += positionScore * sample.weight;
    totalWeight += sample.weight;

    // Track feature densities
    if (seenFeatures.size > 0) {samplesWithFeature++;}
    for (const feature of seenFeatures) {
      featureDensities.set(feature, (featureDensities.get(feature) ?? 0) + 1);
    }
  }

  let score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Feature density bonus: reward pervasive use of advanced features
  const featureDensityRatio = samplesWithFeature / samples.length;
  if (featureDensityRatio > 0.5) {
    score += Math.round((featureDensityRatio - 0.5) * 10);
  }

  // Penalty: any leakage in containers
  const anyContainers = samples.filter((s) => s.containsAny).length;
  if (anyContainers > 0) {score -= Math.min(anyContainers * 4, 20);}

  // Penalty: record-like dominating
  const recordLikeCount = featureDensities.get("record-like") ?? 0;
  if (recordLikeCount > samples.length * 0.3) {score -= 8;}

  score = Math.max(0, Math.min(100, score));

  // Build diagnostics
  const confidence = Math.min(1, samples.length / 20);
  const confidenceSignals: ConfidenceSignal[] = [
    { reason: `${samples.length} positions analyzed (20 = full confidence)`, source: "sample-coverage", value: confidence },
  ];
  positives.push(`${samples.length} exported type positions analyzed`);
  if (featureDensityRatio > 0.3) {
    const topFeatures = [...featureDensities.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f, c]) => `${f}(${c})`);
    positives.push(`Feature density: ${topFeatures.join(", ")}`);
  }
  if (score >= 70) {positives.push("High type specificity across exports");}
  if (score < 40) {negatives.push("Many exported types use broad/imprecise types");}

  return {
    confidence,
    confidenceSignals,
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      featureDensityRatio: Math.round(featureDensityRatio * 100) / 100,
      sampleCount: samples.length,
      samplesWithFeature,
      weightedAverage: score,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

// --- Collectors ---

function collectFunctionSamples(decl: SurfaceDeclaration, samples: WeightedSample[], issues: Issue[]): void {
  let samplesFromDecl = 0;
  for (const pos of decl.positions) {
    if (samplesFromDecl >= MAX_SAMPLES_PER_GROUP) {break;}
    const result = analyzePrecision(pos.type);
    samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: pos.weight });
    samplesFromDecl++;

    if (result.score <= 20) {
      const message = pos.role === "return"
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
}

function collectCappedPositionSamples(positions: SurfacePosition[], samples: WeightedSample[]): void {
  let samplesFromDecl = 0;
  for (const pos of positions) {
    if (samplesFromDecl >= MAX_SAMPLES_PER_GROUP) {break;}
    const result = analyzePrecision(pos.type);
    samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: pos.weight });
    samplesFromDecl++;
  }
}

function collectAllPositionSamples(positions: SurfacePosition[], samples: WeightedSample[]): void {
  for (const pos of positions) {
    const result = analyzePrecision(pos.type);
    samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: pos.weight });
  }
}

function collectClassSamples(decl: SurfaceDeclaration, samples: WeightedSample[]): void {
  // Constructor params (capped per constructor group)
  const ctorPositions = decl.positions.filter((p) => p.role === "ctor-param");
  collectCappedPositionSamples(ctorPositions, samples);

  // Method params + returns (capped per method)
  for (const method of decl.methods ?? []) {
    collectCappedPositionSamples(method.positions, samples);
  }

  // Properties, getters, setters (no cap)
  const otherPositions = decl.positions.filter(
    (p) => p.role === "property" || p.role === "getter" || p.role === "setter-param",
  );
  collectAllPositionSamples(otherPositions, samples);
}

function collectVariableSamples(decl: SurfaceDeclaration, samples: WeightedSample[], issues: Issue[]): void {
  for (const pos of decl.positions) {
    const result = analyzePrecision(pos.type);
    samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: pos.weight });

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
