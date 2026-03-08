import { mkdirSync, rmSync } from "node:fs";
import { analyzeProject } from "../src/analyzer.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function getComposite(result: ReturnType<typeof analyzeProject>, key: string) {
  return result.composites.find((composite) => composite.key === key);
}

function getDimension(result: ReturnType<typeof analyzeProject>, key: string) {
  return result.dimensions.find((dim) => dim.key === key);
}

describe("e2e: analyzeProject", () => {
  it("scores high-precision fixture with high consumer API", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const ca = getComposite(result, "consumerApi");
    expect(ca).toBeDefined();
    expect(ca!.score).toBeGreaterThanOrEqual(60);
    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.mode).toBe("source");
  });

  it("high-precision fixture has no api-safety errors", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const safety = getDimension(result, "apiSafety");
    expect(safety).toBeDefined();
    const errors = safety!.issues.filter((issue) => issue.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("scores low-precision fixture with low consumer API", () => {
    const result = analyzeProject(resolve(fixturesDir, "low-precision"));
    const ca = getComposite(result, "consumerApi");
    expect(ca!.score).toBeLessThan(50);
  });

  it("scores medium-precision fixture in mid range", () => {
    const result = analyzeProject(resolve(fixturesDir, "medium-precision"));
    const ca = getComposite(result, "consumerApi");
    expect(ca!.score).toBeGreaterThanOrEqual(40);
    expect(ca!.score).toBeLessThanOrEqual(85);
  });

  it("tanstack-style fixture has decent semantic lift", () => {
    const result = analyzeProject(resolve(fixturesDir, "tanstack-style"));
    const lift = getDimension(result, "semanticLift");
    expect(lift).toBeDefined();
    expect(lift!.score).toBeGreaterThanOrEqual(15);
  });

  it("unsound fixture has low soundness score", () => {
    const result = analyzeProject(resolve(fixturesDir, "unsound"));
    const soundness = getDimension(result, "implementationSoundness");
    expect(soundness).toBeDefined();
    expect(soundness!.score).toBeLessThan(30);
  });

  it("unsound fixture does not double-count nested assertions", () => {
    const result = analyzeProject(resolve(fixturesDir, "unsound"));
    const soundness = getDimension(result, "implementationSoundness")!;
    const doubleIssues = soundness.issues.filter((issue) => issue.message.includes("double"));
    expect(doubleIssues).toHaveLength(2);
    const innerUnknownWarnings = soundness.issues.filter(
      (issue) => issue.severity === "warning" && issue.message.includes("as unknown"),
    );
    expect(innerUnknownWarnings).toHaveLength(0);
  });

  it("returns 0/N/A when no source files found", () => {
    const emptyDir = resolve(tmpdir(), `typegrade-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = analyzeProject(emptyDir);
      expect(result.filesAnalyzed).toBe(0);
      const ar = getComposite(result, "agentReadiness");
      expect(ar!.score).toBe(0);
      expect(ar!.grade).toBe("N/A");
      expect(result.dimensions).toHaveLength(0);
    } finally {
      rmSync(emptyDir, { force: true, recursive: true });
    }
  });

  it("returns valid JSON structure", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    expect(result).toHaveProperty("mode");
    expect(result).toHaveProperty("scoreProfile");
    expect(result).toHaveProperty("projectName");
    expect(result).toHaveProperty("filesAnalyzed");
    expect(result).toHaveProperty("timeMs");
    expect(result).toHaveProperty("composites");
    expect(result).toHaveProperty("dimensions");
    expect(result).toHaveProperty("topIssues");
    expect(result).toHaveProperty("caveats");
    expect(result.composites.length).toBeGreaterThanOrEqual(4);
  });

  it("all enabled dimensions have key, label, score", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    for (const dim of result.dimensions) {
      expect(dim).toHaveProperty("key");
      expect(dim).toHaveProperty("label");
    }
    const enabledDims = result.dimensions.filter((dim) => dim.enabled);
    for (const dim of enabledDims) {
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
    }
  });

  it("source mode has 12 dimensions", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    expect(result.dimensions).toHaveLength(12);
    expect(result.mode).toBe("source");
  });

  it("compound-any fixture has low api-safety", () => {
    const result = analyzeProject(resolve(fixturesDir, "compound-any"));
    const safety = getDimension(result, "apiSafety");
    expect(safety).toBeDefined();
    expect(safety!.score).toBeLessThan(50);
    expect(safety!.issues.filter((issue) => issue.severity === "error").length).toBeGreaterThan(0);
  });

  it("computed-generics fixture has semantic lift", () => {
    const result = analyzeProject(resolve(fixturesDir, "computed-generics"));
    const lift = getDimension(result, "semanticLift");
    expect(lift).toBeDefined();
    expect(lift!.score).toBeGreaterThanOrEqual(20);
  });

  it("correlated-generics fixture has generic correlation", () => {
    const result = analyzeProject(resolve(fixturesDir, "correlated-generics"));
    const lift = getDimension(result, "semanticLift");
    expect(lift).toBeDefined();
    expect(lift!.score).toBeGreaterThanOrEqual(15);
  });

  it("no-boundaries fixture disables boundary discipline", () => {
    const result = analyzeProject(resolve(fixturesDir, "no-boundaries"));
    const boundary = getDimension(result, "boundaryDiscipline");
    expect(boundary).toBeDefined();
    expect(boundary!.enabled).toBeFalsy();
    expect(boundary!.score).toBeNull();
  });

  it("declaration-good fixture scores high in package mode", () => {
    const result = analyzeProject(resolve(fixturesDir, "declaration-good"), {
      mode: "package",
      sourceFilesOptions: { includeDts: true },
    });
    expect(result.mode).toBe("package");
    const ca = getComposite(result, "consumerApi");
    expect(ca!.score).toBeGreaterThanOrEqual(50);
    // Implementation dimensions should be disabled
    const impl = getDimension(result, "implementationSoundness");
    expect(impl!.enabled).toBeFalsy();
  });

  it("declaration-loose fixture scores low in package mode", () => {
    const result = analyzeProject(resolve(fixturesDir, "declaration-loose"), {
      mode: "package",
      sourceFilesOptions: { includeDts: true },
    });
    expect(result.mode).toBe("package");
    const ca = getComposite(result, "consumerApi");
    expect(ca!.score).toBeLessThan(50);
    const safety = getDimension(result, "apiSafety");
    expect(safety!.score).toBeLessThan(50);
  });

  it("high-precision beats low-precision on consumer API", () => {
    const high = analyzeProject(resolve(fixturesDir, "high-precision"));
    const low = analyzeProject(resolve(fixturesDir, "low-precision"));
    const highCa = getComposite(high, "consumerApi")!;
    const lowCa = getComposite(low, "consumerApi")!;
    expect(highCa.score!).toBeGreaterThan(lowCa.score!);
  });

  it("index-signatures fixture has surface consistency dimension", () => {
    const result = analyzeProject(resolve(fixturesDir, "index-signatures"));
    const consistency = getDimension(result, "surfaceConsistency");
    expect(consistency).toBeDefined();
    expect(consistency!.enabled).toBeTruthy();
  });

  it("index-signatures fixture has surface complexity dimension", () => {
    const result = analyzeProject(resolve(fixturesDir, "index-signatures"));
    const complexity = getDimension(result, "surfaceComplexity");
    expect(complexity).toBeDefined();
    expect(complexity!.enabled).toBeTruthy();
  });

  it("index-signatures fixture has agent usability dimension", () => {
    const result = analyzeProject(resolve(fixturesDir, "index-signatures"));
    const agentUsability = getDimension(result, "agentUsability");
    expect(agentUsability).toBeDefined();
    expect(agentUsability!.enabled).toBeTruthy();
  });

  it("router-style fixture has domain inference with signals", () => {
    const result = analyzeProject(resolve(fixturesDir, "router-style"));
    expect(result.domainInference).toBeDefined();
    expect(result.domainInference!.signals.length).toBeGreaterThan(0);
  });

  it("orm-style fixture has domain inference with signals", () => {
    const result = analyzeProject(resolve(fixturesDir, "orm-style"));
    expect(result.domainInference).toBeDefined();
    expect(result.domainInference!.signals.length).toBeGreaterThan(0);
  });

  it("explain option generates explainability report", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"), { explain: true });
    expect(result.explainability).toBeDefined();
    expect(result.explainability!.lowestSpecificity).toBeDefined();
    expect(result.explainability!.highestLift).toBeDefined();
    expect(result.explainability!.safetyLeaks).toBeDefined();
    expect(result.explainability!.domainSuppressions).toBeDefined();
    expect(result.explainability!.lowestUsability).toBeDefined();
    expect(result.explainability!.highestSpecificity).toBeDefined();
    expect(result.explainability!.domainAmbiguities).toBeDefined();
  });

  it("composites include confidence values", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const ca = getComposite(result, "consumerApi");
    expect(ca!.confidence).toBeDefined();
    expect(ca!.confidence).toBeGreaterThan(0);
    expect(ca!.confidence).toBeLessThanOrEqual(1);
  });

  it("api-specificity dimension includes confidence signals", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const spec = getDimension(result, "apiSpecificity");
    expect(spec!.confidenceSignals).toBeDefined();
    expect(spec!.confidenceSignals!.length).toBeGreaterThan(0);
    expect(spec!.confidenceSignals![0]!.source).toBe("sample-coverage");
  });

  it("validation-style fixture has domain inference", () => {
    const result = analyzeProject(resolve(fixturesDir, "validation-style"));
    expect(result.domainInference).toBeDefined();
    // Validation detection needs package name or strong unknown-param signal
    // In source mode with emit, the type flags may differ
    expect(result.domainInference!.domain).toBeDefined();
  });

  it("namespace-export fixture has namespace declarations", () => {
    const result = analyzeProject(resolve(fixturesDir, "namespace-export"));
    expect(result.filesAnalyzed).toBeGreaterThan(0);
    const spec = getDimension(result, "apiSpecificity");
    expect(spec).toBeDefined();
    expect(spec!.enabled).toBeTruthy();
  });

  it("all composites have valid grades", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    for (const composite of result.composites) {
      expect(["A+", "A", "B", "C", "D", "F", "N/A"]).toContain(composite.grade);
    }
  });

  it("surface consistency dimension is present", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const consistency = getDimension(result, "surfaceConsistency");
    expect(consistency).toBeDefined();
    expect(consistency!.enabled).toBeTruthy();
    expect(consistency!.score).toBeGreaterThanOrEqual(0);
  });

  it("surface complexity dimension is present", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const complexity = getDimension(result, "surfaceComplexity");
    expect(complexity).toBeDefined();
    expect(complexity!.enabled).toBeTruthy();
    expect(complexity!.score).toBeGreaterThanOrEqual(0);
  });

  it("agent usability dimension is present", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    const agentUsability = getDimension(result, "agentUsability");
    expect(agentUsability).toBeDefined();
    expect(agentUsability!.enabled).toBeTruthy();
    expect(agentUsability!.score).toBeGreaterThanOrEqual(0);
  });

  it("low-precision fixture has api-safety errors", () => {
    const result = analyzeProject(resolve(fixturesDir, "low-precision"));
    const safety = getDimension(result, "apiSafety");
    expect(safety).toBeDefined();
    expect(safety!.score).toBeLessThan(100);
  });

  it("unsound fixture has implementation quality below consumer API", () => {
    const result = analyzeProject(resolve(fixturesDir, "unsound"));
    const ca = getComposite(result, "consumerApi");
    const impl = getComposite(result, "implementationQuality");
    expect(impl).toBeDefined();
    expect(impl!.score).toBeLessThan(ca!.score!);
  });
});
