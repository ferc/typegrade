import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { SourceFile } from "ts-morph";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSpecificity")!;

interface WeightedSample {
  score: number;
  weight: number;
  features: string[];
  containsAny: boolean;
}

export function analyzeApiSpecificity(sourceFiles: SourceFile[]): DimensionResult {
  const issues: Issue[] = [];
  const samples: WeightedSample[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Exported functions
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      const fnName = fn.getName() ?? "<anonymous>";
      let samplesFromDecl = 0;

      // Score parameters (weight 1.0)
      for (const param of fn.getParameters()) {
        if (samplesFromDecl >= 12) {break;}
        const type = param.getType();
        const result = analyzePrecision(type);
        samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: 1 });
        samplesFromDecl++;

        if (result.score <= 20) {
          issues.push({
            column: param.getStart() - param.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: param.getStartLineNumber(),
            message: `parameter '${param.getName()}' in ${fnName}() has low specificity (${result.score}/100)`,
            severity: result.score === 0 ? "error" : "warning",
          });
        }
      }

      // Score return type (weight 1.25)
      if (samplesFromDecl < 12) {
        const returnType = fn.getReturnType();
        const result = analyzePrecision(returnType);
        samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: 1.25 });
        samplesFromDecl++;

        if (result.score <= 20) {
          issues.push({
            column: fn.getStart() - fn.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: fn.getStartLineNumber(),
            message: `${fnName}() has low return type specificity (${result.score}/100)`,
            severity: result.score === 0 ? "error" : "warning",
          });
        }
      }
    }

    // Exported interfaces (weight 0.75)
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      let samplesFromDecl = 0;
      for (const prop of iface.getProperties()) {
        if (samplesFromDecl >= 12) {break;}
        const type = prop.getType();
        const result = analyzePrecision(type);
        samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: 0.75 });
        samplesFromDecl++;
      }
    }

    // Exported type aliases (weight 0.75)
    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) {continue;}
      const type = alias.getType();
      const result = analyzePrecision(type);
      samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: 0.75 });
    }

    // Exported variables (weight 1.0)
    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) {continue;}
      for (const decl of varStmt.getDeclarations()) {
        const type = decl.getType();
        const result = analyzePrecision(type);
        samples.push({ containsAny: result.containsAny, features: result.features, score: result.score, weight: 1 });

        if (result.score <= 20) {
          issues.push({
            column: decl.getStart() - decl.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: decl.getStartLineNumber(),
            message: `exported '${decl.getName()}' has low specificity (${result.score}/100)`,
            severity: result.score === 0 ? "error" : "warning",
          });
        }
      }
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

function countFeatures(features: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    counts[f] = (counts[f] ?? 0) + 1;
  }
  return counts;
}
