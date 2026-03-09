import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type CompositeScore,
  type DimensionResult,
  type GlobalScores,
  type Issue,
  type PackageIdentity,
  type ProfileInfo,
} from "../src/types.js";
import type { GraphStats } from "../src/graph/types.js";

function makeComposite(
  key: "consumerApi" | "agentReadiness" | "typeSafety",
  score: number | null,
): CompositeScore {
  return {
    grade: (score === null ? "N/A" : "B") as CompositeScore["grade"],
    key,
    rationale: [],
    score,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    column: 1,
    dimension: "API Safety",
    file: "src/index.ts",
    line: 10,
    message: "Test issue",
    severity: "warning",
    ...overrides,
  };
}

function makeDimension(overrides: Partial<DimensionResult> = {}): DimensionResult {
  return {
    applicability: "applicable",
    applicabilityReasons: [],
    enabled: true,
    issues: [],
    key: "apiSafety",
    label: "API Safety",
    metrics: {},
    negatives: [],
    positives: [],
    score: 70,
    weights: {},
    ...overrides,
  };
}

function buildTestResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const consumerApi = makeComposite("consumerApi", 70);
  const agentReadiness = makeComposite("agentReadiness", 65);
  const typeSafety = makeComposite("typeSafety", 75);
  const globalScores: GlobalScores = { agentReadiness, consumerApi, typeSafety };
  const profileInfo: ProfileInfo = { profile: "library", profileConfidence: 1, profileReasons: [] };
  const packageIdentity: PackageIdentity = {
    displayName: "test-pkg",
    entrypointStrategy: "types-field",
    resolvedSpec: "test-pkg@1.0.0",
    resolvedVersion: "1.0.0",
    typesSource: "bundled",
  };
  const graphStats: GraphStats = {
    dedupByStrategy: {},
    filesDeduped: 0,
    totalAfterDedup: 10,
    totalEntrypoints: 1,
    totalReachable: 10,
    usedFallbackGlob: false,
  };

  return {
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    caveats: [],
    composites: [consumerApi, agentReadiness, typeSafety],
    confidenceSummary: {
      domainInference: 0.8,
      graphResolution: 0.9,
      sampleCoverage: 0.85,
      scenarioApplicability: 0.7,
    },
    coverageDiagnostics: {
      measuredDeclarations: 20,
      measuredPositions: 50,
      reachableFiles: 10,
      samplingClass: "complete",
      typesSource: "bundled",
      undersampled: false,
      undersampledReasons: [],
    },
    dedupStats: { filesRemoved: 0, groups: 0 },
    dimensions: [],
    evidenceSummary: {
      coreSurfaceCoverage: 0.8,
      domainEvidence: 0.7,
      exportCoverage: 0.9,
      scenarioEvidence: 0.5,
      specializationEvidence: 0.6,
    },
    filesAnalyzed: 10,
    globalScores,
    graphStats,
    mode: "source",
    packageIdentity,
    profileInfo,
    projectName: "test-pkg",
    scoreComparability: "global",
    scoreProfile: "source-project",
    scoreValidity: "fully-comparable",
    status: "complete",
    timeMs: 100,
    topIssues: [],
    ...overrides,
  };
}

describe("phase 2: issue clusters and dimensionKey", () => {
  it("issues have dimensionKey set after analysis", async () => {
    const { analyzeProject } = await import("../src/analyzer.js");
    const result = analyzeProject("test/fixtures/high-precision");

    // All issues should have dimensionKey
    const allIssues = result.dimensions.flatMap((dd) => dd.issues);
    for (const issue of allIssues) {
      expect(issue.dimensionKey).toBeDefined();
      expect(issue.dimensionKey!.length).toBeGreaterThan(0);
    }
  });

  it("issue clusters have correct structure when present", async () => {
    const { analyzeProject } = await import("../src/analyzer.js");
    const result = analyzeProject("test/fixtures/high-precision", { mode: "source" });

    // Clusters field should exist (may be empty array)
    const clusters = result.issueClusters ?? [];
    // Every cluster should have valid structure
    for (const cluster of clusters) {
      expect(cluster.clusterId).toBeDefined();
      expect(cluster.category).toBeDefined();
      expect(cluster.title).toBeDefined();
      expect(cluster.whyItMatters).toBeDefined();
      expect(cluster.issueCount).toBeGreaterThan(0);
      expect(cluster.sampleIssues.length).toBeGreaterThan(0);
      expect(cluster.sampleIssues.length).toBeLessThanOrEqual(3);
      expect(cluster.agentFixStrategy).toBeDefined();
    }
  });

  it("clusters are sorted by issue count descending", async () => {
    const { analyzeProject } = await import("../src/analyzer.js");
    const result = analyzeProject("test/fixtures/low-precision", { mode: "source" });

    const clusters = result.issueClusters ?? [];
    for (let ii = 1; ii < clusters.length; ii++) {
      expect(clusters[ii - 1]!.issueCount).toBeGreaterThanOrEqual(clusters[ii]!.issueCount);
    }
  });
});

describe("phase 3: library inspection report", () => {
  it("inspection report has correct structure when present", async () => {
    const { analyzeProject } = await import("../src/analyzer.js");
    const result = analyzeProject("test/fixtures/high-precision", { mode: "package" });

    // Package mode should produce an inspection report for complete results
    const report = result.inspectionReport;
    expect(report).toBeDefined();
    expect(report!.candidateSuitability).toBeGreaterThanOrEqual(0);
    expect(report!.candidateSuitability).toBeLessThanOrEqual(100);
    expect(report!.adoptionSummary).toBeDefined();
    expect(report!.adoptionRisks).toBeDefined();
    expect(report!.evidenceQuality).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report!.safeSubset)).toBeTruthy();
    expect(Array.isArray(report!.bannedApis)).toBeTruthy();
    expect(Array.isArray(report!.requiredWrappers)).toBeTruthy();
  });

  it("inspection report is not generated for degraded results", () => {
    const result = buildTestResult({ status: "degraded" });
    expect(result.inspectionReport).toBeUndefined();
  });
});

describe("phase 5: agent JSON alignment", () => {
  it("renderAgentJson outputs actionableIssues key", async () => {
    const { buildAgentReport } = await import("../src/agent/report.js");
    const { renderAgentJson } = await import("../src/agent/report.js");

    const dim = makeDimension({
      issues: [
        makeIssue({
          confidence: 0.9,
          file: "src/a.ts",
          fixability: "direct",
          ownership: "source-owned",
          severity: "error",
          suggestedFixKind: "replace-any",
        }),
      ],
    });
    const result = buildTestResult({
      analysisScope: "self",
      dimensions: [dim],
    });
    const report = buildAgentReport(result);
    const json = JSON.parse(renderAgentJson(report));

    // Must have actionableIssues (not "issues")
    expect(json.actionableIssues).toBeDefined();
    expect(Array.isArray(json.actionableIssues)).toBeTruthy();
    expect(json.actionableIssueCount).toBe(json.actionableIssues.length);

    // "issues" key should not exist (was the old name)
    expect(json.issues).toBeUndefined();
  });
});
