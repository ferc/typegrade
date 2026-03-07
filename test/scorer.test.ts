
import { computeComposites, computeGrade } from "../src/scorer.js";
import type { DimensionResult } from "../src/types.js";

interface MakeDimOptions {
  key: string;
  label: string;
  score: number | null;
  weights: Partial<Record<"consumerApi" | "implementationQuality" | "agentReadiness", number>>;
}

function makeDim(opts: MakeDimOptions): DimensionResult {
  return {
    enabled: opts.score !== null,
    issues: [],
    key: opts.key,
    label: opts.label,
    metrics: {},
    negatives: [],
    positives: [],
    score: opts.score,
    weights: opts.weights,
  };
}

describe(computeGrade, () => {
  it("returns correct grades", () => {
    expect(computeGrade(95)).toBe("A+");
    expect(computeGrade(85)).toBe("A");
    expect(computeGrade(70)).toBe("B");
    expect(computeGrade(55)).toBe("C");
    expect(computeGrade(40)).toBe("D");
    expect(computeGrade(39)).toBe("F");
    expect(computeGrade(0)).toBe("F");
    expect(computeGrade(null)).toBe("N/A");
  });
});

describe(computeComposites, () => {
  it("computes consumer API from consumer dimensions", () => {
    const dims = [
      makeDim({ key: "apiSpecificity", label: "API Specificity", score: 80, weights: { consumerApi: 0.3 } }),
      makeDim({ key: "apiSafety", label: "API Safety", score: 100, weights: { consumerApi: 0.25 } }),
      makeDim({ key: "apiExpressiveness", label: "API Expressiveness", score: 60, weights: { consumerApi: 0.2 } }),
      makeDim({ key: "publishQuality", label: "Publish Quality", score: 70, weights: { consumerApi: 0.15 } }),
    ];
    const composites = computeComposites(dims, "source");
    const consumerApi = composites.find((item) => item.key === "consumerApi");
    expect(consumerApi).toBeDefined();
    expect(consumerApi!.score).toBeGreaterThan(0);
    expect(consumerApi!.score).toBeLessThanOrEqual(100);
  });

  it("returns null implementation quality in package mode", () => {
    const dims = [
      makeDim({ key: "apiSpecificity", label: "API Specificity", score: 80, weights: { consumerApi: 0.3 } }),
      makeDim({ key: "apiSafety", label: "API Safety", score: 100, weights: { consumerApi: 0.25 } }),
    ];
    const composites = computeComposites(dims, "package");
    const impl = composites.find((item) => item.key === "implementationQuality");
    expect(impl).toBeDefined();
    expect(impl!.score).toBeNull();
    expect(impl!.grade).toBe("N/A");
  });

  it("agent readiness equals consumer API in package mode", () => {
    const dims = [
      makeDim({ key: "apiSpecificity", label: "API Specificity", score: 80, weights: { consumerApi: 0.3 } }),
      makeDim({ key: "apiSafety", label: "API Safety", score: 100, weights: { consumerApi: 0.25 } }),
    ];
    const composites = computeComposites(dims, "package");
    const ar = composites.find((item) => item.key === "agentReadiness");
    const ca = composites.find((item) => item.key === "consumerApi");
    expect(ar!.score).toBe(ca!.score);
  });

  it("agent readiness blends consumer and implementation in source mode", () => {
    const dims = [
      makeDim({ key: "apiSpecificity", label: "API Specificity", score: 100, weights: { consumerApi: 0.5 } }),
      makeDim({ key: "implementationSoundness", label: "Soundness", score: 50, weights: { implementationQuality: 0.5 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ar = composites.find((item) => item.key === "agentReadiness");
    // 0.65 * 100 + 0.35 * 50 = 82.5 -> 83
    expect(ar!.score).toBe(83);
  });

  it("returns 0 for empty dimensions", () => {
    const composites = computeComposites([], "source");
    const ca = composites.find((item) => item.key === "consumerApi");
    expect(ca!.score).toBe(0);
  });
});
