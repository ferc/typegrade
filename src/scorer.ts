import type { DimensionResult } from "./types.js";

export function computeOverallScore(dimensions: DimensionResult[]): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const dim of dimensions) {
    weightedSum += dim.score * dim.weight;
    totalWeight += dim.weight;
  }

  if (totalWeight === 0) return 0;
  return Math.round(weightedSum / totalWeight);
}

export function computeGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function computeAiReadiness(
  score: number,
): "HIGH" | "MODERATE" | "LOW" | "POOR" {
  if (score >= 80) return "HIGH";
  if (score >= 60) return "MODERATE";
  if (score >= 40) return "LOW";
  return "POOR";
}
