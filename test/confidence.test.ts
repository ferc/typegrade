
import { computeComposites } from "../src/scorer.js";
import type { DimensionResult } from "../src/types.js";

function makeDim(opts: {
  key: string;
  label: string;
  score: number | null;
  weights: Partial<Record<"consumerApi" | "implementationQuality" | "agentReadiness", number>>;
  confidence?: number;
  confidenceSignals?: Array<{ source: string; value: number; reason: string }>;
}): DimensionResult {
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
    confidence: opts.confidence,
    confidenceSignals: opts.confidenceSignals,
  };
}

describe("confidence signal propagation", () => {
  it("uses min-signal logic for composite confidence", () => {
    const dims = [
      makeDim({ key: "a", label: "A", score: 80, weights: { consumerApi: 0.5 }, confidence: 1.0 }),
      makeDim({ key: "b", label: "B", score: 60, weights: { consumerApi: 0.5 }, confidence: 0.5 }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((c) => c.key === "consumerApi");
    expect(ca!.confidence).toBe(0.5); // min of 1.0 and 0.5
  });

  it("defaults to 0.8 when no confidence specified", () => {
    const dims = [
      makeDim({ key: "a", label: "A", score: 80, weights: { consumerApi: 0.5 } }),
      makeDim({ key: "b", label: "B", score: 60, weights: { consumerApi: 0.5 } }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((c) => c.key === "consumerApi");
    expect(ca!.confidence).toBe(0.8);
  });

  it("single dimension confidence propagates directly", () => {
    const dims = [
      makeDim({ key: "a", label: "A", score: 80, weights: { consumerApi: 1.0 }, confidence: 0.3 }),
    ];
    const composites = computeComposites(dims, "source");
    const ca = composites.find((c) => c.key === "consumerApi");
    expect(ca!.confidence).toBe(0.3);
  });

  it("confidence signals are preserved on dimensions", () => {
    const signals = [
      { source: "sample-coverage", value: 0.7, reason: "14 positions analyzed" },
    ];
    const dim = makeDim({
      key: "a",
      label: "A",
      score: 80,
      weights: { consumerApi: 1.0 },
      confidence: 0.7,
      confidenceSignals: signals,
    });
    expect(dim.confidenceSignals).toHaveLength(1);
    expect(dim.confidenceSignals![0]!.source).toBe("sample-coverage");
  });

  it("min confidence is 0 for empty dimensions", () => {
    const composites = computeComposites([], "source");
    const ca = composites.find((c) => c.key === "consumerApi");
    expect(ca!.confidence).toBeUndefined();
    expect(ca!.score).toBe(0);
  });
});
