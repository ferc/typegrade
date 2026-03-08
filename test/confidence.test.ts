import type { DimensionResult } from "../src/types.js";
import { computeComposites } from "../src/scorer.js";

function makeDim(opts: {
  key: string;
  label: string;
  score: number | null;
  weights: Partial<
    Record<"consumerApi" | "implementationQuality" | "agentReadiness" | "typeSafety", number>
  >;
  confidence?: number;
  confidenceSignals?: { source: string; value: number; reason: string }[];
}): DimensionResult {
  return {
    confidence: opts.confidence,
    confidenceSignals: opts.confidenceSignals,
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

describe("confidence signal propagation", () => {
  it("uses weighted evidence score for composite confidence", () => {
    const dims = [
      makeDim({ confidence: 1, key: "a", label: "A", score: 80, weights: { consumerApi: 0.5 } }),
      makeDim({ confidence: 0.5, key: "b", label: "B", score: 60, weights: { consumerApi: 0.5 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((comp) => comp.key === "consumerApi");
    // Weighted: 0.6 * min(0.5) + 0.4 * avg(0.75) = 0.3 + 0.3 = 0.6
    expect(ca!.confidence).toBe(0.6);
  });

  it("defaults to 0.8 when no confidence specified", () => {
    const dims = [
      makeDim({ key: "a", label: "A", score: 80, weights: { consumerApi: 0.5 } }),
      makeDim({ key: "b", label: "B", score: 60, weights: { consumerApi: 0.5 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((comp) => comp.key === "consumerApi");
    expect(ca!.confidence).toBe(0.8);
  });

  it("single dimension confidence propagates directly", () => {
    const dims = [
      makeDim({ confidence: 0.3, key: "a", label: "A", score: 80, weights: { consumerApi: 1 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((comp) => comp.key === "consumerApi");
    // 0.6 * 0.3 + 0.4 * 0.3 = 0.3
    expect(ca!.confidence).toBe(0.3);
  });

  it("confidence signals are preserved on dimensions", () => {
    const signals = [{ reason: "14 positions analyzed", source: "sample-coverage", value: 0.7 }];
    const dim = makeDim({
      confidence: 0.7,
      confidenceSignals: signals,
      key: "a",
      label: "A",
      score: 80,
      weights: { consumerApi: 1 },
    });
    expect(dim.confidenceSignals).toHaveLength(1);
    expect(dim.confidenceSignals![0]!.source).toBe("sample-coverage");
  });

  it("min confidence is 0 for empty dimensions", () => {
    const composites = computeComposites([], "source");
    const ca = composites.find((comp) => comp.key === "consumerApi");
    expect(ca!.confidence).toBeUndefined();
    expect(ca!.score).toBe(0);
  });

  it("compositeConfidenceReasons are populated", () => {
    const dims = [
      makeDim({ confidence: 0.9, key: "a", label: "A", score: 80, weights: { consumerApi: 0.5 } }),
      makeDim({ confidence: 0.5, key: "b", label: "B", score: 60, weights: { consumerApi: 0.5 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((comp) => comp.key === "consumerApi");
    expect(ca!.compositeConfidenceReasons).toBeDefined();
    expect(ca!.compositeConfidenceReasons!.length).toBeGreaterThan(0);
    expect(ca!.compositeConfidenceReasons!.some((reason) => reason.includes("Bottleneck"))).toBeTruthy();
  });
});
