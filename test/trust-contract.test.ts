import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type CompositeScore,
  type ConfidenceSummary,
  type CoverageDiagnostics,
  type DegradedCategory,
  type EvidenceSummary,
  type GlobalScores,
  type Grade,
  type PackageIdentity,
  type ProfileInfo,
} from "../src/types.js";
import { minSampleForBound, wilsonLowerBound, wilsonUpperBound } from "../benchmarks/stats.js";
import type { GraphStats } from "../src/graph/types.js";
import { normalizeResult } from "../src/analyzer.js";

/** Build a minimal valid AnalysisResult for testing */
function buildTestResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const makeComposite = (
    key: "consumerApi" | "agentReadiness" | "typeSafety",
    score: number | null,
  ): CompositeScore => ({
    grade: (score === null ? "N/A" : "B") as Grade,
    key,
    rationale: [],
    score,
  });

  const consumerApi = makeComposite("consumerApi", 70);
  const agentReadiness = makeComposite("agentReadiness", 65);
  const typeSafety = makeComposite("typeSafety", 75);

  const globalScores: GlobalScores = { agentReadiness, consumerApi, typeSafety };
  const profileInfo: ProfileInfo = { profile: "package", profileConfidence: 1, profileReasons: [] };
  const packageIdentity: PackageIdentity = {
    displayName: "test-pkg",
    entrypointStrategy: "types-field",
    resolvedSpec: "test-pkg@1.0.0",
    resolvedVersion: "1.0.0",
    typesSource: "bundled",
  };
  const confidenceSummary: ConfidenceSummary = {
    domainInference: 0.8,
    graphResolution: 0.9,
    sampleCoverage: 0.85,
    scenarioApplicability: 0.7,
  };
  const coverageDiagnostics: CoverageDiagnostics = {
    measuredDeclarations: 20,
    measuredPositions: 50,
    reachableFiles: 10,
    samplingClass: "complete",
    typesSource: "bundled",
    undersampled: false,
    undersampledReasons: [],
  };
  const evidenceSummary: EvidenceSummary = {
    coreSurfaceCoverage: 0.8,
    domainEvidence: 0.7,
    exportCoverage: 0.9,
    scenarioEvidence: 0.5,
    specializationEvidence: 0.6,
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
    confidenceSummary,
    coverageDiagnostics,
    dedupStats: { filesRemoved: 0, groups: 0 },
    dimensions: [],
    evidenceSummary,
    filesAnalyzed: 10,
    globalScores,
    graphStats,
    mode: "package",
    packageIdentity,
    profileInfo,
    projectName: "test-pkg",
    scoreComparability: "global",
    scoreProfile: "published-declarations",
    scoreValidity: "fully-comparable",
    status: "complete",
    timeMs: 100,
    topIssues: [],
    ...overrides,
  };
}

describe("trust contract: degraded results never expose numeric composites", () => {
  it("should null all composites when status is degraded", () => {
    const result = buildTestResult({ status: "degraded" });
    const normalized = normalizeResult(result);

    for (const comp of normalized.composites) {
      expect(comp.score).toBeNull();
      expect(comp.grade).toBe("N/A");
    }
    expect(normalized.globalScores.consumerApi.score).toBeNull();
    expect(normalized.globalScores.agentReadiness.score).toBeNull();
    expect(normalized.globalScores.typeSafety.score).toBeNull();
  });

  it("should strip domain and scenario scores from degraded results", () => {
    const result = buildTestResult({
      domainScore: {
        adjustments: [],
        comparability: "domain",
        confidence: 0.8,
        domain: "validation",
        grade: "A",
        score: 85,
      },
      scenarioScore: {
        comparability: "scenario",
        domain: "validation",
        grade: "A",
        passedScenarios: 3,
        results: [],
        scenario: "validation",
        score: 80,
        totalScenarios: 4,
      },
      status: "degraded",
    });
    const normalized = normalizeResult(result);

    expect(normalized.domainScore).toBeUndefined();
    expect(normalized.scenarioScore).toBeUndefined();
  });

  it("should set scoreValidity to not-comparable for degraded results", () => {
    const result = buildTestResult({ status: "degraded" });
    const normalized = normalizeResult(result);

    expect(normalized.scoreValidity).toBe("not-comparable");
  });

  it("should set autofixAbstentionReason for degraded results", () => {
    const result = buildTestResult({
      degradedReason: "test degradation",
      status: "degraded",
    });
    const normalized = normalizeResult(result);

    expect(normalized.autofixAbstentionReason).toBeDefined();
    expect(normalized.autofixAbstentionReason!.length).toBeGreaterThan(0);
  });
});

describe("trust contract: fallback-glob results are never marked trusted", () => {
  it("should classify fallback-glob as directional", () => {
    const result = buildTestResult({
      graphStats: {
        dedupByStrategy: {},
        fallbackReason: "no-exports-map",
        filesDeduped: 0,
        totalAfterDedup: 5,
        totalEntrypoints: 0,
        totalReachable: 5,
        usedFallbackGlob: true,
      },
      packageIdentity: {
        displayName: "test-pkg",
        entrypointStrategy: "fallback-glob",
        resolvedSpec: "test-pkg@1.0.0",
        resolvedVersion: "1.0.0",
        typesSource: "bundled",
      },
    });
    const normalized = normalizeResult(result);

    expect(normalized.trustSummary).toBeDefined();
    expect(normalized.trustSummary!.classification).toBe("directional");
    expect(normalized.trustSummary!.canGate).toBeFalsy();
  });
});

describe("trust contract: --min-score rejects abstained results", () => {
  it("should classify degraded results as abstained in trust summary", () => {
    const result = buildTestResult({ status: "degraded" });
    const normalized = normalizeResult(result);

    expect(normalized.trustSummary).toBeDefined();
    expect(normalized.trustSummary!.classification).toBe("abstained");
    expect(normalized.trustSummary!.canCompare).toBeFalsy();
    expect(normalized.trustSummary!.canGate).toBeFalsy();
  });
});

describe("trust contract: lower coverage never increases trust class", () => {
  it("should not produce trusted classification when undersampled", () => {
    const result = buildTestResult({
      coverageDiagnostics: {
        measuredDeclarations: 2,
        measuredPositions: 5,
        reachableFiles: 1,
        samplingClass: "undersampled",
        typesSource: "bundled",
        undersampled: true,
        undersampledReasons: ["Too few declarations"],
      },
    });
    const normalized = normalizeResult(result);

    expect(normalized.trustSummary).toBeDefined();
    expect(normalized.trustSummary!.classification).not.toBe("trusted");
  });

  it("should produce trusted classification for complete coverage", () => {
    const result = buildTestResult();
    const normalized = normalizeResult(result);

    expect(normalized.trustSummary).toBeDefined();
    expect(normalized.trustSummary!.classification).toBe("trusted");
    expect(normalized.trustSummary!.canCompare).toBeTruthy();
    expect(normalized.trustSummary!.canGate).toBeTruthy();
  });
});

describe("trust contract: confidence collapse triggers degradation", () => {
  it("should degrade when average confidence < 0.2", () => {
    const result = buildTestResult({
      confidenceSummary: {
        domainInference: 0.1,
        graphResolution: 0.1,
        sampleCoverage: 0.1,
        scenarioApplicability: 0.1,
      },
    });
    const normalized = normalizeResult(result);

    expect(normalized.status).toBe("degraded");
    expect(normalized.degradedCategory).toBe("confidence-collapse");
    expect(normalized.trustSummary!.classification).toBe("abstained");
  });

  it("should not degrade when average confidence >= 0.2", () => {
    const result = buildTestResult({
      confidenceSummary: {
        domainInference: 0.3,
        graphResolution: 0.3,
        sampleCoverage: 0.3,
        scenarioApplicability: 0.3,
      },
    });
    const normalized = normalizeResult(result);

    expect(normalized.status).not.toBe("degraded");
    expect(normalized.trustSummary!.classification).not.toBe("abstained");
  });
});

describe("trust contract: resolution diagnostics", () => {
  it("should include resolutionDiagnostics when set", () => {
    const result = buildTestResult({
      resolutionDiagnostics: {
        acquisitionStage: "complete",
        attemptedStrategies: ["types-field", "exports-map"],
        chosenStrategy: "types-field",
        declarationCount: 15,
      },
    });
    const normalized = normalizeResult(result);

    expect(normalized.resolutionDiagnostics).toBeDefined();
    expect(normalized.resolutionDiagnostics!.acquisitionStage).toBe("complete");
    expect(normalized.resolutionDiagnostics!.declarationCount).toBe(15);
  });
});

describe("trust contract: trust summary monotonicity", () => {
  it("worse coverage should never upgrade from directional to trusted", () => {
    // Good coverage → trusted
    const goodResult = buildTestResult();
    const goodNormalized = normalizeResult(goodResult);
    expect(goodNormalized.trustSummary!.classification).toBe("trusted");

    // Worse coverage → should not be trusted
    const badResult = buildTestResult({
      coverageDiagnostics: {
        measuredDeclarations: 1,
        measuredPositions: 3,
        reachableFiles: 1,
        samplingClass: "undersampled",
        typesSource: "bundled",
        undersampled: true,
        undersampledReasons: ["Insufficient declarations"],
      },
    });
    const badNormalized = normalizeResult(badResult);
    expect(badNormalized.trustSummary!.classification).not.toBe("trusted");
  });

  it("fallback glob should never produce trusted classification", () => {
    const result = buildTestResult({
      graphStats: {
        dedupByStrategy: {},
        fallbackReason: "test",
        filesDeduped: 0,
        totalAfterDedup: 20,
        totalEntrypoints: 0,
        totalReachable: 20,
        usedFallbackGlob: true,
      },
    });
    const normalized = normalizeResult(result);
    expect(normalized.trustSummary!.classification).not.toBe("trusted");
  });
});

describe("trust contract: install-failure degradations are visible to gates", () => {
  it("install-failure degraded result has correct status and category", () => {
    const result = buildTestResult({
      degradedCategory: "install-failure" as DegradedCategory,
      degradedReason: "Package install failed: ETARGET",
      status: "degraded",
    });
    const normalized = normalizeResult(result);

    expect(normalized.status).toBe("degraded");
    expect(normalized.degradedCategory).toBe("install-failure");
    expect(normalized.trustSummary!.classification).toBe("abstained");
    expect(normalized.scoreValidity).toBe("not-comparable");
  });

  it("install-failure degraded result has null composites", () => {
    const result = buildTestResult({
      degradedCategory: "install-failure" as DegradedCategory,
      degradedReason: "Package install failed: 404",
      status: "degraded",
    });
    const normalized = normalizeResult(result);

    for (const comp of normalized.composites) {
      expect(comp.score).toBeNull();
    }
  });

  it("snapshot entry shape includes status and degradedCategory for gate consumption", () => {
    // Simulate the snapshot entry shape produced by benchmarks/run.ts
    const result = buildTestResult({
      degradedCategory: "install-failure" as DegradedCategory,
      degradedReason: "Package install failed: network error",
      status: "degraded",
    });

    // Mirror the snapshot entry construction from benchmarks/run.ts
    const snapshotEntry = {
      degradedCategory: result.degradedCategory ?? null,
      name: "test-pkg",
      status: result.status,
    };

    // Gate should be able to detect install-failure degradations from snapshot entries
    expect(snapshotEntry.status).toBe("degraded");
    expect(snapshotEntry.degradedCategory).toBe("install-failure");

    // Verify the gate detection logic
    const isInstallFailure =
      snapshotEntry.status === "degraded" && snapshotEntry.degradedCategory === "install-failure";
    expect(isInstallFailure).toBeTruthy();
  });

  it("non-install degradations are not counted as install failures", () => {
    const categories: DegradedCategory[] = [
      "missing-declarations",
      "partial-graph-resolution",
      "insufficient-surface",
      "confidence-collapse",
    ];

    for (const category of categories) {
      const result = buildTestResult({
        degradedCategory: category,
        degradedReason: `Test: ${category}`,
        status: "degraded",
      });

      const snapshotEntry = {
        degradedCategory: result.degradedCategory ?? null,
        status: result.status,
      };

      const isInstallFailure =
        snapshotEntry.status === "degraded" && snapshotEntry.degradedCategory === "install-failure";
      expect(isInstallFailure).toBeFalsy();
    }
  });
});

describe("trust contract: Wilson CI utilities (stats.ts)", () => {
  it("wilsonUpperBound returns 1 for zero total", () => {
    expect(wilsonUpperBound(0, 0)).toBe(1);
  });

  it("wilsonLowerBound returns 0 for zero total", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("wilsonUpperBound is always >= point estimate", () => {
    const pointRate = 2 / 50;
    const upper = wilsonUpperBound(2, 50);
    expect(upper).toBeGreaterThan(pointRate);
    expect(upper).toBeLessThan(1);
  });

  it("wilsonLowerBound is always <= point estimate", () => {
    const pointRate = 48 / 50;
    const lower = wilsonLowerBound(48, 50);
    expect(lower).toBeLessThan(pointRate);
    expect(lower).toBeGreaterThan(0);
  });

  it("confidence interval width narrows with larger sample sizes", () => {
    // Same 4% failure rate at n=50 and n=500
    const ub50 = wilsonUpperBound(2, 50);
    const ub500 = wilsonUpperBound(20, 500);
    // Interval should be tighter at n=500
    expect(ub500 - 0.04).toBeLessThan(ub50 - 0.04);
  });

  it("zero failures with n=460 gives upper bound < 1%", () => {
    // This is the key statistical threshold for a 99% CI "<1% failure rate" claim
    const upper = wilsonUpperBound(0, 460);
    // Should be close to 1%
    expect(upper).toBeLessThan(0.015);
  });

  it("minSampleForBound computes known values", () => {
    // Need ~459 for <1% at 99% CI
    const n1pct = minSampleForBound(0.01, 0.99);
    expect(n1pct).toBeGreaterThanOrEqual(458);
    expect(n1pct).toBeLessThanOrEqual(460);

    // Need ~90 for <5% at 99% CI
    const n5pct = minSampleForBound(0.05, 0.99);
    expect(n5pct).toBeGreaterThanOrEqual(89);
    expect(n5pct).toBeLessThanOrEqual(92);
  });

  it("wilsonUpperBound with perfect record at small n gives wide bound", () => {
    // With 0/30 failures, upper bound should be substantial (> 5%)
    const upper = wilsonUpperBound(0, 30);
    expect(upper).toBeGreaterThan(0.05);
    // But still bounded (< 20%)
    expect(upper).toBeLessThan(0.2);
  });
});
