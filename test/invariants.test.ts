import type { AnalysisResult } from "../src/types.js";
import { analyzeProject } from "../src/analyzer.js";
import { resolve } from "node:path";

/**
 * Phase 7: Off-corpus structural invariants.
 *
 * These tests verify generalization properties that must hold for ANY valid
 * analysis result, regardless of input. They do not reference eval manifests
 * or specific benchmark packages — only local test fixtures.
 */

const VALID_GRADES = new Set<string>(["A+", "A", "B", "C", "D", "F", "N/A"]);
const VALID_STATUSES = new Set<string>([
  "complete",
  "degraded",
  "invalid-input",
  "unsupported-package",
]);
const VALID_TRUST = new Set<string>(["trusted", "directional", "abstained"]);
const VALID_SCORE_VALIDITY = new Set<string>([
  "fully-comparable",
  "not-comparable",
  "partially-comparable",
]);
const VALID_COMPOSITE_KEYS = new Set([
  "agentReadiness",
  "consumerApi",
  "implementationQuality",
  "typeSafety",
]);

const fixturesDir = resolve(import.meta.dirname, "fixtures");

// Analyze all source-mode fixtures once at module level
const fixtureNames = [
  "high-precision",
  "low-precision",
  "medium-precision",
  "tanstack-style",
  "unsound",
  "compound-any",
  "computed-generics",
  "no-boundaries",
  "tiny-utility",
  "orm-style",
  "router-style",
  "server-router",
  "validation-style",
  "cli-builder",
];

const results: { name: string; result: AnalysisResult }[] = fixtureNames.map((name) => ({
  name,
  result: analyzeProject(resolve(fixturesDir, name)),
}));

describe("phase 7: structural invariants across all fixtures", () => {
  it.each(results)("$name: has required top-level fields", ({ result }) => {
    expect(result.status).toBeDefined();
    expect(VALID_STATUSES.has(result.status)).toBeTruthy();
    expect(result.analysisSchemaVersion).toBeDefined();
    expect(result.projectName).toBeDefined();
    expect(result.filesAnalyzed).toBeGreaterThanOrEqual(0);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.composites)).toBeTruthy();
    expect(Array.isArray(result.dimensions)).toBeTruthy();
    expect(Array.isArray(result.topIssues)).toBeTruthy();
    expect(Array.isArray(result.caveats)).toBeTruthy();
  });

  it.each(results)("$name: composites have valid grades and bounded scores", ({ result }) => {
    expect(result.composites.length).toBeGreaterThanOrEqual(3);
    expect(result.composites.length).toBeLessThanOrEqual(4);
    for (const comp of result.composites) {
      expect(VALID_GRADES.has(comp.grade)).toBeTruthy();
      expect(VALID_COMPOSITE_KEYS.has(comp.key)).toBeTruthy();
      // Null scores are valid (degraded/N/A); non-null must be 0-100
      expect(comp.score === null || (comp.score >= 0 && comp.score <= 100)).toBeTruthy();
    }
  });

  it.each(results)("$name: globalScores matches composites array", ({ result }) => {
    const { globalScores: gs } = result;
    expect(gs).toBeDefined();
    expect(gs.consumerApi).toBeDefined();
    expect(gs.agentReadiness).toBeDefined();
    expect(gs.typeSafety).toBeDefined();

    // GlobalScores must agree with composites array
    const caFromArray = result.composites.find((cc) => cc.key === "consumerApi");
    expect(gs.consumerApi.score).toBe(caFromArray!.score);
  });

  it.each(results)("$name: dimensions have bounded scores and valid keys", ({ result }) => {
    for (const dim of result.dimensions) {
      expect(dim.key).toBeDefined();
      expect(dim.key.length).toBeGreaterThan(0);
      expect(dim.label).toBeDefined();
      expect(dim.label.length).toBeGreaterThan(0);

      // Enabled dimensions with numeric scores must be in range
      expect(
        !dim.enabled || dim.score === null || (dim.score >= 0 && dim.score <= 100),
      ).toBeTruthy();

      // Issues array must exist
      expect(Array.isArray(dim.issues)).toBeTruthy();
    }
  });

  it.each(results)("$name: all issues have dimensionKey set", ({ result }) => {
    const allIssues = result.dimensions.flatMap((dd) => dd.issues);
    for (const issue of allIssues) {
      expect(issue.dimensionKey).toBeDefined();
      expect(issue.dimensionKey!.length).toBeGreaterThan(0);
    }
  });

  it.each(results)("$name: scoreValidity is a valid enum value", ({ result }) => {
    expect(VALID_SCORE_VALIDITY.has(result.scoreValidity)).toBeTruthy();
  });

  it.each(results)("$name: trustSummary has valid classification", ({ result }) => {
    expect(result.trustSummary).toBeDefined();
    expect(VALID_TRUST.has(result.trustSummary!.classification)).toBeTruthy();
    expect(result.trustSummary!.canCompare).toStrictEqual(expect.any(Boolean));
    expect(result.trustSummary!.canGate).toStrictEqual(expect.any(Boolean));
    expect(Array.isArray(result.trustSummary!.reasons)).toBeTruthy();
  });

  it.each(results)("$name: confidenceSummary values are in [0, 1]", ({ result }) => {
    const cs = result.confidenceSummary;
    expect(cs).toBeDefined();
    expect(cs!.sampleCoverage).toBeGreaterThanOrEqual(0);
    expect(cs!.sampleCoverage).toBeLessThanOrEqual(1);
    expect(cs!.graphResolution).toBeGreaterThanOrEqual(0);
    expect(cs!.graphResolution).toBeLessThanOrEqual(1);
    expect(cs!.domainInference).toBeGreaterThanOrEqual(0);
    expect(cs!.domainInference).toBeLessThanOrEqual(1);
    expect(cs!.scenarioApplicability).toBeGreaterThanOrEqual(0);
    expect(cs!.scenarioApplicability).toBeLessThanOrEqual(1);
  });

  it.each(results)("$name: coverageDiagnostics has non-negative counts", ({ result }) => {
    const cd = result.coverageDiagnostics;
    expect(cd).toBeDefined();
    expect(cd!.reachableFiles).toBeGreaterThanOrEqual(0);
    expect(cd!.measuredDeclarations).toBeGreaterThanOrEqual(0);
    expect(cd!.measuredPositions).toBeGreaterThanOrEqual(0);
  });
});

describe("phase 7: trust classification consistency", () => {
  it.each(results)("$name: null composite scores always have N/A grade", ({ result }) => {
    for (const comp of result.composites) {
      // Null score ↔ N/A grade invariant
      expect(comp.score === null ? comp.grade === "N/A" : comp.grade !== "N/A").toBeTruthy();
    }
  });

  it.each(results)("$name: complete non-undersampled fixtures are not abstained", ({ result }) => {
    const isComplete = result.status === "complete";
    const hasGoodCoverage = result.coverageDiagnostics && !result.coverageDiagnostics.undersampled;
    // Skip fixtures that aren't complete+good-coverage (the invariant doesn't apply)
    const applicable = isComplete && hasGoodCoverage;
    expect(!applicable || result.trustSummary!.classification !== "abstained").toBeTruthy();
  });
});

describe("phase 7: issue clusters structural invariants", () => {
  it.each(results)("$name: issue clusters are sorted by count descending", ({ result }) => {
    const clusters = result.issueClusters ?? [];
    for (let ii = 1; ii < clusters.length; ii++) {
      expect(clusters[ii - 1]!.issueCount).toBeGreaterThanOrEqual(clusters[ii]!.issueCount);
    }
  });

  it.each(results)("$name: cluster sample issues never exceed 3", ({ result }) => {
    const clusters = result.issueClusters ?? [];
    for (const cluster of clusters) {
      expect(cluster.sampleIssues.length).toBeLessThanOrEqual(3);
      expect(cluster.issueCount).toBeGreaterThan(0);
    }
  });
});

describe("phase 7: determinism", () => {
  it("analyzing the same fixture twice yields identical scores", () => {
    const path = resolve(fixturesDir, "high-precision");
    const r1 = analyzeProject(path);
    const r2 = analyzeProject(path);

    for (const comp of r1.composites) {
      const match = r2.composites.find((cc) => cc.key === comp.key);
      expect(match).toBeDefined();
      expect(comp.score).toBe(match!.score);
      expect(comp.grade).toBe(match!.grade);
    }

    expect(r1.dimensions).toHaveLength(r2.dimensions.length);
    for (let ii = 0; ii < r1.dimensions.length; ii++) {
      expect(r1.dimensions[ii]!.score).toBe(r2.dimensions[ii]!.score);
    }
  });
});

describe("phase 7: edge case resilience", () => {
  it("empty directory produces degraded or zero-file result without crashing", () => {
    const emptyPath = resolve(fixturesDir, `nonexistent-dir-${Date.now()}`);
    const result = analyzeProject(emptyPath);

    // Should complete without throwing
    expect(VALID_STATUSES.has(result.status)).toBeTruthy();
    expect(result.analysisSchemaVersion).toBeDefined();
  });

  it("package mode on source fixture produces valid result", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"), { mode: "package" });
    expect(VALID_STATUSES.has(result.status)).toBeTruthy();
    expect(result.composites.length).toBeGreaterThanOrEqual(3);
    for (const comp of result.composites) {
      expect(VALID_GRADES.has(comp.grade)).toBeTruthy();
    }
  });
});
