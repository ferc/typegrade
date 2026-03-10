import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type BoundarySummary,
  type CompositeScore,
  type ConfidenceSummary,
  type CoverageDiagnostics,
  type DimensionResult,
  type EvidenceSummary,
  type GlobalScores,
  type Grade,
  type Issue,
  type PackageIdentity,
  type ProfileInfo,
} from "../src/types.js";
import type { GraphStats } from "../src/graph/types.js";
import { buildAgentReport } from "../src/agent/report.js";
import { computeBoundaryHotspots } from "../src/boundaries/policy.js";
import { filterIssues } from "../src/origin/filter.js";
import { normalizeResult } from "../src/analyzer.js";

function makeComposite(
  key: "consumerApi" | "agentReadiness" | "typeSafety",
  score: number | null,
): CompositeScore {
  return {
    grade: (score === null ? "N/A" : "B") as Grade,
    key,
    rationale: [],
    score,
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

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    column: 1,
    dimension: "apiSafety",
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

// --- Step 1: Signal hygiene as single source of truth ---

describe("signal hygiene: topIssues filtering", () => {
  it("generated dist issues are excluded from topIssues by default", () => {
    const issues = [
      makeIssue({ file: "dist/index.d.ts", fileOrigin: "dist", line: 1 }),
      makeIssue({ file: "src/main.ts", fileOrigin: "source", line: 5, severity: "error" }),
    ];
    const result = filterIssues(issues, { budget: 10, includeGenerated: false });
    expect(result.actionable).toHaveLength(1);
    expect(result.actionable[0]!.file).toBe("src/main.ts");
  });

  it("noiseSummary counts excluded generated issues correctly", () => {
    const issues = [
      makeIssue({ file: "dist/a.d.ts", fileOrigin: "dist" }),
      makeIssue({ file: "dist/b.d.ts", fileOrigin: "dist" }),
      makeIssue({ file: "src/main.ts", fileOrigin: "source" }),
    ];
    const result = filterIssues(issues, { includeGenerated: false });
    expect(result.noiseSummary.generatedIssueCount).toBe(2);
    expect(result.noiseSummary.suppressedGeneratedCount).toBe(2);
    expect(result.noiseSummary.sourceOwnedIssueCount).toBe(1);
  });

  it("--include-generated restores generated findings", () => {
    const issues = [
      makeIssue({ file: "dist/a.d.ts", fileOrigin: "dist" }),
      makeIssue({ file: "src/main.ts", fileOrigin: "source" }),
    ];
    const result = filterIssues(issues, { includeGenerated: true });
    expect(result.actionable).toHaveLength(2);
    expect(result.noiseSummary.suppressedGeneratedCount).toBe(0);
  });
});

// --- Step 3: Compare abstains when degraded or not comparable ---

describe("comparison engine: decision quality", () => {
  it("compare abstains when a result is degraded", () => {
    const resultA = buildTestResult({ status: "degraded" });
    const normalized = normalizeResult(resultA);

    // The trust should be abstained
    expect(normalized.trustSummary?.classification).toBe("abstained");
  });
});

// --- Step 4: Boundary hotspots ---

describe("boundary hotspots", () => {
  it("hotspots are emitted and sorted by descending risk", () => {
    const summary: BoundarySummary = {
      boundaryCoverage: 0.5,
      inventory: [
        {
          boundaryType: "network",
          description: "fetch call",
          file: "api.ts",
          hasValidation: false,
          line: 10,
          trustLevel: "untrusted-external",
        },
        {
          boundaryType: "env",
          description: "env read",
          file: "config.ts",
          hasValidation: false,
          line: 20,
          trustLevel: "trusted-local",
        },
        {
          boundaryType: "filesystem",
          description: "file read",
          file: "io.ts",
          hasValidation: true,
          line: 30,
          trustLevel: "trusted-local",
        },
      ],
      missingValidationHotspots: [],
      taintBreaks: [],
      totalBoundaries: 3,
      trustedLocalSuppressions: [],
      unvalidatedBoundaries: 2,
      validatedBoundaries: 1,
    };

    const hotspots = computeBoundaryHotspots(summary);
    expect(hotspots).toHaveLength(2);
    // Network + untrusted-external should have highest risk
    expect(hotspots[0]!.boundaryType).toBe("network");
    expect(hotspots[0]!.riskScore).toBeGreaterThan(hotspots[1]!.riskScore);
    // Sorted descending
    for (let ii = 1; ii < hotspots.length; ii++) {
      expect(hotspots[ii - 1]!.riskScore).toBeGreaterThanOrEqual(hotspots[ii]!.riskScore);
    }
  });
});

// --- Step 5: Agent contract ---

describe("agent contract: execution-ready", () => {
  it("agent reports contain nextBestBatch, abortSignals, and enriched batch fields", () => {
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
        makeIssue({
          confidence: 0.8,
          file: "src/a.ts",
          fixability: "direct",
          line: 20,
          ownership: "source-owned",
          severity: "warning",
          suggestedFixKind: "add-type-annotation",
        }),
      ],
    });
    const result = buildTestResult({
      analysisScope: "self",
      dimensions: [dim],
    });
    const report = buildAgentReport(result);

    // Has abort signals
    expect(report.abortSignals).toBeDefined();
    expect(report.abortSignals.length).toBeGreaterThan(0);

    // Has enriched batches with new fields
    expect(report.enrichedBatches.length).toBeGreaterThan(0);
    const batch = report.enrichedBatches[0]!;
    expect(batch.goal).toBeDefined();
    expect(batch.whyNow).toBeDefined();
    expect(batch.patchHints).toBeDefined();
    expect(batch.patchHints.length).toBeGreaterThan(0);
    expect(batch.acceptanceChecks).toBeDefined();
    expect(batch.acceptanceChecks.length).toBeGreaterThan(0);
    expect(batch.abortIf).toBeDefined();
    expect(batch.abortIf.length).toBeGreaterThan(0);
    expect(batch.rollbackPlan).toBeDefined();
  });

  it("nextBestBatch never selects a high-risk batch automatically", () => {
    const dim = makeDimension({
      issues: [
        makeIssue({
          confidence: 0.9,
          file: "src/a.ts",
          fixability: "direct",
          ownership: "source-owned",
          severity: "error",
          suggestedFixKind: "strengthen-generic",
        }),
      ],
    });
    const result = buildTestResult({
      analysisScope: "self",
      dimensions: [dim],
    });
    const report = buildAgentReport(result);

    // All batches with strengthen-generic are high-risk (public API change)
    // Never auto-selects high-risk, so nextBestBatch should be undefined
    expect(report.nextBestBatch).toBeUndefined();
  });

  it("degraded analysis produces abortSignals", () => {
    const result = buildTestResult({ status: "degraded" });
    const report = buildAgentReport(result);

    expect(report.abortSignals).toBeDefined();
    expect(report.abortSignals.length).toBeGreaterThan(0);
    expect(report.abstentionReason).toBeDefined();
  });
});

// --- Schema version ---

describe("schema version", () => {
  it("current schema version is 0.12.0", () => {
    expect(ANALYSIS_SCHEMA_VERSION).toBe("0.14.0");
  });
});
