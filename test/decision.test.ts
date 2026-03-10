import type {
  AnalysisResult,
  ComparisonDecisionReport,
  CompositeScore,
  TrustSummary,
} from "../src/types.js";

function makeComposite(key: string, score: number | null): CompositeScore {
  let grade: CompositeScore["grade"] = "C";
  if (score !== null && score >= 80) {
    grade = "A";
  } else if (score !== null && score >= 60) {
    grade = "B";
  }

  return {
    confidence: score === null ? 0 : 0.8,
    grade,
    key: key as CompositeScore["key"],
    rationale: [],
    score,
  };
}

function makeTrust(classification: TrustSummary["classification"]): TrustSummary {
  return {
    canCompare: classification === "trusted" || classification === "directional",
    canGate: classification === "trusted",
    classification,
    reasons: classification === "abstained" ? ["Analysis degraded"] : [],
  };
}

function makeResult(opts: {
  composites: [number | null, number | null, number | null];
  trust?: TrustSummary["classification"];
  scoreValidity?: AnalysisResult["scoreValidity"];
  status?: AnalysisResult["status"];
  undersampled?: boolean;
}): AnalysisResult {
  const composites = [
    makeComposite("consumerApi", opts.composites[0]),
    makeComposite("agentReadiness", opts.composites[1]),
    makeComposite("typeSafety", opts.composites[2]),
  ];
  const trust = makeTrust(opts.trust ?? "trusted");

  return {
    analysisSchemaVersion: "0.15.0",
    caveats: [],
    composites,
    confidenceSummary: {
      domainInference: 0.8,
      graphResolution: 0.9,
      sampleCoverage: 0.85,
      scenarioApplicability: 0.5,
    },
    coverageDiagnostics: {
      measuredDeclarations: 50,
      measuredPositions: 200,
      reachableFiles: 20,
      samplingClass: opts.undersampled ? "undersampled" : "complete",
      typesSource: "bundled",
      undersampled: opts.undersampled ?? false,
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
    filesAnalyzed: 20,
    globalScores: {
      agentReadiness: composites[1]!,
      consumerApi: composites[0]!,
      typeSafety: composites[2]!,
    },
    graphStats: {
      dedupByStrategy: {},
      filesDeduped: 0,
      totalAfterDedup: 20,
      totalEntrypoints: 1,
      totalReachable: 20,
    },
    mode: "package",
    packageIdentity: {
      displayName: "test",
      entrypointStrategy: "exports-map",
      resolvedSpec: "test",
      resolvedVersion: "1.0.0",
      typesSource: "bundled",
    },
    profileInfo: { profile: "package", profileConfidence: 0.9, profileReasons: [] },
    projectName: "test",
    scoreComparability: "global",
    scoreProfile: "published-declarations",
    scoreValidity: opts.scoreValidity ?? "fully-comparable",
    status: opts.status ?? "complete",
    timeMs: 100,
    topIssues: [],
    trustSummary: trust,
  };
}

describe("comparison decision", () => {
  it("comparePackages is exported as a function", async () => {
    const { comparePackages } = await import("../src/compare.js");
    expect(comparePackages).toBeTypeOf("function");
  });

  it("decision report has expected shape", () => {
    const report: ComparisonDecisionReport = {
      blockingReasons: [],
      decisionConfidence: 0.85,
      decisionScoreA: 82,
      decisionScoreB: 65,
      metricDeltas: [
        { delta: 17, metric: "typeSafety", significant: true, valueA: 92, valueB: 75 },
      ],
      metricProvenance: [],
      outcome: "clear-winner",
      topReasons: ["Type Safety: pkgA leads by 17 points"],
      winner: "pkgA",
    };
    expect(report.outcome).toBe("clear-winner");
    expect(report.winner).toBe("pkgA");
    expect(report.decisionConfidence).toBeGreaterThan(0.5);
    expect(report.metricDeltas[0]!.significant).toBeTruthy();
  });

  it("equivalent scenario when all scores are close", () => {
    const resultA = makeResult({ composites: [75, 72, 78] });
    const resultB = makeResult({ composites: [74, 73, 77] });

    // All deltas < 5, so equivalent
    for (const key of ["consumerApi", "agentReadiness", "typeSafety"]) {
      const scoreA = resultA.composites.find((cc) => cc.key === key)?.score ?? 0;
      const scoreB = resultB.composites.find((cc) => cc.key === key)?.score ?? 0;
      expect(Math.abs(scoreA - scoreB)).toBeLessThan(5);
    }
  });

  it("abstained when result is degraded", () => {
    const degraded = makeResult({
      composites: [null, null, null],
      status: "degraded",
      trust: "abstained",
    });
    expect(degraded.trustSummary!.classification).toBe("abstained");
    expect(degraded.trustSummary!.canCompare).toBeFalsy();
  });

  it("incomparable when scoreValidity is not-comparable", () => {
    const notComparable = makeResult({
      composites: [80, 75, 85],
      scoreValidity: "not-comparable",
      trust: "directional",
    });
    expect(notComparable.scoreValidity).toBe("not-comparable");
  });

  it("wide gap indicates clear winner", () => {
    const highResult = makeResult({ composites: [90, 85, 92] });
    const lowResult = makeResult({ composites: [55, 50, 48] });

    const keys = ["consumerApi", "agentReadiness", "typeSafety"];
    let significantCount = 0;
    for (const key of keys) {
      const va = highResult.composites.find((cc) => cc.key === key)?.score ?? 0;
      const vb = lowResult.composites.find((cc) => cc.key === key)?.score ?? 0;
      if (Math.abs(va - vb) >= 5) {
        significantCount++;
      }
    }
    expect(significantCount).toBeGreaterThanOrEqual(2);
  });
});
