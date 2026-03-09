import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type CompositeScore,
  type ConfidenceSummary,
  type CoverageDiagnostics,
  type EvidenceSummary,
  type GlobalScores,
  type Grade,
  type PackageIdentity,
  type ProfileInfo,
} from "../src/types.js";
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
