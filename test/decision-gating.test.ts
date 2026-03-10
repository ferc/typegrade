import type {
  AnalysisResult,
  CompositeScore,
  DomainInference,
  TrustSummary,
} from "../src/types.js";
import { computeDecisionReport } from "../src/compare.js";

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
  domain?: string;
  domainConfidence?: number;
  scenarioEvidence?: number;
}): AnalysisResult {
  const composites = [
    makeComposite("consumerApi", opts.composites[0]),
    makeComposite("agentReadiness", opts.composites[1]),
    makeComposite("typeSafety", opts.composites[2]),
  ];
  const trust = makeTrust(opts.trust ?? "trusted");
  const domainInference: DomainInference | undefined = opts.domain
    ? {
        adjustedWeights: {},
        confidence: opts.domainConfidence ?? 0.8,
        domain: opts.domain as DomainInference["domain"],
        matchingSignals: [],
        suppressedDimensions: [],
      }
    : undefined;

  return {
    analysisSchemaVersion: "0.14.0",
    caveats: [],
    composites,
    confidenceSummary: {
      domainInference: opts.domainConfidence ?? 0.8,
      graphResolution: 0.9,
      sampleCoverage: 0.85,
      scenarioApplicability: 0.5,
    },
    coverageDiagnostics: {
      measuredDeclarations: 50,
      measuredPositions: 200,
      reachableFiles: 20,
      samplingClass: "complete",
      typesSource: "bundled",
      undersampled: false,
      undersampledReasons: [],
    },
    dedupStats: { filesRemoved: 0, groups: 0 },
    dimensions: [],
    domainInference,
    evidenceSummary: {
      coreSurfaceCoverage: 0.8,
      domainEvidence: 0.7,
      exportCoverage: 0.9,
      scenarioEvidence: opts.scenarioEvidence ?? 0.5,
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

describe("phase 1: trust and relevance gating", () => {
  describe("domain mismatch abstention", () => {
    it("abstains when domains differ and neither is general/utility", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "validation" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "router" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "zod",
        nameB: "express",
        resultA,
        resultB,
      });

      expect(decision.outcome).toBe("abstained");
      expect(decision.abstentionKind).toBe("domain-mismatch");
      expect(decision.winner).toBeNull();
      expect(decision.blockingReasons[0]).toContain("Domain mismatch");
      expect(decision.blockingReasons[0]).toContain("--force-cross-domain");
    });

    it("allows comparison when one side is general domain", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "general" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "router" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "lodash",
        nameB: "express",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
      expect(decision.abstentionKind).toBeUndefined();
    });

    it("allows comparison when one side is utility domain", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "utility" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "orm" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "lodash",
        nameB: "prisma",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
    });

    it("allows cross-domain comparison when forced", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "validation" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "router" });

      const decision = computeDecisionReport({
        forceCrossDomain: true,
        nameA: "zod",
        nameB: "express",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
      expect(decision.comparabilityStatus).toBe("cross-domain-forced");
    });

    it("allows comparison when domains match", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "validation" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "validation" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "zod",
        nameB: "yup",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
      expect(decision.comparabilityStatus).toBe("fully-comparable");
    });

    it("allows comparison when domains are unknown", () => {
      const resultA = makeResult({ composites: [85, 80, 90] });
      const resultB = makeResult({ composites: [80, 75, 85] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
    });
  });

  describe("both-directional abstention", () => {
    it("abstains when both results are only directional", () => {
      const resultA = makeResult({ composites: [75, 70, 80], trust: "directional" });
      const resultB = makeResult({ composites: [70, 65, 75], trust: "directional" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.outcome).toBe("abstained");
      expect(decision.abstentionKind).toBe("both-directional");
      expect(decision.winner).toBeNull();
    });

    it("allows comparison when one side is trusted and other is directional with sufficient evidence", () => {
      const resultA = makeResult({
        composites: [85, 80, 90],
        domain: "validation",
        trust: "trusted",
      });
      const resultB = makeResult({
        composites: [70, 65, 75],
        domain: "validation",
        trust: "directional",
      });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.outcome).not.toBe("abstained");
      expect(decision.comparabilityStatus).toBe("directional-only");
    });
  });

  describe("low evidence abstention", () => {
    it("abstains when evidence quality is too low", () => {
      const resultA = makeResult({
        composites: [85, 80, 90],
        domainConfidence: 0.2,
        scenarioEvidence: 0.1,
        trust: "directional",
      });
      const resultB = makeResult({ composites: [80, 75, 85] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.outcome).toBe("abstained");
      expect(decision.abstentionKind).toBe("low-evidence");
    });
  });

  describe("comparability status tracking", () => {
    it("reports fully-comparable for same-domain trusted results", () => {
      const resultA = makeResult({ composites: [85, 80, 90], domain: "validation" });
      const resultB = makeResult({ composites: [80, 75, 85], domain: "validation" });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "zod",
        nameB: "yup",
        resultA,
        resultB,
      });

      expect(decision.comparabilityStatus).toBe("fully-comparable");
    });

    it("reports directional-only when one side is directional", () => {
      const resultA = makeResult({
        composites: [85, 80, 90],
        domain: "validation",
        trust: "trusted",
      });
      const resultB = makeResult({
        composites: [80, 75, 85],
        domain: "validation",
        trust: "directional",
      });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.comparabilityStatus).toBe("directional-only");
    });

    it("reports not-comparable for abstained results", () => {
      const resultA = makeResult({ composites: [null, null, null], trust: "abstained" });
      const resultB = makeResult({ composites: [80, 75, 85] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.comparabilityStatus).toBe("not-comparable");
    });
  });

  describe("clear-winner threshold tightening", () => {
    it("requires scoreDelta >= 10 and confidence >= 0.80 for clear-winner", () => {
      // With high trust, high coverage, and wide gap
      const resultA = makeResult({ composites: [95, 90, 95] });
      const resultB = makeResult({ composites: [60, 55, 55] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "strong",
        nameB: "weak",
        resultA,
        resultB,
      });

      // Scores are very far apart, should be clear-winner
      expect(decision.outcome).toBe("clear-winner");
      expect(decision.winner).toBe("strong");
    });

    it("returns equivalent when all composites are close", () => {
      const resultA = makeResult({ composites: [75, 72, 78] });
      const resultB = makeResult({ composites: [74, 73, 77] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "pkgA",
        nameB: "pkgB",
        resultA,
        resultB,
      });

      expect(decision.outcome).toBe("equivalent");
      expect(decision.winner).toBeNull();
    });
  });

  describe("degraded analysis abstention includes abstentionKind", () => {
    it("reports degraded-analysis abstentionKind", () => {
      const resultA = makeResult({
        composites: [null, null, null],
        status: "degraded",
        trust: "abstained",
      });
      const resultB = makeResult({ composites: [80, 75, 85] });

      const decision = computeDecisionReport({
        forceCrossDomain: false,
        nameA: "broken",
        nameB: "good",
        resultA,
        resultB,
      });

      expect(decision.outcome).toBe("abstained");
      expect(decision.abstentionKind).toBe("degraded-analysis");
    });
  });
});
