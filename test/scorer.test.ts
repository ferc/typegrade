import { describe, it, expect } from "vitest";
import {
  computeOverallScore,
  computeGrade,
  computeAiReadiness,
} from "../src/scorer.js";
import type { DimensionResult } from "../src/types.js";

function makeDim(
  name: string,
  score: number,
  weight: number,
): DimensionResult {
  return { name, score, weight, details: [], issues: [] };
}

describe("computeOverallScore", () => {
  it("computes weighted average", () => {
    const dims = [
      makeDim("A", 100, 0.5),
      makeDim("B", 0, 0.5),
    ];
    expect(computeOverallScore(dims)).toBe(50);
  });

  it("handles unequal weights", () => {
    const dims = [
      makeDim("A", 100, 0.8),
      makeDim("B", 0, 0.2),
    ];
    expect(computeOverallScore(dims)).toBe(80);
  });

  it("returns 0 for empty dimensions", () => {
    expect(computeOverallScore([])).toBe(0);
  });
});

describe("computeGrade", () => {
  it("returns correct grades", () => {
    expect(computeGrade(95)).toBe("A+");
    expect(computeGrade(85)).toBe("A");
    expect(computeGrade(70)).toBe("B");
    expect(computeGrade(55)).toBe("C");
    expect(computeGrade(40)).toBe("D");
    expect(computeGrade(39)).toBe("F");
    expect(computeGrade(0)).toBe("F");
  });
});

describe("computeAiReadiness", () => {
  it("returns correct readiness levels", () => {
    expect(computeAiReadiness(80)).toBe("HIGH");
    expect(computeAiReadiness(60)).toBe("MODERATE");
    expect(computeAiReadiness(40)).toBe("LOW");
    expect(computeAiReadiness(39)).toBe("POOR");
  });
});
