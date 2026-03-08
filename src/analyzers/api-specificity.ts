import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface, SurfaceDeclaration, SurfacePosition } from "../surface/index.js";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSpecificity")!;
const MAX_SAMPLES_PER_GROUP = 12;

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

  // Weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  for (const sample of samples) {
    weightedSum += sample.score * sample.weight;
    totalWeight += sample.weight;
  }
  let score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Feature-vector adjustments on top of weighted average
  const allFeatures = samples.flatMap((s) => s.features);
  const featureCounts = countFeatures(allFeatures);

  if (featureCounts['constrained-generic'] > 0) {score += 5;}
  if (featureCounts['branded'] > 0) {score += 8;}
  if (featureCounts['discriminated-union'] > 0) {score += 6;}
  if (featureCounts['mapped-type'] > 0) {score += 5;}
  if (featureCounts['conditional-type'] > 0) {score += 4;}
  if (featureCounts['template-literal'] > 0) {score += 5;}

  // Penalty: any leakage in containers
  const anyContainers = samples.filter((s) => s.containsAny).length;
  if (anyContainers > 0) {score -= Math.min(anyContainers * 4, 20);}

  // Penalty: record-like dominating
  if ((featureCounts['record-like'] ?? 0) > samples.length * 0.3) {score -= 8;}

  score = Math.max(0, Math.min(100, score));

  positives.push(`${samples.length} exported type positions analyzed`);
  if (score >= 70) {positives.push("High type specificity across exports");}
  if (score < 40) {negatives.push("Many exported types use broad/imprecise types");}

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: { sampleCount: samples.length, weightedAverage: score },
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

function countFeatures(features: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    counts[f] = (counts[f] ?? 0) + 1;
  }
  return counts;
}
