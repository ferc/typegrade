import { computeComposites, computeGrade } from "../src/scorer.js";
import type { DimensionResult } from "../src/types.js";

interface MakeDimOptions {
  key: string;
  label: string;
  score: number | null;
  weights: Partial<
    Record<"consumerApi" | "implementationQuality" | "agentReadiness" | "typeSafety", number>
  >;
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
      makeDim({
        key: "apiSpecificity",
        label: "API Specificity",
        score: 80,
        weights: { consumerApi: 0.3 },
      }),
      makeDim({
        key: "apiSafety",
        label: "API Safety",
        score: 100,
        weights: { consumerApi: 0.25 },
      }),
      makeDim({
        key: "semanticLift",
        label: "Semantic Lift",
        score: 60,
        weights: { consumerApi: 0.2 },
      }),
      makeDim({
        key: "publishQuality",
        label: "Publish Quality",
        score: 70,
        weights: { consumerApi: 0.15 },
      }),
    ];
    const composites = computeComposites(dims, "source");
    const consumerApi = composites.find((item) => item.key === "consumerApi");
    expect(consumerApi).toBeDefined();
    expect(consumerApi!.score).toBeGreaterThan(0);
    expect(consumerApi!.score).toBeLessThanOrEqual(100);
  });

  it("returns null implementation quality in package mode", () => {
    const dims = [
      makeDim({
        key: "apiSpecificity",
        label: "API Specificity",
        score: 80,
        weights: { consumerApi: 0.3 },
      }),
      makeDim({
        key: "apiSafety",
        label: "API Safety",
        score: 100,
        weights: { consumerApi: 0.25 },
      }),
    ];
    const composites = computeComposites(dims, "package");
    const impl = composites.find((item) => item.key === "implementationQuality");
    expect(impl).toBeDefined();
    expect(impl!.score).toBeNull();
    expect(impl!.grade).toBe("N/A");
  });

  it("computes typeSafety from safety and specificity dimensions", () => {
    const dims = [
      makeDim({
        key: "apiSafety",
        label: "API Safety",
        score: 90,
        weights: { consumerApi: 0.2, typeSafety: 0.55 },
      }),
      makeDim({
        key: "apiSpecificity",
        label: "API Specificity",
        score: 80,
        weights: { consumerApi: 0.3, typeSafety: 0.25 },
      }),
      makeDim({
        key: "semanticLift",
        label: "Semantic Lift",
        score: 70,
        weights: { consumerApi: 0.15, typeSafety: 0.1 },
      }),
      makeDim({
        key: "publishQuality",
        label: "Publish Quality",
        score: 60,
        weights: { consumerApi: 0.1, typeSafety: 0.1 },
      }),
    ];
    const composites = computeComposites(dims, "package");
    const typeSafety = composites.find((item) => item.key === "typeSafety");
    expect(typeSafety).toBeDefined();
    expect(typeSafety!.score).toBeGreaterThan(0);
    // ApiSafety dominates typeSafety, so it should be > 80
    expect(typeSafety!.score).toBeGreaterThan(80);
  });

  it("computes agentReadiness from dimension weights directly", () => {
    const dims = [
      makeDim({
        key: "agentUsability",
        label: "Agent Usability",
        score: 70,
        weights: { agentReadiness: 0.35, consumerApi: 0.15 },
      }),
      makeDim({
        key: "apiSpecificity",
        label: "API Specificity",
        score: 80,
        weights: { agentReadiness: 0.2, consumerApi: 0.3 },
      }),
      makeDim({
        key: "apiSafety",
        label: "API Safety",
        score: 90,
        weights: { agentReadiness: 0.15, consumerApi: 0.2 },
      }),
    ];
    const composites = computeComposites(dims, "package");
    const ar = composites.find((item) => item.key === "agentReadiness");
    expect(ar).toBeDefined();
    expect(ar!.score).toBeGreaterThan(0);
  });

  it("returns all four composites", () => {
    const dims = [
      makeDim({
        key: "apiSpecificity",
        label: "API Specificity",
        score: 80,
        weights: { consumerApi: 0.3, typeSafety: 0.25 },
      }),
    ];
    const composites = computeComposites(dims, "package");
    const keys = composites.map((c) => c.key);
    expect(keys).toContain("consumerApi");
    expect(keys).toContain("agentReadiness");
    expect(keys).toContain("typeSafety");
    expect(keys).toContain("implementationQuality");
  });

  it("returns 0 for empty dimensions", () => {
    const composites = computeComposites([], "source");
    const ca = composites.find((item) => item.key === "consumerApi");
    expect(ca!.score).toBe(0);
  });

  it("includes compositeConfidenceReasons when dimensions have confidence", () => {
    const dims = [
      {
        ...makeDim({
          key: "apiSpecificity",
          label: "API Specificity",
          score: 80,
          weights: { consumerApi: 0.3 },
        }),
        confidence: 0.5,
      },
      {
        ...makeDim({
          key: "apiSafety",
          label: "API Safety",
          score: 90,
          weights: { consumerApi: 0.2 },
        }),
        confidence: 0.9,
      },
    ];
    const composites = computeComposites(dims, "package");
    const ca = composites.find((item) => item.key === "consumerApi");
    expect(ca!.compositeConfidenceReasons).toBeDefined();
    expect(ca!.compositeConfidenceReasons!.length).toBeGreaterThan(0);
  });
});
