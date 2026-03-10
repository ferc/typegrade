import type {
  AnalysisResult,
  CompositeScore,
  DimensionResult,
  ExecutionDiagnostics,
  Issue,
  TrustSummary,
} from "../src/types.js";
import { enrichFixBatches, groupFixBatches } from "../src/agent/fix-batch.js";
import { analyzeProject } from "../src/analyzer.js";
import { buildFixPlan } from "../src/fix/planner.js";
import { computeDecisionReport } from "../src/compare.js";

// --- Helpers ---

function makeComposite(key: string, score: number | null, conf?: number): CompositeScore {
  let grade: CompositeScore["grade"] = "C";
  if (score !== null && score >= 80) {
    grade = "A";
  } else if (score !== null && score >= 60) {
    grade = "B";
  }

  return {
    confidence: conf ?? (score === null ? 0 : 0.8),
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
  compositeConfidence?: number;
  trust?: TrustSummary["classification"];
  scoreValidity?: AnalysisResult["scoreValidity"];
  status?: AnalysisResult["status"];
  domain?: string;
  domainConfidence?: number;
  scenarioEvidence?: number;
  domainEvidence?: number;
  samplingClass?: AnalysisResult["coverageDiagnostics"]["samplingClass"];
  measuredDeclarations?: number;
  measuredPositions?: number;
  dimensions?: DimensionResult[];
  degradedCategory?: AnalysisResult["degradedCategory"];
}): AnalysisResult {
  const cc = opts.compositeConfidence;
  const composites = [
    makeComposite("consumerApi", opts.composites[0], cc),
    makeComposite("agentReadiness", opts.composites[1], cc),
    makeComposite("typeSafety", opts.composites[2], cc),
  ];
  const trust = makeTrust(opts.trust ?? "trusted");

  const domainInference = opts.domain
    ? {
        adjustedWeights: {} as Record<string, number>,
        confidence: opts.domainConfidence ?? 0.8,
        domain: opts.domain,
        matchingSignals: [] as string[],
        signals: [] as string[],
        suppressedDimensions: [] as string[],
      }
    : undefined;

  return {
    analysisSchemaVersion: "0.15.0",
    caveats: [],
    composites,
    confidenceSummary: {
      domainInference: opts.domainConfidence ?? 0.8,
      graphResolution: 0.9,
      sampleCoverage: 0.85,
      scenarioApplicability: 0.5,
    },
    coverageDiagnostics: {
      measuredDeclarations: opts.measuredDeclarations ?? 50,
      measuredPositions: opts.measuredPositions ?? 200,
      reachableFiles: 20,
      samplingClass: opts.samplingClass ?? "complete",
      typesSource: "bundled",
      undersampled: false,
      undersampledReasons: [],
    },
    dedupStats: { filesRemoved: 0, groups: 0 },
    degradedCategory: opts.degradedCategory,
    dimensions: opts.dimensions ?? [],
    domainInference,
    evidenceSummary: {
      coreSurfaceCoverage: 0.8,
      domainEvidence: opts.domainEvidence ?? 0.7,
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

function makeIssue(overrides: Partial<Issue> & { file: string; message: string }): Issue {
  return {
    column: 1,
    confidence: 0.9,
    dimension: overrides.dimension ?? "Type Safety",
    file: overrides.file,
    fixability: overrides.fixability ?? "direct",
    line: overrides.line ?? 1,
    message: overrides.message,
    ownership: overrides.ownership ?? "source-owned",
    severity: overrides.severity ?? "warning",
    ...overrides,
  };
}

// --- WS1: Trust and Comparability ---

describe("ws1: trust and comparability", () => {
  it("source fallback produces directional trust in comparison", () => {
    // Domain must be set so evidence quality crosses MIN_EVIDENCE_QUALITY threshold
    const resultA = makeResult({
      composites: [75, 70, 80],
      domain: "general",
      scoreValidity: "partially-comparable",
      trust: "directional",
    });
    const resultB = makeResult({ composites: [80, 75, 85], domain: "general" });

    const decision = computeDecisionReport({
      forceCrossDomain: false,
      nameA: "fallback-pkg",
      nameB: "good-pkg",
      resultA,
      resultB,
    });

    // One side directional means comparabilityStatus should be directional-only
    expect(decision.comparabilityStatus).toBe("directional-only");
  });

  it("low composite confidence prevents trusted comparison", () => {
    // Composites with confidence < 0.5 should yield directional trust
    const resultA = makeResult({
      compositeConfidence: 0.3,
      composites: [75, 70, 80],
      trust: "directional",
    });
    const resultB = makeResult({
      compositeConfidence: 0.3,
      composites: [80, 75, 85],
      trust: "directional",
    });

    const decision = computeDecisionReport({
      forceCrossDomain: false,
      nameA: "low-conf-a",
      nameB: "low-conf-b",
      resultA,
      resultB,
    });

    // Both directional should cause abstention
    expect(decision.outcome).toBe("abstained");
    expect(decision.abstentionKind).toBe("both-directional");
  });

  it("resource-exhaustion is a valid degraded category", () => {
    const result = makeResult({
      composites: [null, null, null],
      degradedCategory: "resource-exhaustion",
      status: "degraded",
      trust: "abstained",
    });

    expect(result.degradedCategory).toBe("resource-exhaustion");
    expect(result.status).toBe("degraded");
  });

  it("executionDiagnostics has expected shape", () => {
    const diag: ExecutionDiagnostics = {
      analysisPath: "standard",
      fallbacksApplied: ["graph-fallback-glob"],
      phaseTimings: {
        declEmit: 50,
        dimensions: 150,
        projectLoad: 100,
        scoring: 30,
        surface: 200,
      },
      resourceWarnings: [
        { kind: "declaration-emit-fallback", message: "Fell back to source emit" },
      ],
    };

    expect(diag.phaseTimings).toBeDefined();
    expect(diag.resourceWarnings).toBeDefined();
    expect(diag.analysisPath).toBe("standard");
    expect(diag.fallbacksApplied).toStrictEqual(["graph-fallback-glob"]);
    expect(Object.keys(diag.phaseTimings)).toContain("projectLoad");
    expect(Object.keys(diag.phaseTimings)).toContain("declEmit");
    expect(Object.keys(diag.phaseTimings)).toContain("surface");
    expect(Object.keys(diag.phaseTimings)).toContain("dimensions");
    expect(Object.keys(diag.phaseTimings)).toContain("scoring");
    expect(Array.isArray(diag.resourceWarnings)).toBeTruthy();
  });
});

// --- WS2: Evidence Quality ---

describe("ws2: evidence quality", () => {
  it("compact library not over-penalized", () => {
    // Compact library with sufficient surface should not be abstained
    const resultA = makeResult({
      composites: [80, 75, 85],
      domainEvidence: 0,
      measuredDeclarations: 10,
      measuredPositions: 30,
      samplingClass: "compact-complete",
      scenarioEvidence: 0,
    });
    const resultB = makeResult({ composites: [75, 70, 80] });

    const decision = computeDecisionReport({
      forceCrossDomain: false,
      nameA: "compact-pkg",
      nameB: "normal-pkg",
      resultA,
      resultB,
    });

    // Should not abstain — compact libraries with sufficient surface get adaptive weighting
    expect(decision.outcome).not.toBe("abstained");
  });

  it("evidence quality fields present on decision report", () => {
    const resultA = makeResult({ composites: [80, 75, 85] });
    const resultB = makeResult({ composites: [75, 70, 80] });

    const decision = computeDecisionReport({
      forceCrossDomain: false,
      nameA: "pkg-a",
      nameB: "pkg-b",
      resultA,
      resultB,
    });

    expect(decision.evidenceQualityA).toBeDefined();
    expect(decision.evidenceQualityA).toBeGreaterThanOrEqual(0);
    expect(decision.evidenceQualityB).toBeDefined();
    expect(decision.evidenceQualityB).toBeGreaterThanOrEqual(0);
  });
});

// --- WS3: Boundary Issues ---

describe("ws3: boundary issues", () => {
  it("boundary issues have dimensionkey and issueid pattern", () => {
    const issue = makeIssue({
      dimension: "Boundary Discipline",
      dimensionKey: "boundaryDiscipline",
      file: "src/api.ts",
      issueId: "boundaryDiscipline:src/api.ts:10:1",
      line: 10,
      message: "Unvalidated network input",
    });

    expect(issue.dimensionKey).toBe("boundaryDiscipline");
    expect(issue.issueId).toMatch(/^boundaryDiscipline:/);
  });

  it("boundary issues flow into fix batches", () => {
    const issues: Issue[] = [
      makeIssue({
        dimension: "Boundary Discipline",
        file: "src/handler.ts",
        line: 5,
        message: "Unvalidated HTTP input",
        severity: "warning",
        suggestedFixKind: "add-validation",
      }),
      makeIssue({
        dimension: "Boundary Discipline",
        file: "src/handler.ts",
        line: 15,
        message: "Missing JSON.parse validation",
        severity: "warning",
        suggestedFixKind: "wrap-json-parse",
      }),
    ];

    const batches = groupFixBatches(issues);

    expect(batches.length).toBeGreaterThan(0);
    // Both issues are in the same file + dimension, so they should be in one batch
    expect(batches[0]!.issueIds).toHaveLength(2);
    expect(batches[0]!.title).toContain("Boundary Discipline");
  });
});

// --- WS4: Agent Output ---

describe("ws4: agent output", () => {
  it("enriched fix batches have agentinstructions", () => {
    const issues: Issue[] = [
      makeIssue({
        dimension: "Type Safety",
        file: "src/utils.ts",
        line: 10,
        message: "any type in return position",
        severity: "error",
        suggestedFixKind: "replace-any",
      }),
    ];

    const batches = groupFixBatches(issues);
    const enriched = enrichFixBatches(batches, issues);

    expect(enriched.length).toBeGreaterThan(0);
    for (const batch of enriched) {
      expect(batch.agentInstructions).toBeDefined();
      expect(batch.agentInstructions.length).toBeGreaterThan(0);
      expect(Array.isArray(batch.rollbackFiles)).toBeTruthy();
      expect(batch.rollbackHint).toBeDefined();
      expect(batch.rollbackHint.length).toBeGreaterThan(0);
    }
  });

  it("fix plan batches have agentinstructions", () => {
    const dim: DimensionResult = {
      applicability: "applicable",
      applicabilityReasons: [],
      confidence: 0.9,
      enabled: true,
      issues: [
        makeIssue({
          dimension: "Type Safety",
          file: "src/index.ts",
          fileOrigin: "source",
          fixability: "direct",
          line: 5,
          message: "any type usage",
          ownership: "source-owned",
          severity: "warning",
          suggestedFixKind: "replace-any",
        }),
      ],
      key: "anyLeakage",
      label: "Type Safety",
      metrics: {},
      negatives: [],
      positives: [],
      score: 70,
      weights: { typeSafety: 0.4 },
    };

    const result = makeResult({
      composites: [80, 75, 70],
      dimensions: [dim],
    });

    const plan = buildFixPlan(result);

    expect(plan.batches.length).toBeGreaterThan(0);
    for (const batch of plan.batches) {
      expect(batch.agentInstructions).toBeDefined();
      expect(batch.agentInstructions!.length).toBeGreaterThan(0);
    }
  });
});

// --- WS5: Execution Diagnostics ---

describe("ws5: execution diagnostics", () => {
  it("executiondiagnostics always present on source analysis", () => {
    // Use a source-mode fixture (high-precision has .ts files)
    const result = analyzeProject("test/fixtures/high-precision");

    expect(result.executionDiagnostics).toBeDefined();
    const diag = result.executionDiagnostics!;

    // Phase timings should contain the major phases
    const phases = Object.keys(diag.phaseTimings);
    expect(phases).toContain("projectLoad");
    expect(phases).toContain("declEmit");
    expect(phases).toContain("surface");
    expect(phases).toContain("dimensions");
    expect(phases).toContain("scoring");
  });

  it("resourcewarnings is an array", () => {
    const result = analyzeProject("test/fixtures/high-precision");

    expect(result.executionDiagnostics).toBeDefined();
    expect(Array.isArray(result.executionDiagnostics!.resourceWarnings)).toBeTruthy();
  });
});

// --- WS6: Monorepo Health ---

describe("ws6: monorepo health", () => {
  it("monorepohealth not attached for non-workspace projects", () => {
    // Single-package fixtures should not produce monorepoHealth
    const result = analyzeProject("test/fixtures/high-precision");

    expect(result.monorepoHealth).toBeUndefined();
  });
});
