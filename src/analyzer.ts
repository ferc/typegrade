import {
  ANALYSIS_SCHEMA_VERSION,
  type AdoptionRiskCluster,
  type AnalysisMode,
  type AnalysisProfile,
  type AnalysisResult,
  type AnalysisStatus,
  type BoundaryHotspot,
  type BoundaryRecommendedFix,
  type ClusterCategory,
  type CompositeScore,
  type ConfidenceBottleneck,
  type ConfidenceSummary,
  type CoverageDiagnostics,
  type CoverageFailureMode,
  type DecisionGrade,
  type DeclEmitDiagnostic,
  type DimensionResult,
  type DomainKey,
  type DomainScore,
  type EvidenceSummary,
  type ExplainabilityReport,
  type FixabilityScore,
  type GlobalScores,
  type Grade,
  type ImpactClass,
  type Issue,
  type IssueCluster,
  type LibraryInspectionReport,
  type MonorepoHealthSummary,
  type PackageAnalysisContext,
  type PackageIdentity,
  type Recommendation,
  type ResourceWarning,
  type ScenarioApplicabilityStatus,
  type ScenarioScore,
  type ScoreComparability,
  type ScoreValidity,
  type SourceModeConfidence,
  type SuppressionEntry,
  type TrustSummary,
} from "./types.js";
import { DIMENSION_CONFIGS, DOMAIN_FIT_ADJUSTMENTS } from "./constants.js";
import { type DomainType, detectDomain } from "./domain.js";
import {
  type GetSourceFilesOptions,
  getSourceFiles,
  loadProject,
  loadProjectLightweight,
} from "./utils/project-loader.js";
import { basename, join, resolve } from "node:path";
import { buildAgentReport, buildAutofixSummary } from "./agent/index.js";
import {
  buildBoundaryGraph,
  buildBoundarySummary,
  computeBoundaryQuality,
} from "./boundaries/index.js";
import { buildDerivedIndex, extractPublicSurface } from "./surface/index.js";
import { classifyPublicSurface, computeRoleBreakdown } from "./roles/index.js";
import { computeComposites, computeGrade } from "./scorer.js";
import { detectProfile, gatherProfileSignals, resolveProfile } from "./profiles/index.js";
import { evaluateScenarioPack, isScenarioApplicable } from "./scenarios/types.js";
import { existsSync, readFileSync } from "node:fs";
import type { GraphStats } from "./graph/types.js";
import { Project } from "ts-morph";
import { analyzeAgentUsability } from "./analyzers/agent-usability.js";
import { analyzeApiSafety } from "./analyzers/api-safety.js";
import { analyzeApiSpecificity } from "./analyzers/api-specificity.js";
import { analyzeBoundaryDiscipline } from "./analyzers/boundary-discipline.js";
import { analyzeConfigDiscipline } from "./analyzers/config-discipline.js";
import { analyzeDeclarationFidelity } from "./analyzers/declaration-fidelity.js";
import { analyzeImplementationSoundness } from "./analyzers/implementation-soundness.js";
import { analyzeMonorepo } from "./monorepo/index.js";
import { analyzePublishQuality } from "./analyzers/publish-quality.js";
import { analyzeSemanticLift } from "./analyzers/semantic-lift.js";
import { analyzeSpecializationPower } from "./analyzers/specialization-power.js";
import { analyzeSurfaceComplexity } from "./analyzers/surface-complexity.js";
import { analyzeSurfaceConsistency } from "./analyzers/surface-consistency.js";
import { applySuppressions } from "./suppression/index.js";
import { classifyFileOrigin } from "./origin/classifier.js";
import { computeBoundaryHotspots } from "./boundaries/policy.js";
import { filterIssues } from "./origin/filter.js";
import { getScenarioPackWithVariant } from "./scenarios/index.js";
import { resolveFileOwnership } from "./ownership/index.js";

/** Minimum domain confidence to emit domainFitScore */
const DOMAIN_CONFIDENCE_THRESHOLD = 0.7;
/** Minimum domain confidence to emit a directional domainFitScore */
const DOMAIN_DIRECTIONAL_CONFIDENCE_THRESHOLD = 0.5;
/** Minimum gap between winner and runner-up for domain emission */
const DOMAIN_AMBIGUITY_GAP = 0.15;
/** Minimum ambiguity gap to emit a directional domainFitScore */
const DOMAIN_DIRECTIONAL_AMBIGUITY_GAP = 0.08;
/** Minimum domain confidence to run scenario packs */
const SCENARIO_CONFIDENCE_THRESHOLD = 0.7;
/** Minimum domain confidence to run a directional scenario pack */
const SCENARIO_DIRECTIONAL_CONFIDENCE_THRESHOLD = 0.5;
/** Confidence cap when graph resolution used fallback glob */
const FALLBACK_CONFIDENCE_CAP = 0.55;
/** Maximum composite score allowed for undersampled packages */
const UNDERSAMPLE_SCORE_CAP = 65;
/** TypeSafety cap when anyDensity exceeds moderate threshold */
const ANY_LEAKAGE_MODERATE_CAP = 60;
/** TypeSafety cap when anyDensity exceeds severe threshold */
const ANY_LEAKAGE_SEVERE_CAP = 45;
/** AnyDensity threshold for moderate any leakage */
const ANY_LEAKAGE_MODERATE_THRESHOLD = 0.3;
/** AnyDensity threshold for severe any leakage */
const ANY_LEAKAGE_SEVERE_THRESHOLD = 0.5;
/** FalsePositiveRisk threshold above which domain score is suppressed */
const DOMAIN_FALSE_POSITIVE_THRESHOLD = 0.5;

/** Minimum reachable files to consider a package adequately sampled */
const MIN_REACHABLE_FILES = 3;
/** Minimum measured positions to consider a package adequately sampled */
const MIN_MEASURED_POSITIONS = 10;
/** Minimum declarations to consider a package adequately sampled */
const MIN_MEASURED_DECLARATIONS = 5;
/** Minimum measured positions to keep an undersampled package directional */
const MIN_DIRECTIONAL_MEASURED_POSITIONS = 4;
/** Minimum measured declarations to keep an undersampled package directional */
const MIN_DIRECTIONAL_MEASURED_DECLARATIONS = 2;

function makeDefaultGraphStats(): GraphStats {
  return {
    dedupByStrategy: {},
    filesDeduped: 0,
    totalAfterDedup: 0,
    totalEntrypoints: 0,
    totalReachable: 0,
    usedFallbackGlob: false,
  };
}

/**
 * Normalize an AnalysisResult to ensure all mandatory fields are present
 * and degraded results never masquerade as normal scores.
 *
 * This is the final pass applied to every result before it leaves the pipeline.
 * It enforces the following invariants:
 *
 * 1. Degraded results never emit comparable scores, domain/scenario data, or fix batches
 * 2. All mandatory schema fields are present with safe defaults
 * 3. Low-confidence results have domain/scenario suppressed
 * 4. PackageIdentity always has typesSource and entrypointStrategy
 */
export function normalizeResult(result: AnalysisResult): AnalysisResult {
  // Ensure schema version
  result.analysisSchemaVersion = result.analysisSchemaVersion || ANALYSIS_SCHEMA_VERSION;

  // --- Degraded-result enforcement (WS1) ---
  if (result.status === "degraded") {
    result.scoreValidity = "not-comparable";

    // Null out all composite scores (never 0 masquerading as a real score)
    for (const comp of result.composites) {
      if (comp.score === 0 || comp.score !== null) {
        comp.score = null;
        comp.grade = "N/A";
        comp.confidence = 0;
        comp.compositeConfidenceReasons = [
          ...(comp.compositeConfidenceReasons ?? []),
          "Degraded analysis — scores are not comparable",
        ];
      }
    }

    // Rebuild globalScores to reflect nulled composites
    result.globalScores = buildGlobalScores(result.composites);

    // Strip domain/scenario scores — degraded results must never emit these
    delete result.domainScore;
    delete result.scenarioScore;

    // Strip fix batches and autofix summary — degraded results must not guide agents
    delete result.autofixSummary;
    delete result.fixPlan;
    result.autofixAbstentionReason =
      result.autofixAbstentionReason ?? `Analysis degraded: ${result.degradedReason ?? "unknown"}`;

    // Strip boundary quality — degraded analyses lack evidence for boundary scoring
    delete result.boundaryQuality;
    delete result.boundarySummary;

    // Ensure degradedCategory is always set
    result.degradedCategory = result.degradedCategory ?? "insufficient-surface";

    // Build degraded reason chain
    const chain: string[] = [];
    if (result.degradedReason) {
      chain.push(result.degradedReason);
    }
    if (result.degradedCategory) {
      chain.push(`Category: ${result.degradedCategory}`);
    }
    if (result.coverageDiagnostics?.coverageFailureMode) {
      chain.push(`Failure mode: ${result.coverageDiagnostics.coverageFailureMode}`);
    }
    if (chain.length > 0) {
      result.degradedReasonChain = chain;
    }

    // Ensure scoreComparability reflects degraded state
    result.scoreComparability = "global";
  }

  // --- Mandatory field defaults (WS3: Schema consistency) ---

  // Ensure profileInfo
  if (!result.profileInfo) {
    result.profileInfo = {
      profile: result.mode === "package" ? "package" : "library",
      profileConfidence: 0,
      profileReasons: ["Default profile — not explicitly detected"],
    };
  }

  // Ensure packageIdentity with mandatory sub-fields
  if (result.packageIdentity) {
    // Backfill mandatory sub-fields if missing
    result.packageIdentity.typesSource = result.packageIdentity.typesSource ?? "unknown";
    result.packageIdentity.entrypointStrategy =
      result.packageIdentity.entrypointStrategy ?? "unknown";
  } else {
    result.packageIdentity = {
      displayName: result.projectName,
      entrypointStrategy: "unknown",
      resolvedSpec: result.projectName,
      resolvedVersion: null,
      typesSource: "unknown",
    };
  }

  // Ensure evidenceSummary
  if (!result.evidenceSummary) {
    result.evidenceSummary = {
      coreSurfaceCoverage: 0,
      domainEvidence: 0,
      exportCoverage: 0,
      scenarioEvidence: 0,
      specializationEvidence: 0,
    };
  }

  // Ensure confidenceSummary
  if (!result.confidenceSummary) {
    result.confidenceSummary = {
      domainInference: 0,
      graphResolution: 0,
      sampleCoverage: 0,
      scenarioApplicability: 0,
    };
  }

  // Ensure coverageDiagnostics
  if (!result.coverageDiagnostics) {
    result.coverageDiagnostics = {
      measuredDeclarations: 0,
      measuredPositions: 0,
      reachableFiles: result.filesAnalyzed,
      samplingClass: result.filesAnalyzed > 0 ? "complete" : "undersampled",
      typesSource: result.packageIdentity.typesSource ?? "unknown",
      undersampled: result.filesAnalyzed === 0,
      undersampledReasons:
        result.filesAnalyzed === 0 ? ["No files analyzed — no coverage data"] : [],
    };
  }

  // --- Confidence gating (WS5 + WS7) ---
  if (result.status === "complete" && result.confidenceSummary) {
    const cs = result.confidenceSummary;
    const avgConfidence =
      (cs.graphResolution + cs.domainInference + cs.sampleCoverage + cs.scenarioApplicability) / 4;

    // Confidence collapse: very low average confidence degrades the entire result
    if (avgConfidence < 0.2) {
      result.status = "degraded";
      result.scoreValidity = "not-comparable";
      result.degradedCategory = "confidence-collapse";
      result.degradedReason = `Overall confidence collapsed (${Math.round(avgConfidence * 100)}%)`;
      // Re-run degraded enforcement
      for (const comp of result.composites) {
        comp.score = null;
        comp.grade = "N/A";
        comp.confidence = 0;
      }
      result.globalScores = buildGlobalScores(result.composites);
      delete result.domainScore;
      delete result.scenarioScore;
      delete result.autofixSummary;
      delete result.fixPlan;
      result.autofixAbstentionReason = `Confidence collapse (${Math.round(avgConfidence * 100)}%)`;
    } else {
      // Very low confidence: downgrade scoreValidity
      if (avgConfidence < 0.3 && result.scoreValidity === "fully-comparable") {
        result.scoreValidity = "partially-comparable";
      }

      // Low confidence: suppress domain and scenario scores
      if (avgConfidence < 0.5) {
        if (result.domainScore) {
          result.caveats = result.caveats ?? [];
          result.caveats.push(
            `Domain score suppressed: overall confidence too low (${Math.round(avgConfidence * 100)}%)`,
          );
          delete result.domainScore;
        }
        if (result.scenarioScore) {
          result.caveats = result.caveats ?? [];
          result.caveats.push(
            `Scenario score suppressed: overall confidence too low (${Math.round(avgConfidence * 100)}%)`,
          );
          delete result.scenarioScore;
        }
      }

      // Low confidence: suppress fix batches
      if (avgConfidence < 0.4 && result.autofixSummary) {
        const hadBatches = result.autofixSummary.fixBatches.length > 0;
        if (hadBatches) {
          result.autofixSummary.fixBatches = [];
          result.autofixAbstentionReason = `Overall confidence too low for fix batches (${Math.round(avgConfidence * 100)}%)`;
        }
      }

      // WS4: Stricter source-mode confidence gating — source/self with low
      // Confidence cannot claim fully-comparable validity
      if (
        (result.analysisScope === "source" || result.analysisScope === "self") &&
        avgConfidence < 0.4 &&
        result.scoreValidity === "fully-comparable"
      ) {
        result.scoreValidity = "partially-comparable";
        result.caveats = result.caveats ?? [];
        result.caveats.push(
          `Source-mode confidence too low for full comparability (${Math.round(avgConfidence * 100)}%)`,
        );
      }
    }
  }

  // --- Trust summary computation ---
  result.trustSummary = computeTrustSummary(result);

  // --- WS8: Decision grade and comparability reasons ---
  result.decisionGrade = computeDecisionGrade(result);
  result.comparabilityReasons = buildComparabilityReasons(result);

  // --- Stable issue IDs and dimension keys (mandatory in output) ---
  enrichDimensionKeys(result.dimensions);
  assignStableIssueIds(result);

  return result;
}

/**
 * Assign deterministic, stable issue IDs and dimension keys to all issues in the result.
 * ID format: dimension:file:line:col — stable across runs on the same codebase.
 * Both issueId and dimensionKey are mandatory in normalized output.
 */
function assignStableIssueIds(result: AnalysisResult): void {
  // Assign IDs and dimensionKeys to dimension issues
  for (const dim of result.dimensions) {
    for (const issue of dim.issues) {
      if (!issue.issueId) {
        issue.issueId = computeIssueId(issue);
      }
      if (!issue.dimensionKey) {
        issue.dimensionKey = LABEL_TO_KEY.get(issue.dimension) ?? dim.key;
      }
    }
  }
  // Assign IDs and dimensionKeys to topIssues
  for (const issue of result.topIssues) {
    if (!issue.issueId) {
      issue.issueId = computeIssueId(issue);
    }
    if (!issue.dimensionKey) {
      issue.dimensionKey = LABEL_TO_KEY.get(issue.dimension) ?? "unknown";
    }
  }
  // Assign IDs to autofix issues
  if (result.autofixSummary) {
    for (const issue of result.autofixSummary.actionableIssues) {
      if (!issue.issueId) {
        issue.issueId = computeIssueId(issue);
      }
      if (!issue.dimensionKey) {
        issue.dimensionKey = LABEL_TO_KEY.get(issue.dimension) ?? "unknown";
      }
    }
  }
}

/**
 * Compute the trust summary for an analysis result.
 * Classification:
 * - abstained: status is degraded or invalid-input or unsupported-package
 * - directional: fallback-glob, undersampled, partially-comparable, or low confidence
 * - trusted: complete analysis with sufficient coverage and comparable scores
 */
function computeTrustSummary(result: AnalysisResult): TrustSummary {
  const reasons: string[] = [];

  // Abstained: no usable result
  if (
    result.status === "degraded" ||
    result.status === "invalid-input" ||
    result.status === "unsupported-package"
  ) {
    reasons.push(`Analysis status: ${result.status}`);
    if (result.degradedReason) {
      reasons.push(result.degradedReason);
    }
    return { canCompare: false, canGate: false, classification: "abstained", reasons };
  }

  // Check for directional signals
  const isDirectional: boolean =
    result.scoreValidity === "not-comparable" ||
    result.scoreValidity === "partially-comparable" ||
    result.packageIdentity.entrypointStrategy === "fallback-glob" ||
    result.coverageDiagnostics.undersampled ||
    result.graphStats.usedFallbackGlob;

  if (isDirectional) {
    if (
      result.packageIdentity.entrypointStrategy === "fallback-glob" ||
      result.graphStats.usedFallbackGlob
    ) {
      reasons.push("Fallback glob resolution — scores are directional only");
    }
    if (result.coverageDiagnostics.undersampled) {
      reasons.push("Undersampled coverage — insufficient evidence for trusted classification");
    }
    if (result.scoreValidity === "not-comparable") {
      reasons.push("Score validity: not-comparable");
    } else if (result.scoreValidity === "partially-comparable") {
      reasons.push("Score validity: partially-comparable (reduced confidence)");
    }
    return {
      canCompare: result.scoreValidity !== "not-comparable",
      canGate: false,
      classification: "directional",
      reasons,
    };
  }

  // Check composite confidence: if any global composite has confidence < 0.5,
  // Downgrade to directional (fully-comparable but low-confidence is misleading)
  const lowConfComposites = result.composites.filter(
    (cc) => cc.score !== null && cc.confidence !== undefined && cc.confidence < 0.5,
  );
  if (lowConfComposites.length > 0) {
    const lowKeys = lowConfComposites.map((cc) => cc.key).join(", ");
    reasons.push(`Low composite confidence (${lowKeys}) — directional only`);
    return {
      canCompare: true,
      canGate: false,
      classification: "directional",
      reasons,
    };
  }

  // Trusted: complete with strong evidence
  reasons.push("Complete analysis with sufficient coverage");
  return { canCompare: true, canGate: true, classification: "trusted", reasons };
}

/** Average of the four confidence summary dimensions */
function computeAvgConfidence(cs: ConfidenceSummary): number {
  return (
    (cs.graphResolution + cs.domainInference + cs.sampleCoverage + cs.scenarioApplicability) / 4
  );
}

/**
 * Compute decision grade — how strong the analysis evidence is for
 * decision-making. Layered on top of trust classification to give
 * consumers a single "can I act on this?" signal.
 *
 * - strong: full evidence, suitable for gating and comparison
 * - directional: usable for guidance but not decision-grade
 * - abstain: no usable evidence — do not act on this result
 */
function computeDecisionGrade(result: AnalysisResult): DecisionGrade {
  // Abstain: no usable evidence
  if (
    result.status === "degraded" ||
    result.status === "invalid-input" ||
    result.status === "unsupported-package"
  ) {
    return "abstain";
  }
  if (result.scoreValidity === "not-comparable") {
    return "abstain";
  }

  const trust = result.trustSummary?.classification;
  if (trust === "abstained") {
    return "abstain";
  }

  // Directional: usable but not decision-grade
  if (trust === "directional") {
    return "directional";
  }
  if (result.scoreValidity === "partially-comparable") {
    return "directional";
  }
  if (result.graphStats.usedFallbackGlob) {
    return "directional";
  }

  // Source mode with low confidence is directional
  if (
    (result.analysisScope === "source" || result.analysisScope === "self") &&
    result.confidenceSummary
  ) {
    const avgConf = computeAvgConfidence(result.confidenceSummary);
    if (avgConf < 0.6) {
      return "directional";
    }
  }

  return "strong";
}

/**
 * Build human-readable reasons explaining why this result is or is not
 * comparable to other results. Consumers can display these in UI or logs.
 */
function buildComparabilityReasons(result: AnalysisResult): string[] {
  const reasons: string[] = [];

  if (result.status === "degraded") {
    reasons.push(`Analysis degraded: ${result.degradedReason ?? "unknown"}`);
    return reasons;
  }
  if (result.status === "invalid-input") {
    reasons.push("Invalid input — analysis could not run");
    return reasons;
  }
  if (result.status === "unsupported-package") {
    reasons.push("Unsupported package layout");
    return reasons;
  }

  if (result.graphStats.usedFallbackGlob) {
    reasons.push("Graph resolution used fallback glob");
  }
  if (result.coverageDiagnostics.undersampled) {
    reasons.push("Undersampled coverage");
  }
  if (result.executionDiagnostics?.analysisPath === "source-fallback") {
    reasons.push("Source-mode declaration emit fallback");
  }

  if (reasons.length === 0) {
    reasons.push("Complete analysis with sufficient evidence");
  }

  return reasons;
}

function computeIssueId(issue: {
  dimension: string;
  file: string;
  line: number;
  column: number;
}): string {
  // Use relative-looking path (strip common prefixes) for stability
  const shortFile = issue.file.replace(/.*node_modules\//, "").replace(/.*\/src\//, "src/");
  return `${issue.dimension}:${shortFile}:${issue.line}:${issue.column}`;
}

/**
 * Detect undersampling — packages where we have too little data
 * to produce a reliable score.
 *
 * Also tracks cross-package type refs as a coverage-quality signal
 * and splits undersampling reasons by types source category.
 */
function computeCoverageDiagnostics(opts: {
  graphStats: GraphStats;
  surfacePositions: number;
  surfaceDeclarations: number;
  typesSource: "bundled" | "@types" | "mixed" | "unknown";
  mode: AnalysisMode;
  hasPackageContext?: boolean;
}): CoverageDiagnostics {
  const { graphStats, surfacePositions, surfaceDeclarations, typesSource, mode } = opts;
  const reasons: string[] = [];

  // Graph-based undersampling checks only apply when real graph stats are available —
  // Source mode and package mode without packageContext use dummy graph stats (WS6)
  const hasRealGraphStats = mode === "package" && opts.hasPackageContext === true;

  if (
    hasRealGraphStats &&
    graphStats.totalReachable < MIN_REACHABLE_FILES &&
    !graphStats.usedFallbackGlob
  ) {
    let sourceLabel = "";
    if (typesSource === "@types") {
      sourceLabel = " (@types package)";
    } else if (typesSource === "mixed") {
      sourceLabel = " (mixed source)";
    }
    reasons.push(
      `Only ${graphStats.totalReachable} reachable file(s) from entrypoints (minimum: ${MIN_REACHABLE_FILES})${sourceLabel}`,
    );
  }
  if (surfacePositions < MIN_MEASURED_POSITIONS) {
    reasons.push(
      `Only ${surfacePositions} measured type position(s) (minimum: ${MIN_MEASURED_POSITIONS})`,
    );
  }
  if (surfaceDeclarations < MIN_MEASURED_DECLARATIONS) {
    reasons.push(
      `Only ${surfaceDeclarations} public declaration(s) (minimum: ${MIN_MEASURED_DECLARATIONS})`,
    );
  }
  if (hasRealGraphStats && graphStats.usedFallbackGlob) {
    reasons.push("Graph resolution used fallback glob — entrypoint traversal failed");
  }
  if (
    hasRealGraphStats &&
    graphStats.totalAfterDedup < MIN_REACHABLE_FILES &&
    graphStats.totalReachable >= MIN_REACHABLE_FILES
  ) {
    reasons.push(
      `After dedup only ${graphStats.totalAfterDedup} file(s) remain (high dedup ratio may indicate incomplete surface)`,
    );
  }

  // High cross-package type refs with few reachable files may indicate missing @types traversal
  const xrefs = graphStats.crossPackageTypeRefs ?? 0;
  if (hasRealGraphStats && xrefs > 5 && graphStats.totalReachable < 5 && typesSource === "@types") {
    reasons.push(
      `${xrefs} cross-package type references with only ${graphStats.totalReachable} reachable files — @types package may have incomplete traversal`,
    );
  }

  // Determine specific coverage failure mode
  let coverageFailureMode: CoverageFailureMode | undefined = undefined;
  if (hasRealGraphStats && graphStats.usedFallbackGlob) {
    coverageFailureMode =
      graphStats.fallbackReason === "no-entrypoints-found"
        ? "entrypoint-resolution"
        : "fallback-glob";
  } else if (
    hasRealGraphStats &&
    typesSource === "@types" &&
    xrefs > 5 &&
    graphStats.totalReachable < 5
  ) {
    coverageFailureMode = "@types-fragmentation";
  } else if (
    surfaceDeclarations < MIN_MEASURED_DECLARATIONS &&
    surfacePositions < MIN_MEASURED_POSITIONS
  ) {
    coverageFailureMode = "declaration-scarcity";
  }

  // Classify sampling quality:
  // - "complete": all thresholds met
  // - "compact": few files but sufficient positions and declarations (small-by-design library)
  // - "undersampled": genuinely insufficient coverage
  const fewFilesOnly =
    hasRealGraphStats &&
    reasons.length > 0 &&
    graphStats.totalReachable > 0 &&
    reasons.every((rr) => rr.startsWith("Only") && rr.includes("reachable file"));
  const hasSufficientSurface =
    surfacePositions >= MIN_MEASURED_POSITIONS &&
    surfaceDeclarations >= MIN_MEASURED_DECLARATIONS &&
    (!hasRealGraphStats || !graphStats.usedFallbackGlob);
  const fallbackButWellObserved =
    hasRealGraphStats &&
    graphStats.usedFallbackGlob &&
    surfacePositions >= MIN_MEASURED_POSITIONS * 2 &&
    surfaceDeclarations >= MIN_MEASURED_DECLARATIONS * 2;
  const isCompactSingleSurface =
    hasRealGraphStats &&
    !graphStats.usedFallbackGlob &&
    graphStats.totalReachable > 0 &&
    graphStats.totalReachable <= 2 &&
    surfaceDeclarations >= 1 &&
    surfaceDeclarations < MIN_MEASURED_DECLARATIONS &&
    surfacePositions >= Math.max(MIN_DIRECTIONAL_MEASURED_POSITIONS * 2, 8) &&
    coverageFailureMode !== "@types-fragmentation";

  let samplingClass:
    | "complete"
    | "compact"
    | "compact-complete"
    | "compact-partial"
    | "undersampled" = "complete";
  let compactReason: string | undefined = undefined;

  if (reasons.length === 0) {
    samplingClass = "complete";
  } else if (fallbackButWellObserved) {
    // Traversal may have failed, but the measured declaration surface is
    // Large enough to keep the package directional rather than abstaining.
    samplingClass = "complete";
  } else if (fewFilesOnly && hasSufficientSurface) {
    // Distinguish compact-complete (enough surface for accurate scoring) from compact-partial
    const isFullySufficient =
      surfacePositions >= MIN_MEASURED_POSITIONS * 2 &&
      surfaceDeclarations >= MIN_MEASURED_DECLARATIONS * 2;
    samplingClass = isFullySufficient ? "compact-complete" : "compact-partial";
    compactReason = `${graphStats.totalReachable} file(s) but ${surfacePositions} positions and ${surfaceDeclarations} declarations — small-by-design library`;
  } else if (isCompactSingleSurface) {
    samplingClass = "compact-partial";
    compactReason = `${graphStats.totalReachable} file(s) and ${surfaceDeclarations} declaration(s), but ${surfacePositions} positions — compact single-surface library`;
  } else {
    samplingClass = "undersampled";
  }

  const undersampled = samplingClass === "undersampled";

  const result: CoverageDiagnostics = {
    coveragePenaltyApplied: undersampled,
    crossPackageTypeRefs: xrefs,
    measuredDeclarations: surfaceDeclarations,
    measuredPositions: surfacePositions,
    reachableFiles: graphStats.totalReachable,
    samplingClass,
    typesSource,
    undersampled,
    undersampledReasons: reasons,
  };

  if (compactReason) {
    result.compactReason = compactReason;
  }

  if (coverageFailureMode) {
    result.coverageFailureMode = coverageFailureMode;
  }

  return result;
}

/**
 * Some package surfaces are small by design: they have too little data to be
 * fully comparable, but enough coherent evidence to remain directional instead
 * of fully degraded. This keeps off-corpus tiny packages from collapsing into
 * abstentions while still capping confidence and comparability.
 */
function canKeepUndersampledPackageDirectional(
  diagnostics: CoverageDiagnostics,
  graphStats: GraphStats,
): boolean {
  if (!diagnostics.undersampled) {
    return false;
  }
  if (graphStats.usedFallbackGlob) {
    return false;
  }
  if (
    diagnostics.measuredDeclarations < MIN_DIRECTIONAL_MEASURED_DECLARATIONS ||
    diagnostics.measuredPositions < MIN_DIRECTIONAL_MEASURED_POSITIONS
  ) {
    const tinySingleSurface =
      diagnostics.reachableFiles <= 1 &&
      diagnostics.measuredDeclarations >= 1 &&
      diagnostics.measuredPositions >= 1 &&
      diagnostics.coverageFailureMode !== "@types-fragmentation";
    const denseSingleDeclaration =
      diagnostics.measuredDeclarations === 1 &&
      diagnostics.measuredPositions >= Math.max(MIN_DIRECTIONAL_MEASURED_POSITIONS * 2, 8) &&
      diagnostics.reachableFiles <= 2;
    if (!denseSingleDeclaration && !tinySingleSurface) {
      return false;
    }
  }

  // Fragmented @types packages need a little more evidence before they can be
  // Treated as directional rather than degraded.
  if (diagnostics.coverageFailureMode === "@types-fragmentation") {
    return diagnostics.measuredDeclarations >= 4 && diagnostics.measuredPositions >= 8;
  }

  return true;
}

// --- Declaration Emit Diagnostic Guidance ---

const EMIT_DIAGNOSTIC_GUIDANCE: Record<number, string> = {
  2742: "Inferred type from external module — add an explicit return type annotation",
  4023: "Exported variable has or is using name from external module — add explicit type annotation",
  4025: "Exported variable has or is using private name — re-export the referenced type or add explicit annotation",
  4055: "Return type of public method from exported class has or is using private name",
  4058: "Return type of exported function has or is using name from private module — re-export the type or annotate explicitly",
  4060: "Default export from private module — re-export explicitly from a public entrypoint",
  4078: "Parameter has or is using private name — make the referenced type public or annotate explicitly",
  4082: "Default export of the module has or is using private name",
};

/** Map a ts-morph DiagnosticCategory integer to a string */
function mapDiagnosticCategory(cat: number): "error" | "warning" | "suggestion" | "message" {
  // Ts-morph: 0=Warning, 1=Error, 2=Suggestion, 3=Message
  switch (cat) {
    case 1: {
      return "error";
    }
    case 0: {
      return "warning";
    }
    case 2: {
      return "suggestion";
    }
    default: {
      return "message";
    }
  }
}

/** Capture top 10 emit diagnostics with actionable guidance */
function captureDeclEmitDiagnostics(
  diagnostics: ReturnType<ReturnType<typeof Project.prototype.emitToMemory>["getDiagnostics"]>,
): DeclEmitDiagnostic[] {
  const result: DeclEmitDiagnostic[] = [];
  const seen = new Set<string>();

  for (const diag of diagnostics) {
    if (result.length >= 10) {
      break;
    }
    const code = diag.getCode();
    const file = diag.getSourceFile()?.getFilePath() ?? "<unknown>";
    const rawMsg = diag.getMessageText();
    const message =
      typeof rawMsg === "string" ? rawMsg.slice(0, 200) : String(rawMsg).slice(0, 200);
    const dedup = `${code}:${file}`;
    if (seen.has(dedup)) {
      continue;
    }
    seen.add(dedup);
    const category = mapDiagnosticCategory(diag.getCategory());
    const guidance = EMIT_DIAGNOSTIC_GUIDANCE[code];
    result.push({ category, code, file, guidance, message });
  }

  return result;
}

// --- Confidence Bottleneck Computation ---

const BOTTLENECK_HINTS: Record<string, string> = {
  agentUsability:
    "Add JSDoc on public APIs, use branded/narrowed return types, and reduce overload ambiguity",
  apiSafety:
    "Replace any/unknown in public API signatures with concrete types; narrow union returns",
  apiSpecificity:
    "Add explicit return types and narrow parameter types instead of broad unions or generics",
  boundaryDiscipline:
    "Add runtime validation at I/O boundaries (HTTP, env, config, filesystem reads)",
  configDiscipline:
    "Type configuration objects explicitly instead of using Record<string, unknown>",
  declarationFidelity:
    "Ensure .d.ts files accurately reflect source types — check for manual declaration drift",
  errorHandling:
    "Use typed error classes or Result<T,E> patterns instead of throwing untyped errors",
  genericConstraints:
    "Add type parameter constraints (extends clauses) to generic functions and classes",
  overloadPrecision: "Provide overload signatures that narrow return types based on input patterns",
  semanticLift:
    "Use conditional types, mapped types, or template literal types to encode domain semantics",
  specializationPower:
    "Add generic type parameters, conditional types, mapped types, or infer keywords",
  unsoundness: "Remove type assertions (as), non-null assertions (!), and unsafe casts",
};

function computeConfidenceBottlenecks(dimensions: DimensionResult[]): ConfidenceBottleneck[] {
  const bottlenecks: ConfidenceBottleneck[] = [];

  for (const dim of dimensions) {
    if (!dim.enabled || dim.confidence === undefined || dim.confidence >= 0.5) {
      continue;
    }
    const signals = dim.confidenceSignals ?? [];
    let explanation = `Low sample coverage for ${dim.label}`;
    if (signals.length > 0) {
      explanation = signals.map((ss) => ss.reason).join("; ");
    } else if (dim.applicability === "not_applicable") {
      explanation = `${dim.label} is not applicable to this codebase`;
    } else if (dim.applicability === "insufficient_evidence") {
      explanation = `Insufficient evidence to measure ${dim.label}`;
    }
    const improvementHint =
      BOTTLENECK_HINTS[dim.key] ?? `Increase type coverage and annotation quality for ${dim.label}`;
    bottlenecks.push({
      confidence: dim.confidence,
      dimensionKey: dim.key,
      dimensionLabel: dim.label,
      explanation,
      improvementHint,
    });
  }

  bottlenecks.sort((aa, bb) => aa.confidence - bb.confidence);
  return bottlenecks.slice(0, 5);
}

export interface AnalyzeOptions {
  sourceFilesOptions?: GetSourceFilesOptions;
  mode?: AnalysisMode;
  packageContext?: PackageAnalysisContext;
  /** If provided, only analyze files in this set (post-graph filtering) */
  fileFilter?: Set<string>;
  /** If true, generate explainability report */
  explain?: boolean;
  /** Force domain inference to a specific domain (auto = auto-detect, off = disable) */
  domain?: "auto" | "off" | DomainType;
  /** Explicit analysis profile override (auto-detected if omitted) */
  profile?: AnalysisProfile;
  /** If true, generate agent-oriented output with fix batches */
  agent?: boolean;
  /** Skip declaration emit — use source files as consumer view (suitable for fix-plan) */
  skipDeclEmit?: boolean;
  /** Skip boundary analysis (source mode only) */
  skipBoundaries?: boolean;
  /** Include generated/dist/vendor issues in ranked findings */
  includeGenerated?: boolean;
  /** Include indirectly fixable issues */
  includeIndirect?: boolean;
  /** Maximum actionable issues to include */
  budget?: number;
}

/**
 * Analyze a local TypeScript project for type precision quality.
 *
 * @example
 * ```ts
 * import { analyzeProject } from "typegrade";
 * const result = analyzeProject("./my-project");
 * console.log(result.composites); // consumerApi, agentReadiness, typeSafety
 * ```
 */
export function analyzeProject(projectPath: string, options?: AnalyzeOptions): AnalysisResult {
  const startTime = performance.now();
  const absolutePath = resolve(projectPath);
  const projectName = basename(absolutePath);
  const sourceFilesOptions = options?.sourceFilesOptions;
  const isPackageMode = options?.mode === "package" || sourceFilesOptions?.includeDts === true;
  const mode: AnalysisMode = isPackageMode ? "package" : "source";

  const graphStats = options?.packageContext?.graphStats ?? makeDefaultGraphStats();
  const { usedFallbackGlob } = graphStats;
  const phaseTimings: Record<string, number> = {};

  const projectLoadStart = performance.now();
  const project = loadProject(absolutePath);
  let sourceFiles = getSourceFiles(project, sourceFilesOptions, absolutePath);
  if (options?.fileFilter) {
    sourceFiles = sourceFiles.filter((sf) => options.fileFilter!.has(sf.getFilePath()));
  }
  const filesAnalyzed = sourceFiles.length;

  // No source files -> degraded result
  if (filesAnalyzed === 0) {
    const timeMs = Math.round(performance.now() - startTime);
    const emptyComposites: CompositeScore[] = [
      {
        confidence: 0,
        grade: "N/A",
        key: "agentReadiness",
        rationale: ["No files found"],
        score: null,
      },
      {
        confidence: 0,
        grade: "N/A",
        key: "consumerApi",
        rationale: ["No files found"],
        score: null,
      },
      {
        confidence: 0,
        grade: "N/A",
        key: "typeSafety",
        rationale: ["No files found"],
        score: null,
      },
      {
        confidence: 0,
        grade: "N/A",
        key: "implementationQuality",
        rationale: ["No files found"],
        score: null,
      },
    ];
    return normalizeResult({
      analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
      caveats: [],
      composites: emptyComposites,
      confidenceSummary: {
        domainInference: 0,
        graphResolution: 0,
        sampleCoverage: 0,
        scenarioApplicability: 0,
      },
      coverageDiagnostics: {
        measuredDeclarations: 0,
        measuredPositions: 0,
        reachableFiles: 0,
        samplingClass: "undersampled" as const,
        typesSource: (options?.packageContext?.typesSource ?? "unknown") as
          | "bundled"
          | "@types"
          | "mixed"
          | "unknown",
        undersampled: true,
        undersampledReasons: ["No source files found to analyze"],
      },
      dedupStats: { filesRemoved: 0, groups: 0 },
      degradedCategory: "missing-declarations",
      degradedReason: "No source files found to analyze",
      dimensions: [],
      evidenceSummary: {
        coreSurfaceCoverage: 0,
        domainEvidence: 0,
        exportCoverage: 0,
        scenarioEvidence: 0,
        specializationEvidence: 0,
      },
      filesAnalyzed: 0,
      globalScores: buildGlobalScores(emptyComposites),
      graphStats,
      mode,
      packageIdentity: {
        displayName: projectName,
        entrypointStrategy: "unknown",
        resolvedSpec: absolutePath,
        resolvedVersion: null,
        typesSource: (options?.packageContext?.typesSource ?? "unknown") as
          | "bundled"
          | "@types"
          | "mixed"
          | "unknown",
      },
      profileInfo: {
        profile: isPackageMode ? "package" : "library",
        profileConfidence: 0,
        profileReasons: ["No files analyzed"],
      },
      projectName,
      scoreComparability: "global",
      scoreProfile: isPackageMode ? "published-declarations" : "source-project",
      scoreValidity: "not-comparable",
      status: "degraded",
      timeMs,
      topIssues: [
        {
          column: 0,
          dimension: "General",
          file: absolutePath,
          line: 0,
          message: "No source files found to analyze",
          severity: "error",
        },
      ],
    });
  }

  phaseTimings["projectLoad"] = Math.round(performance.now() - projectLoadStart);

  // Build consumer view
  let consumerFiles = sourceFiles;
  const sourceOnlyFiles = sourceFiles;
  const caveats: string[] = [];
  let usingSourceFallback = false;
  /** Declaration emit success rate: 1.0=full, 0<x<1=partial, 0=failed/skipped */
  let declEmitSuccessRate = 0;
  const resourceWarnings: ResourceWarning[] = [];
  let declEmitDiagnostics: DeclEmitDiagnostic[] | undefined = undefined;
  const declEmitStart = performance.now();

  if (mode === "source" && !options?.skipDeclEmit) {
    try {
      const emitResult = project.emitToMemory({ emitOnlyDtsFiles: true });
      const emittedFiles = emitResult.getFiles();
      const diagnostics = emitResult.getDiagnostics();

      const emitDiagnosticCount = diagnostics.length;
      if (emitDiagnosticCount > 0) {
        caveats.push(`Declaration emit produced ${emitDiagnosticCount} diagnostic(s)`);
        declEmitDiagnostics = captureDeclEmitDiagnostics(diagnostics);
      }

      if (emittedFiles.length > 0) {
        declEmitSuccessRate = emittedFiles.length / sourceFiles.length;
        const dtsProject = new Project({
          compilerOptions: { module: 99, skipLibCheck: true, strict: true, target: 2 },
          useInMemoryFileSystem: true,
        });
        for (const file of emittedFiles) {
          dtsProject.createSourceFile(file.filePath, file.text);
        }
        consumerFiles = dtsProject.getSourceFiles();
        if (declEmitSuccessRate < 1) {
          caveats.push(
            `Partial declaration emit: ${emittedFiles.length}/${sourceFiles.length} files (${Math.round(declEmitSuccessRate * 100)}%)`,
          );
          resourceWarnings.push({
            kind: "partial-emit",
            message: `Only ${emittedFiles.length}/${sourceFiles.length} files emitted declarations`,
          });
        }
      } else {
        usingSourceFallback = true;
        declEmitSuccessRate = 0;
        caveats.push("Could not emit declarations; consumer analysis uses source files directly");
        resourceWarnings.push({
          kind: "declaration-emit-fallback",
          message: "Declaration emit produced no files; using source files as consumer view",
        });
      }
    } catch {
      usingSourceFallback = true;
      declEmitSuccessRate = 0;
      caveats.push("Declaration emit failed; consumer analysis uses source files directly");
      resourceWarnings.push({
        kind: "declaration-emit-fallback",
        message: "Declaration emit threw an error; using source files as consumer view",
      });
    }
  } else if (mode === "source" && options?.skipDeclEmit) {
    usingSourceFallback = true;
    declEmitSuccessRate = 0;
  }

  phaseTimings["declEmit"] = Math.round(performance.now() - declEmitStart);

  // Extract public surface once, shared by all consumer-facing analyzers
  const surfaceStart = performance.now();
  const consumerSurface = extractPublicSurface(consumerFiles);

  // Build derived index once — precomputed aggregates for all analyzers
  const derivedIndex = buildDerivedIndex(consumerSurface);

  // Classify export roles and compute centrality weights
  const centralityWeights = classifyPublicSurface(consumerSurface);

  // Domain detection
  const domainOpt = options?.domain ?? "auto";
  const domainInference =
    domainOpt === "off"
      ? {
          ambiguityGap: 0,
          confidence: 0,
          domain: "general" as const,
          falsePositiveRisk: 0,
          matchedRules: [] as string[],
          runnerUpDomain: "general" as const,
          signals: [] as string[],
        }
      : detectDomain(consumerSurface, options?.packageContext?.packageName);

  phaseTimings["surface"] = Math.round(performance.now() - surfaceStart);

  // Run consumer-facing dimensions against the shared surface
  const dimensionStart = performance.now();
  const packageName = options?.packageContext?.packageName;
  const dimensions: DimensionResult[] = [
    analyzeApiSpecificity(consumerSurface),
    analyzeApiSafety(consumerSurface, packageName),
    analyzeSemanticLift(consumerSurface),
    analyzeSpecializationPower(consumerSurface),
    analyzePublishQuality(consumerSurface, project, options?.packageContext),
    analyzeSurfaceConsistency(consumerSurface),
    analyzeSurfaceComplexity(consumerSurface),
    analyzeAgentUsability(consumerSurface),
  ];

  // Pre-compute boundary coverage for the dimension scorer (source mode only)
  let boundaryDisciplineOpts:
    | { boundaryCoverage: number; totalBoundaries: number; validatedBoundaries: number }
    | undefined = undefined;
  if (mode === "source" && !options?.skipBoundaries) {
    const earlyGraph = buildBoundaryGraph(sourceOnlyFiles, project);
    const earlySummary = buildBoundarySummary(earlyGraph);
    boundaryDisciplineOpts = {
      boundaryCoverage: earlySummary.boundaryCoverage,
      totalBoundaries: earlySummary.totalBoundaries,
      validatedBoundaries: earlySummary.totalBoundaries - earlySummary.unvalidatedBoundaries,
    };
  }

  // Source-only dimensions
  if (mode === "source") {
    dimensions.push(analyzeDeclarationFidelity(sourceOnlyFiles, consumerFiles));
    dimensions.push(analyzeImplementationSoundness(sourceOnlyFiles));
    dimensions.push(analyzeBoundaryDiscipline(sourceOnlyFiles, project, boundaryDisciplineOpts));
    dimensions.push(analyzeConfigDiscipline(sourceOnlyFiles, project));
  } else {
    // Disabled dimensions for package mode
    for (const key of [
      "declarationFidelity",
      "implementationSoundness",
      "boundaryDiscipline",
      "configDiscipline",
    ]) {
      dimensions.push({
        applicability: "not_applicable",
        applicabilityReason: "Not applicable for published declarations",
        applicabilityReasons: ["Not applicable for published declarations"],
        enabled: false,
        issues: [],
        key,
        label: key
          .replaceAll(/([A-Z])/g, " $1")
          .replace(/^./, (ch) => ch.toUpperCase())
          .trim(),
        metrics: {},
        negatives: [],
        positives: [],
        score: null,
        weights: {},
      });
    }
  }

  // Normalize applicability fields: set defaults for any dimension that didn't explicitly set them
  normalizeDimensionApplicability(dimensions, consumerSurface, derivedIndex);

  // Apply confidence penalty when source-mode consumer analysis fell back to raw source files
  if (usingSourceFallback) {
    for (const dim of dimensions) {
      dim.confidence = dim.confidence === undefined ? 0.6 : Math.min(dim.confidence, 0.6);
      dim.confidenceSignals = dim.confidenceSignals ?? [];
      dim.confidenceSignals.push({
        reason: "Consumer analysis using raw source files instead of declarations",
        source: "source-fallback",
        value: 0.6,
      });
    }
  }

  // Cap confidence when graph resolution used fallback glob
  if (usedFallbackGlob) {
    for (const dim of dimensions) {
      dim.confidence =
        dim.confidence === undefined
          ? FALLBACK_CONFIDENCE_CAP
          : Math.min(dim.confidence, FALLBACK_CONFIDENCE_CAP);
      dim.confidenceSignals = dim.confidenceSignals ?? [];
      dim.confidenceSignals.push({
        reason: "Graph resolution used fallback glob — confidence capped",
        source: "fallback-glob",
        value: FALLBACK_CONFIDENCE_CAP,
      });
    }
    caveats.push("Graph resolution used fallback glob; confidence capped at 0.55");
  }

  if (mode === "source") {
    caveats.push(`Source mode: ${consumerFiles.length} consumer files analyzed`);
  }

  phaseTimings["dimensions"] = Math.round(performance.now() - dimensionStart);

  // Resolve profile early so we can pass it to the scorer
  const scoringStart = performance.now();
  const declarationFileRatio = mode === "package" ? 1 : 0;
  const profileSignals = gatherProfileSignals(absolutePath, {
    declarationFileRatio,
    isPackageMode: isPackageMode,
    sourceFileCount: filesAnalyzed,
  });
  const detectedProfile = detectProfile(profileSignals);
  const profileInfo = resolveProfile(detectedProfile, options?.profile);

  const composites = computeComposites(dimensions, mode, profileInfo.profile);

  // Build globalScores structure
  const globalScores = buildGlobalScores(composites);

  // Compute domainFitScore if domain was detected with sufficient confidence
  // Requirements: confidence >= 0.70, ambiguity gap >= 0.15, not fallback glob (unless forced)
  let domainScore: DomainScore | undefined = undefined;
  const scoreComparability: ScoreComparability = "global";
  const domainConfidenceMet =
    domainInference.domain !== "general" &&
    domainInference.confidence >= DOMAIN_CONFIDENCE_THRESHOLD &&
    (domainInference.ambiguityGap ?? 1) >= DOMAIN_AMBIGUITY_GAP &&
    domainOpt !== "off";
  const domainDirectionalConfidenceMet =
    domainInference.domain !== "general" &&
    domainInference.confidence >= DOMAIN_DIRECTIONAL_CONFIDENCE_THRESHOLD &&
    (domainInference.ambiguityGap ?? 1) >= DOMAIN_DIRECTIONAL_AMBIGUITY_GAP &&
    domainOpt !== "off";

  // Allow domain scoring even with fallback glob, but only if not auto-disabled
  if (domainConfidenceMet && !usedFallbackGlob) {
    domainScore = computeDomainScore(
      dimensions,
      domainInference.domain as DomainType,
      domainInference.confidence,
    );
  } else if (domainDirectionalConfidenceMet && !usedFallbackGlob) {
    domainScore = computeDomainScore(
      dimensions,
      domainInference.domain as DomainType,
      domainInference.confidence,
    );
    caveats.push(
      `Domain score emitted directionally (${domainInference.domain}, confidence=${domainInference.confidence.toFixed(2)})`,
    );
  }

  // Determine scenario applicability status based on domain confidence, graph quality, and ambiguity
  let scenarioApplicabilityStatus: ScenarioApplicabilityStatus = "applicable";
  const domainAmbiguityValue =
    "domainAmbiguity" in domainInference ? domainInference.domainAmbiguity : 1;
  if (!domainInference || domainInference.confidence < 0.3) {
    scenarioApplicabilityStatus = "not_applicable";
  } else if (domainInference.confidence < 0.5 || graphStats.usedFallbackGlob) {
    scenarioApplicabilityStatus = "insufficient_evidence";
  } else if (domainAmbiguityValue > 0.7) {
    scenarioApplicabilityStatus = "applicable_but_weak";
  }

  // Run scenario pack if domain was detected with sufficient confidence and no fallback glob
  let scenarioScore: ScenarioScore | undefined = undefined;
  let scenarioAbstentionReason: string | undefined = undefined;
  const scenarioApplicabilityReasons: string[] = [];
  if (scenarioApplicabilityStatus === "not_applicable") {
    scenarioAbstentionReason =
      domainOpt === "off"
        ? "Domain scoring disabled"
        : `Domain confidence too low (${domainInference.confidence.toFixed(2)}) — scenario not applicable`;
    scenarioApplicabilityReasons.push(scenarioAbstentionReason);
  } else if (!domainDirectionalConfidenceMet) {
    scenarioAbstentionReason = `Domain confidence too low (${domainInference.confidence.toFixed(2)})`;
    scenarioApplicabilityReasons.push(scenarioAbstentionReason);
  } else if (usedFallbackGlob) {
    scenarioAbstentionReason = "Graph used fallback glob — scenario evaluation skipped";
    scenarioApplicabilityReasons.push(scenarioAbstentionReason);
  } else {
    const directionalScenario =
      domainInference.confidence < SCENARIO_CONFIDENCE_THRESHOLD &&
      domainInference.confidence >= SCENARIO_DIRECTIONAL_CONFIDENCE_THRESHOLD;
    const pack = getScenarioPackWithVariant(
      domainInference.domain as DomainKey,
      consumerSurface,
      packageName,
    );
    if (pack) {
      const applicabilityCheck = isScenarioApplicable(pack, consumerSurface, packageName);
      if (applicabilityCheck.applicable) {
        scenarioScore = evaluateScenarioPack(pack, consumerSurface, packageName);
        // Attach applicability status to the scenario score
        scenarioScore.scenarioApplicability = directionalScenario
          ? "applicable_but_weak"
          : scenarioApplicabilityStatus;
        scenarioApplicabilityReasons.push(
          `Scenario pack '${pack.name}' applicable for domain '${domainInference.domain}'`,
        );
        if (directionalScenario) {
          caveats.push(
            `Scenario score emitted directionally (${domainInference.domain}, confidence=${domainInference.confidence.toFixed(2)})`,
          );
        }
      } else {
        scenarioAbstentionReason = `Scenario pack '${pack.name}' not applicable: ${applicabilityCheck.reason}`;
        scenarioApplicabilityReasons.push(scenarioAbstentionReason);
      }
    } else {
      scenarioAbstentionReason = `No scenario pack for domain '${domainInference.domain}'`;
      scenarioApplicabilityReasons.push(scenarioAbstentionReason);
    }
  }
  if (scenarioAbstentionReason && !scenarioScore) {
    caveats.push(scenarioAbstentionReason);
  }

  phaseTimings["scoring"] = Math.round(performance.now() - scoringStart);

  // Collect top issues using the shared signal-hygiene filter as single source of truth
  const allIssues: Issue[] = dimensions.flatMap((dim) => dim.issues);
  const filterOpts: { budget: number; includeGenerated: boolean; includeIndirect?: boolean } = {
    budget: options?.budget ?? 10,
    includeGenerated: options?.includeGenerated ?? false,
  };
  if (options?.includeIndirect !== undefined) {
    filterOpts.includeIndirect = options.includeIndirect;
  }
  const topIssueFilter = filterIssues(allIssues, filterOpts);
  // Fall back to severity-sorted all issues if no source issues pass the filter
  const topIssues =
    topIssueFilter.actionable.length > 0
      ? rankIssuesForReport(topIssueFilter.actionable)
      : rankIssuesForReport(allIssues).slice(0, 10);

  const timeMs = Math.round(performance.now() - startTime);

  // Compute dedup stats
  const dedupStats = {
    filesRemoved: graphStats.filesDeduped,
    groups: Object.values(graphStats.dedupByStrategy).reduce((acc, val) => acc + val, 0),
  };

  // Compute confidence summary
  const sampleCoverage = computeSampleCoverage(dimensions);
  let scenarioApplicability = 0.1;
  if (scenarioScore) {
    scenarioApplicability = 0.9;
  } else if (domainConfidenceMet) {
    scenarioApplicability = 0.5;
  }
  const confidenceSummary: ConfidenceSummary = {
    domainInference: domainInference.confidence,
    graphResolution: usedFallbackGlob ? 0.3 : 0.95,
    sampleCoverage,
    scenarioApplicability,
  };

  // Compute coverage diagnostics (use derivedIndex totals for consistency)
  const typesSource = options?.packageContext?.typesSource ?? "unknown";
  const totalPositions = Object.values(derivedIndex.roleCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const coverageDiagnostics = computeCoverageDiagnostics({
    graphStats,
    hasPackageContext: options?.packageContext !== undefined,
    mode,
    surfaceDeclarations: consumerSurface.stats.totalDeclarations,
    surfacePositions: totalPositions,
    typesSource,
  });
  if (coverageDiagnostics.undersampled) {
    caveats.push(`Package is undersampled: ${coverageDiagnostics.undersampledReasons.join("; ")}`);

    // Apply confidence penalty to all dimensions when undersampled
    const undersampleCap = computeUndersampleConfidenceCap(coverageDiagnostics);
    for (const dim of dimensions) {
      dim.confidence =
        dim.confidence === undefined ? undersampleCap : Math.min(dim.confidence, undersampleCap);
      dim.confidenceSignals = dim.confidenceSignals ?? [];
      dim.confidenceSignals.push({
        reason: `Undersampled package — confidence capped (${coverageDiagnostics.undersampledReasons.length} reason(s))`,
        source: "undersampled",
        value: undersampleCap,
      });
    }

    // Apply score cap to composites for undersampled packages.
    // This prevents inflated scores when coverage is insufficient.
    applyUndersampleScoreCap(composites);
  }

  // Enforce monotonic scoring constraints (any-leakage cap, domain suppression)
  domainScore = enforceMonotonicConstraints({
    caveats,
    composites,
    dimensions,
    domainInference,
    domainScore,
  });

  // Build evidence summary
  const evidenceSummary = buildEvidenceSummary(dimensions, domainInference, scenarioScore);

  // --- Boundary analysis (source mode only, skippable) ---
  let boundarySummary = undefined;
  let boundaryQuality = undefined;
  if (mode === "source" && !options?.skipBoundaries) {
    const boundaryGraph = buildBoundaryGraph(sourceOnlyFiles, project);
    boundarySummary = buildBoundarySummary(boundaryGraph);
    boundaryQuality = computeBoundaryQuality(boundarySummary);
  }

  // --- Ownership enrichment ---
  enrichIssueOwnership(dimensions, absolutePath);

  // --- Suppression engine ---
  let suppressions: SuppressionEntry[] = [];
  if (profileInfo.profile === "autofix-agent" || options?.agent) {
    const suppressableIssues = dimensions.flatMap((dim) => dim.issues);
    const suppressionResult = applySuppressions(
      suppressableIssues,
      profileInfo.profile === "autofix-agent" ? "autofix-agent" : profileInfo.profile,
    );
    ({ suppressions } = suppressionResult);

    // Update dimension issues with suppression info
    let issueIdx = 0;
    for (const dim of dimensions) {
      for (let jj = 0; jj < dim.issues.length; jj++) {
        const suppressed = suppressionResult.filtered[issueIdx];
        if (suppressed) {
          dim.issues[jj] = suppressed;
        }
        issueIdx++;
      }
    }
  }

  // --- Signal hygiene: noise and actionability accounting ---
  const allIssuesForNoise = dimensions.flatMap((dim) => dim.issues);
  const { noiseSummary, actionabilitySummary } = filterIssues(allIssuesForNoise);

  // --- Fixability score ---
  const fixabilityScore = computeFixabilityScore(dimensions);

  // --- Compute analysis status and score validity ---
  const isUndersampled = coverageDiagnostics.undersampled;
  const isFallbackGlob = usedFallbackGlob;
  const keepUndersampledPackageDirectional =
    mode === "package" && canKeepUndersampledPackageDirectional(coverageDiagnostics, graphStats);
  // Source mode: undersampling is informational only — don't degrade the result (WS6).
  // Source analyses always have usable scores; only package analyses degrade on insufficient coverage.
  const shouldDegradeForUndersampling =
    isUndersampled && mode === "package" && !keepUndersampledPackageDirectional;
  const analysisStatus: AnalysisStatus = shouldDegradeForUndersampling ? "degraded" : "complete";
  let scoreValidity: ScoreValidity = "fully-comparable";
  if (shouldDegradeForUndersampling) {
    scoreValidity = "not-comparable";
  } else if (isUndersampled) {
    scoreValidity = "partially-comparable";
  } else if (isFallbackGlob) {
    scoreValidity = "partially-comparable";
  } else if (usingSourceFallback && mode === "source") {
    // Source fallback: consumer analysis used raw source files instead of declarations
    scoreValidity = "partially-comparable";
  }
  const degradedReason: string | undefined = isUndersampled
    ? `Undersampled: ${coverageDiagnostics.undersampledReasons.join("; ")}`
    : undefined;
  if (keepUndersampledPackageDirectional) {
    caveats.push(
      `Undersampled package accepted as directional: ${coverageDiagnostics.undersampledReasons.join("; ")}`,
    );
  }

  // --- Build package identity ---
  const packageIdentity: PackageIdentity = options?.packageContext
    ? {
        displayName: options.packageContext.packageName,
        entrypointStrategy: "unknown",
        resolvedSpec: options.packageContext.packageRoot,
        resolvedVersion: null,
        typesSource: options.packageContext.typesSource ?? "unknown",
      }
    : {
        displayName: projectName,
        entrypointStrategy: "unknown",
        resolvedSpec: absolutePath,
        resolvedVersion: null,
        typesSource: "unknown",
      };

  // Determine analysis scope
  let analysisScope: "self" | "package" | "source" = "source";
  if (options?.profile === "autofix-agent") {
    analysisScope = "self";
  } else if (isPackageMode) {
    analysisScope = "package";
  }

  // Compute confidence bottlenecks (all confidence adjustments are final by now)
  const confidenceBottlenecks = computeConfidenceBottlenecks(dimensions);

  const result: AnalysisResult = {
    actionabilitySummary,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    analysisScope,
    caveats,
    composites,
    confidenceBottlenecks: confidenceBottlenecks.length > 0 ? confidenceBottlenecks : undefined,
    confidenceSummary,
    coverageDiagnostics,
    dedupStats,
    dimensions,
    domainInference,
    domainScore,
    evidenceSummary,
    filesAnalyzed,
    fixabilityScore,
    globalScores,
    graphStats,
    mode,
    noiseSummary,
    packageIdentity,
    profileInfo,
    projectName,
    roleBreakdown: computeRoleBreakdown(centralityWeights),
    scenarioScore,
    scoreComparability,
    scoreProfile: isPackageMode ? "published-declarations" : "source-project",
    scoreValidity,
    status: analysisStatus,
    timeMs,
    topIssues,
  };

  if (degradedReason) {
    result.degradedReason = degradedReason;
    result.degradedCategory = "insufficient-surface";
  }

  // Attach domain and scenario applicability reasons
  const domainReasons: string[] =
    "domainApplicabilityReasons" in domainInference
      ? [...(domainInference.domainApplicabilityReasons ?? [])]
      : [];
  if (!domainScore && domainReasons.length === 0) {
    // Domain score omitted — explain why
    if (domainOpt === "off") {
      domainReasons.push("Domain scoring disabled");
    } else if (domainInference.domain === "general") {
      domainReasons.push("Domain is 'general' — no domain-specific scoring");
    } else if (usedFallbackGlob) {
      domainReasons.push("Graph used fallback glob — domain scoring skipped");
    } else if (!domainConfidenceMet) {
      domainReasons.push(
        `Domain confidence ${domainInference.confidence.toFixed(2)} below threshold`,
      );
    }
  }
  if (domainReasons.length > 0) {
    result.domainApplicabilityReasons = domainReasons;
  }
  if (scenarioApplicabilityReasons.length > 0) {
    result.scenarioApplicabilityReasons = scenarioApplicabilityReasons;
  }

  // Compute source-mode confidence for source/self analyses
  if (mode === "source" || analysisScope === "self") {
    const totalIssues = dimensions.flatMap((dm) => dm.issues);
    const ownedIssues = totalIssues.filter(
      (ii) => ii.ownership === "source-owned" || ii.ownership === "workspace-owned",
    );
    const fixableIssues = totalIssues.filter((ii) => ii.fixability === "direct");
    const resolvedOwnership = totalIssues.filter(
      (ii) => ii.ownership !== undefined && ii.ownership !== "unresolved",
    );

    const smc: SourceModeConfidence = {
      declarationEmitSuccess: declEmitSuccessRate,
      fixabilityRate: totalIssues.length > 0 ? fixableIssues.length / totalIssues.length : 1,
      ownershipClarity: totalIssues.length > 0 ? resolvedOwnership.length / totalIssues.length : 1,
      sourceFileCoverage:
        filesAnalyzed > 0 ? Math.min(1, filesAnalyzed / Math.max(1, sourceOnlyFiles.length)) : 0,
      sourceOwnedExportCoverage:
        totalIssues.length > 0 ? ownedIssues.length / totalIssues.length : 1,
    };
    result.sourceModeConfidence = smc;
  }

  if (boundarySummary) {
    result.boundarySummary = boundarySummary;
    // Wire boundary hotspots and recommended fixes into the result
    const hotspots = computeBoundaryHotspots(boundarySummary);
    if (hotspots.length > 0) {
      result.boundaryHotspots = hotspots;
      result.boundaryRecommendedFixes = generateBoundaryFixes(hotspots);

      // Convert boundary hotspots into first-class issues
      const boundaryIssues = convertBoundaryHotspotsToIssues(hotspots);
      wireBoundaryIssues(result, boundaryIssues);
    }
  }
  if (boundaryQuality) {
    result.boundaryQuality = boundaryQuality;
  }
  if (suppressions.length > 0) {
    result.suppressions = suppressions;
  }

  // Wire execution diagnostics — always populate with phase timings
  const fallbacks: string[] = [];
  if (usingSourceFallback) {
    fallbacks.push("declaration-emit-fallback");
  }
  if (isFallbackGlob) {
    fallbacks.push("graph-fallback-glob");
  }
  result.executionDiagnostics = {
    analysisPath: usingSourceFallback ? "source-fallback" : "standard",
    declEmitDiagnostics: declEmitDiagnostics,
    fallbacksApplied: fallbacks,
    phaseTimings,
    resourceWarnings,
  };

  // Enrich issues with canonical dimension keys
  enrichDimensionKeys(dimensions);

  // Build issue clusters
  const issueClusters = buildIssueClusters(dimensions);
  if (issueClusters.length > 0) {
    result.issueClusters = issueClusters;
  }

  // Generate recommendations for source/workspace/self analyses
  if (mode === "source" || analysisScope === "self") {
    result.recommendations = generateRecommendations(dimensions, boundarySummary, topIssues);
  }

  // Build inspection report for package mode
  if (isPackageMode && analysisStatus === "complete") {
    result.inspectionReport = buildInspectionReport(result, issueClusters);
  }

  // Build explainability report if requested
  if (options?.explain) {
    result.explainability = buildExplainability(dimensions, domainInference);
  }

  // Build agent report if requested
  if (options?.agent || profileInfo.profile === "autofix-agent") {
    const agentReport = buildAgentReport(result);
    result.autofixSummary = buildAutofixSummary(agentReport);

    // Add abstention reason when no fix batches were emitted
    if (result.autofixSummary.fixBatches.length === 0 && !result.autofixAbstentionReason) {
      if (result.status === "degraded") {
        result.autofixAbstentionReason = `Analysis degraded: ${result.degradedReason ?? "unknown"}`;
      } else if (agentReport.actionableIssues.length === 0) {
        result.autofixAbstentionReason = "No actionable source-owned issues found";
      } else {
        const stopMet = agentReport.stopConditions.find((sc) => sc.met);
        result.autofixAbstentionReason = stopMet
          ? `Agent stop: ${stopMet.reason}`
          : "No fixable batches could be formed from actionable issues";
      }
    }
  }

  // WS6: Detect workspace root and attach monorepo health as auxiliary data
  if (mode === "source") {
    const monorepoHealth = tryAttachMonorepoHealth(absolutePath, resourceWarnings);
    if (monorepoHealth) {
      result.monorepoHealth = monorepoHealth;
    }
  }

  // Final normalization pass — enforce degraded-result invariants, mandatory fields,
  // Confidence gating, and stable issue IDs (WS3)
  return normalizeResult(result);
}

/**
 * Normalize applicability fields on all dimensions.
 * Sets defaults for dimensions that didn't explicitly set applicability,
 * and applies heuristic applicability detection for certain dimensions.
 */
function normalizeDimensionApplicability(
  dimensions: DimensionResult[],
  surface: { stats: { totalDeclarations: number } },
  derivedIndex: { genericStats: { totalTypeParams: number; constrainedCount: number } },
): void {
  for (const dim of dimensions) {
    // Already explicitly set (e.g., disabled stubs, boundary-discipline)
    if (dim.applicability) {
      continue;
    }

    // Default: applicable with empty reasons
    dim.applicability = "applicable";
    dim.applicabilityReasons = [];

    // Heuristic applicability detection per dimension
    if (dim.key === "specializationPower") {
      // No specialization axis: mark not_applicable for libraries with no generics at all
      const { totalTypeParams } = derivedIndex.genericStats;
      if (totalTypeParams === 0 && surface.stats.totalDeclarations > 0) {
        dim.applicability = "not_applicable";
        dim.applicabilityReasons = [
          "No generic type parameters in public surface — no specialization axis",
        ];
      } else if (totalTypeParams > 0 && totalTypeParams < 3) {
        dim.applicability = "insufficient_evidence";
        dim.applicabilityReasons = [
          `Only ${totalTypeParams} generic type parameter(s) — weak specialization evidence`,
        ];
      }
    }

    // Migrate legacy applicabilityReason
    if (dim.applicabilityReason && dim.applicabilityReasons.length === 0) {
      dim.applicabilityReasons = [dim.applicabilityReason];
      if (!dim.enabled) {
        dim.applicability = "not_applicable";
      }
    }
  }
}

/**
 * Build evidence summary across all scoring layers.
 */
function buildEvidenceSummary(
  dimensions: DimensionResult[],
  domainInference: { confidence: number },
  scenarioScore: ScenarioScore | undefined,
): EvidenceSummary {
  const enabledDims = dimensions.filter((dim) => dim.enabled && dim.score !== null);
  const totalDims = dimensions.filter((dim) => dim.enabled).length;
  const exportCoverage = totalDims > 0 ? enabledDims.length / totalDims : 0;

  // Core surface coverage: ratio of applicable dimensions with decent confidence
  const applicableDims = enabledDims.filter((dim) => dim.applicability === "applicable");
  const highConfDims = applicableDims.filter((dim) => (dim.confidence ?? 0.8) >= 0.7);
  const coreSurfaceCoverage =
    applicableDims.length > 0 ? highConfDims.length / applicableDims.length : 0;

  // Specialization evidence: from specializationPower dimension
  const specDim = dimensions.find((dim) => dim.key === "specializationPower");
  const specializationEvidence =
    specDim?.applicability === "applicable" ? (specDim.confidence ?? 0.8) : 0;

  const domainEvidence = domainInference.confidence;
  const scenarioEvidence = scenarioScore ? 0.9 : 0.1;

  return {
    coreSurfaceCoverage: Math.round(coreSurfaceCoverage * 100) / 100,
    domainEvidence: Math.round(domainEvidence * 100) / 100,
    exportCoverage: Math.round(exportCoverage * 100) / 100,
    scenarioEvidence: Math.round(scenarioEvidence * 100) / 100,
    specializationEvidence: Math.round(specializationEvidence * 100) / 100,
  };
}

/**
 * Compute a confidence cap based on severity of undersampling.
 * More undersampling reasons = lower cap. Fallback glob = lowest cap (handled separately).
 */
function computeUndersampleConfidenceCap(diagnostics: CoverageDiagnostics): number {
  const reasonCount = diagnostics.undersampledReasons.length;

  // Severe: 3+ reasons or zero positions/declarations
  if (
    reasonCount >= 3 ||
    diagnostics.measuredPositions === 0 ||
    diagnostics.measuredDeclarations === 0
  ) {
    return 0.4;
  }

  // Moderate: 2 reasons
  if (reasonCount >= 2) {
    return 0.55;
  }

  // Mild: 1 reason (e.g., just slightly below minimum files)
  return 0.65;
}

/**
 * Cap composite scores for undersampled packages.
 * Prevents inflated scores when coverage evidence is insufficient.
 * Does not affect composites already at or below the cap.
 */
function applyUndersampleScoreCap(composites: CompositeScore[]): void {
  for (const composite of composites) {
    if (composite.score !== null && composite.score > UNDERSAMPLE_SCORE_CAP) {
      const originalScore = composite.score;
      composite.score = UNDERSAMPLE_SCORE_CAP;
      composite.grade = computeGrade(UNDERSAMPLE_SCORE_CAP);
      composite.rationale.push(
        `Score capped from ${originalScore} to ${UNDERSAMPLE_SCORE_CAP} (undersampled package)`,
      );
    }
  }
}

/** Determine the typeSafety cap based on any-leakage density */
function computeAnyLeakageCap(anyDensity: number): number | undefined {
  if (anyDensity > ANY_LEAKAGE_SEVERE_THRESHOLD) {
    return ANY_LEAKAGE_SEVERE_CAP;
  }
  if (anyDensity > ANY_LEAKAGE_MODERATE_THRESHOLD) {
    return ANY_LEAKAGE_MODERATE_CAP;
  }
  return undefined;
}

/**
 * Enforce monotonic scoring constraints:
 * 1. High any-leakage must not produce high typeSafety scores
 * 2. High domain false-positive risk must suppress domain score emission
 *
 * Returns the (possibly suppressed) domainScore.
 */
function enforceMonotonicConstraints(opts: {
  composites: CompositeScore[];
  dimensions: DimensionResult[];
  domainInference: { falsePositiveRisk?: number };
  domainScore: DomainScore | undefined;
  caveats: string[];
}): DomainScore | undefined {
  const { composites, dimensions, domainInference, caveats } = opts;
  let { domainScore: resultDomainScore } = opts;

  // Constraint 1: High any-leakage caps typeSafety
  const safetyDim = dimensions.find((dim) => dim.key === "apiSafety");
  const anyDensity = (safetyDim?.metrics?.["anyDensity"] as number) ?? 0;

  if (anyDensity > 0) {
    const typeSafetyComposite = composites.find((comp) => comp.key === "typeSafety");
    if (typeSafetyComposite && typeSafetyComposite.score !== null) {
      const cap = computeAnyLeakageCap(anyDensity);

      if (cap !== undefined && typeSafetyComposite.score > cap) {
        const originalScore = typeSafetyComposite.score;
        typeSafetyComposite.score = cap;
        typeSafetyComposite.grade = computeGrade(cap);
        typeSafetyComposite.rationale.push(
          `Score capped from ${originalScore} to ${cap} (anyDensity=${anyDensity.toFixed(2)} exceeds monotonic threshold)`,
        );
        caveats.push(
          `TypeSafety capped at ${cap} due to high any-leakage rate (${(anyDensity * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // Constraint 2: High falsePositiveRisk suppresses domain score
  const fpRisk = domainInference.falsePositiveRisk ?? 0;
  if (fpRisk > DOMAIN_FALSE_POSITIVE_THRESHOLD && resultDomainScore !== undefined) {
    caveats.push(
      `Domain score suppressed (falsePositiveRisk=${fpRisk.toFixed(2)} exceeds ${DOMAIN_FALSE_POSITIVE_THRESHOLD})`,
    );
    resultDomainScore = undefined;
  }

  return resultDomainScore;
}

function computeSampleCoverage(dimensions: DimensionResult[]): number {
  const enabledDims = dimensions.filter((dim) => dim.enabled && dim.score !== null);
  if (enabledDims.length === 0) {
    return 0;
  }
  const confidences = enabledDims.map((dim) => dim.confidence ?? 0.5);
  return confidences.reduce((sum, conf) => sum + conf, 0) / confidences.length;
}

function buildGlobalScores(composites: CompositeScore[]): GlobalScores {
  const consumerApi = composites.find((comp) => comp.key === "consumerApi")!;
  const agentReadiness = composites.find((comp) => comp.key === "agentReadiness")!;
  const typeSafety = composites.find((comp) => comp.key === "typeSafety")!;
  return { agentReadiness, consumerApi, typeSafety };
}

/**
 * Compute domain-adjusted score.
 * This applies domain-specific weight adjustments to dimension scores,
 * producing a score only comparable within the same domain.
 *
 * Rule: domain inference may suppress false-positive issues but
 * may not directly increase a global score.
 */
function computeDomainScore(
  dimensions: DimensionResult[],
  domain: DomainType,
  domainConfidence: number,
): DomainScore {
  const adjustments: DomainScore["adjustments"] = [];
  const domainAdj = DOMAIN_FIT_ADJUSTMENTS[domain] ?? [];

  let totalWeight = 0;
  let weightedSum = 0;

  for (const dim of dimensions) {
    if (!dim.enabled || dim.score === null) {
      continue;
    }

    // Use consumerApi weight as base
    const baseWeight = dim.weights.consumerApi ?? 0;
    if (baseWeight === 0) {
      continue;
    }

    // Apply domain-specific weight multiplier
    const adj = domainAdj.find((item) => item.dimension === dim.key);
    const multiplier = adj?.weight ?? 1;
    const adjustedWeight = baseWeight * multiplier;

    totalWeight += adjustedWeight;
    weightedSum += dim.score * adjustedWeight;

    if (adj && multiplier !== 1) {
      const effect = Math.round((multiplier - 1) * baseWeight * dim.score);
      adjustments.push({
        adjustment: `weight ${multiplier > 1 ? "boost" : "reduce"} ×${multiplier}`,
        dimension: dim.key,
        effect,
        reason: adj.reason,
      });
    }
  }

  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return {
    adjustments,
    comparability: "domain",
    confidence: domainConfidence,
    domain: domain as DomainKey,
    grade: computeGrade(score),
    score,
  };
}

function buildExplainability(
  dimensions: DimensionResult[],
  domainInference: {
    domain: string;
    confidence: number;
    signals: string[];
    falsePositiveRisk?: number;
    matchedRules?: string[];
    suppressedIssues?: string[];
    adjustments?: { dimension: string; adjustment: string; reason: string }[];
    runnerUpDomain?: string;
    ambiguityGap?: number;
  },
): ExplainabilityReport {
  // Lowest specificity: issues from apiSpecificity
  const specDim = dimensions.find((dim) => dim.key === "apiSpecificity");
  const lowestSpecificity = (specDim?.issues ?? [])
    .filter((iss) => iss.severity === "error" || iss.severity === "warning")
    .slice(0, 10)
    .map((iss) => ({
      file: iss.file,
      line: iss.line,
      name: iss.message,
      score: 0,
    }));

  // Highest specificity: from apiSpecificity positives
  const highestSpecificity = (specDim?.positives ?? []).slice(0, 10).map((pos) => ({
    name: pos,
    score: specDim?.score ?? 0,
  }));

  // Highest lift: from semantic lift positives
  const liftDim = dimensions.find((dim) => dim.key === "semanticLift");
  const highestLift = (liftDim?.positives ?? []).slice(0, 10).map((pos) => ({
    name: pos,
    score: liftDim?.score ?? 0,
  }));

  // Safety leaks: from apiSafety issues
  const safetyDim = dimensions.find((dim) => dim.key === "apiSafety");
  const safetyLeaks = (safetyDim?.issues ?? [])
    .filter((iss) => iss.severity === "error")
    .slice(0, 10)
    .map((iss) => ({
      file: iss.file,
      line: iss.line,
      name: iss.message,
      score: 0,
    }));

  // Lowest usability: from agentUsability negatives
  const usabilityDim = dimensions.find((dim) => dim.key === "agentUsability");
  const lowestUsability = (usabilityDim?.negatives ?? []).slice(0, 10).map((neg) => ({
    name: neg,
    score: usabilityDim?.score ?? 0,
  }));

  // Highest specialization power: from specializationPower positives
  const specPowerDim = dimensions.find((dim) => dim.key === "specializationPower");
  const highestSpecializationPower = (specPowerDim?.positives ?? []).slice(0, 10).map((pos) => ({
    name: pos,
    score: specPowerDim?.score ?? 0,
  }));

  // Domain suppressions
  const domainSuppressions: { name: string; reason: string }[] = [];
  if (domainInference.suppressedIssues) {
    for (const issue of domainInference.suppressedIssues) {
      domainSuppressions.push({
        name: domainInference.domain,
        reason: issue,
      });
    }
  }

  // Domain ambiguities
  const domainAmbiguities: { domain: string; confidence: number; competingDomain?: string }[] = [];
  if (domainInference.confidence < 0.7) {
    const entry: { domain: string; confidence: number; competingDomain?: string } = {
      confidence: domainInference.confidence,
      domain: domainInference.domain,
    };
    if (domainInference.runnerUpDomain) {
      entry.competingDomain = domainInference.runnerUpDomain;
    }
    domainAmbiguities.push(entry);
  }

  return {
    domainAmbiguities,
    domainSuppressions,
    highestLift,
    highestSpecializationPower,
    highestSpecificity,
    lowestSpecificity,
    lowestUsability,
    safetyLeaks,
  };
}

/**
 * Enrich issue ownership on all dimensions.
 * Sets ownership and fixability fields on issues based on file paths.
 */
function enrichIssueOwnership(dimensions: DimensionResult[], projectRoot: string): void {
  for (const dim of dimensions) {
    for (const issue of dim.issues) {
      if (!issue.ownership) {
        const resolution = resolveFileOwnership(issue.file, projectRoot);
        issue.ownership = resolution.ownershipClass;

        // Set confidence from ownership resolution
        if (issue.confidence === undefined) {
          issue.confidence = resolution.confidence;
        }
      }

      // Classify file origin for signal hygiene
      if (!issue.fileOrigin) {
        issue.fileOrigin = classifyFileOrigin(issue.file);
      }

      // Set fixability based on ownership
      if (!issue.fixability) {
        switch (issue.ownership) {
          case "source-owned":
          case "workspace-owned": {
            issue.fixability = "direct";
            break;
          }
          case "generated": {
            issue.fixability = "indirect";
            break;
          }
          case "dependency-owned":
          case "standard-library-owned": {
            issue.fixability = "external";
            break;
          }
          default: {
            issue.fixability = "not_actionable";
          }
        }
      }

      // Set root cause category if not already set
      if (issue.rootCauseCategory === undefined) {
        const rootCause = inferRootCause(issue);
        if (rootCause) {
          issue.rootCauseCategory = rootCause;
        }
      }

      // Set suggested fix kind if not already set
      if (issue.suggestedFixKind === undefined) {
        const suggestedFix = inferSuggestedFix(issue);
        if (suggestedFix) {
          issue.suggestedFixKind = suggestedFix;
        }
      }

      // Compute agent priority
      if (issue.agentPriority === undefined) {
        issue.agentPriority = computeAgentPriority(issue);
      }
    }

    // Set dimension-level ownership and fixability
    if (!dim.ownership && dim.issues.length > 0) {
      const sourceOwned = dim.issues.filter(
        (iss) => iss.ownership === "source-owned" || iss.ownership === "workspace-owned",
      ).length;
      dim.ownership = sourceOwned > dim.issues.length / 2 ? "source-owned" : "mixed";
    }
    if (!dim.fixability && dim.issues.length > 0) {
      const directlyFixable = dim.issues.filter((iss) => iss.fixability === "direct").length;
      dim.fixability = directlyFixable > dim.issues.length / 2 ? "direct" : "indirect";
    }
  }
}

function inferRootCause(issue: Issue): NonNullable<Issue["rootCauseCategory"]> {
  const msg = issue.message.toLowerCase();
  if (msg.includes("any") || msg.includes("unknown")) {
    return "weak-type";
  }
  if (msg.includes("cast") || msg.includes("assertion")) {
    return "unsafe-cast";
  }
  if (msg.includes("validation") || msg.includes("parse")) {
    return "missing-validation";
  }
  if (msg.includes("narrow") || msg.includes("guard")) {
    return "missing-narrowing";
  }
  if (msg.includes("boundary") || msg.includes("leak")) {
    return "boundary-leak";
  }
  if (msg.includes("config") || msg.includes("strict")) {
    return "config-gap";
  }
  return "other";
}

function inferSuggestedFix(issue: Issue): NonNullable<Issue["suggestedFixKind"]> {
  const msg = issue.message.toLowerCase();
  if (msg.includes("any")) {
    return "replace-any";
  }
  if (msg.includes("validation") || msg.includes("parse")) {
    return "add-validation";
  }
  if (msg.includes("narrow") || msg.includes("guard")) {
    return "add-narrowing";
  }
  if (msg.includes("type annotation") || msg.includes("return type")) {
    return "add-type-annotation";
  }
  if (msg.includes("generic") || msg.includes("constraint")) {
    return "strengthen-generic";
  }
  if (msg.includes("overload")) {
    return "add-overload";
  }
  return "other";
}

function computeAgentPriority(issue: Issue): number {
  let priority = 50;

  // Severity boost
  if (issue.severity === "error") {
    priority += 25;
  } else if (issue.severity === "warning") {
    priority += 10;
  }

  // Fixability boost
  if (issue.fixability === "direct") {
    priority += 15;
  } else if (issue.fixability === "indirect") {
    priority += 5;
  } else if (issue.fixability === "external" || issue.fixability === "not_actionable") {
    priority -= 30;
  }

  // Ownership boost
  if (issue.ownership === "source-owned" || issue.ownership === "workspace-owned") {
    priority += 10;
  } else if (issue.ownership === "dependency-owned") {
    priority -= 20;
  }

  // Confidence factor
  if (issue.confidence !== undefined) {
    priority = Math.round(priority * issue.confidence);
  }

  return Math.max(0, Math.min(100, priority));
}

/**
 * Compute fixability score from issue-level fixability assessments.
 */
function computeFixabilityScore(dimensions: DimensionResult[]): FixabilityScore {
  const allIssues = dimensions.flatMap((dim) => dim.issues);
  if (allIssues.length === 0) {
    return {
      directlyFixable: 0,
      externalOnly: 0,
      grade: "A+" as Grade,
      indirectlyFixable: 0,
      notActionable: 0,
      rationale: ["No issues found"],
      score: 100,
    };
  }

  const directlyFixable = allIssues.filter((iss) => iss.fixability === "direct").length;
  const indirectlyFixable = allIssues.filter((iss) => iss.fixability === "indirect").length;
  const externalOnly = allIssues.filter((iss) => iss.fixability === "external").length;
  const notActionable = allIssues.filter((iss) => iss.fixability === "not_actionable").length;

  // Score: ratio of directly fixable issues
  const actionableRatio = (directlyFixable + indirectlyFixable * 0.5) / allIssues.length;
  const score = Math.round(actionableRatio * 100);

  const rationale = [
    `${directlyFixable}/${allIssues.length} directly fixable`,
    `${indirectlyFixable} indirectly fixable`,
    `${externalOnly} external-only`,
    `${notActionable} not actionable`,
  ];

  let grade: Grade = "F";
  if (score >= 95) {
    grade = "A+";
  } else if (score >= 85) {
    grade = "A";
  } else if (score >= 70) {
    grade = "B";
  } else if (score >= 55) {
    grade = "C";
  } else if (score >= 40) {
    grade = "D";
  }

  return {
    directlyFixable,
    externalOnly,
    grade,
    indirectlyFixable,
    notActionable,
    rationale,
    score,
  };
}

/**
 * Rank issues for the top-issues report. Sorts by ownership, severity, fixability.
 */
function rankIssuesForReport(issues: Issue[]): Issue[] {
  const severityOrder: Record<string, number> = { error: 0, info: 2, warning: 1 };
  const fixabilityOrder: Record<string, number> = {
    direct: 0,
    external: 2,
    indirect: 1,
    not_actionable: 3,
  };
  const ownershipOrder: Record<string, number> = {
    "dependency-owned": 4,
    generated: 3,
    mixed: 2,
    "source-owned": 0,
    "standard-library-owned": 5,
    unresolved: 6,
    "workspace-owned": 1,
  };

  return issues.toSorted((lhs, rhs) => {
    const byOwnership =
      (ownershipOrder[lhs.ownership ?? "source-owned"] ?? 0) -
      (ownershipOrder[rhs.ownership ?? "source-owned"] ?? 0);
    if (byOwnership !== 0) {
      return byOwnership;
    }
    const bySeverity = (severityOrder[lhs.severity] ?? 0) - (severityOrder[rhs.severity] ?? 0);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (
      (fixabilityOrder[lhs.fixability ?? "direct"] ?? 0) -
      (fixabilityOrder[rhs.fixability ?? "direct"] ?? 0)
    );
  });
}

/**
 * Classify a count into impact class using two thresholds.
 */
function classifyImpact(
  count: number,
  highThreshold: number,
  mediumThreshold: number,
): ImpactClass {
  if (count >= highThreshold) {
    return "high";
  }
  if (count >= mediumThreshold) {
    return "medium";
  }
  return "low";
}

/** Build a label-to-key map from dimension configs */
const LABEL_TO_KEY = new Map(DIMENSION_CONFIGS.map((cfg) => [cfg.label, cfg.key]));

/**
 * Enrich issues with dimensionKey based on their dimension label.
 */
function enrichDimensionKeys(dimensions: DimensionResult[]): void {
  for (const dim of dimensions) {
    for (const issue of dim.issues) {
      if (!issue.dimensionKey) {
        issue.dimensionKey = LABEL_TO_KEY.get(issue.dimension) ?? dim.key;
      }
    }
  }
}

/** Cluster definition: which dimension keys belong to each cluster category */
const CLUSTER_KEYS: Record<ClusterCategory, string[]> = {
  "agent-ergonomics": ["agentUsability"],
  "boundary-validation": ["boundaryDiscipline"],
  "public-surface": ["apiSpecificity", "surfaceConsistency", "surfaceComplexity"],
  "publish-declaration": ["publishQuality", "declarationFidelity"],
  "scenario-evidence": ["specializationPower", "semanticLift"],
  soundness: ["apiSafety", "implementationSoundness", "configDiscipline"],
};

const CLUSTER_META: Record<ClusterCategory, { strategy: string; title: string; why: string }> = {
  "agent-ergonomics": {
    strategy: "Improve JSDoc, parameter naming, and overload clarity for agent tooling",
    title: "Agent usability gaps",
    why: "Poor agent readiness makes the library harder for AI tools to use correctly",
  },
  "boundary-validation": {
    strategy: "Add runtime validation at trust boundaries (network, filesystem, env)",
    title: "Unvalidated trust boundaries",
    why: "External data entering without validation creates runtime safety risks",
  },
  "public-surface": {
    strategy: "Replace any/unknown returns with specific types, add generic constraints",
    title: "Public API type precision",
    why: "Vague public types force consumers to add their own type assertions",
  },
  "publish-declaration": {
    strategy: "Fix declaration emit, package.json exports, and types field",
    title: "Declaration and publish issues",
    why: "Missing or misconfigured declarations prevent consumers from importing types",
  },
  "scenario-evidence": {
    strategy: "Add domain-specific type patterns (branded types, discriminated unions, etc.)",
    title: "Specialization and semantic gaps",
    why: "Missing semantic type patterns reduce domain-specific usability",
  },
  soundness: {
    strategy: "Replace unsafe casts, add narrowing guards, fix type assertions",
    title: "Type safety and soundness",
    why: "Unsafe type operations create false type guarantees for consumers",
  },
};

/**
 * Build issue clusters from dimensions for human-facing summary.
 */
function buildIssueClusters(dimensions: DimensionResult[]): IssueCluster[] {
  const clusters: IssueCluster[] = [];

  for (const [category, keys] of Object.entries(CLUSTER_KEYS) as [ClusterCategory, string[]][]) {
    const clusterDims = dimensions.filter((dd) => keys.includes(dd.key));
    const clusterIssues = clusterDims.flatMap((dd) =>
      dd.issues.filter(
        (ii) =>
          !ii.suppressionReason &&
          ii.ownership !== "dependency-owned" &&
          ii.ownership !== "standard-library-owned",
      ),
    );

    if (clusterIssues.length === 0) {
      continue;
    }

    const meta = CLUSTER_META[category];
    const affectedFiles = [...new Set(clusterIssues.map((ii) => ii.file))];
    const errorCount = clusterIssues.filter((ii) => ii.severity === "error").length;
    const impact = classifyImpact(errorCount, 3, 1);

    clusters.push({
      affectedFiles: affectedFiles.slice(0, 10),
      agentFixStrategy: meta.strategy,
      category,
      clusterId: `cluster-${category}`,
      expectedMetricImpact: `${impact} impact — ${errorCount} error(s), ${clusterIssues.length} total issue(s)`,
      issueCount: clusterIssues.length,
      sampleIssues: clusterIssues.slice(0, 3),
      title: meta.title,
      whyItMatters: meta.why,
    });
  }

  // Sort by issue count descending
  return clusters.toSorted((lhs, rhs) => rhs.issueCount - lhs.issueCount);
}

/**
 * Build adoption-grade library inspection report from analysis results.
 */
function buildInspectionReport(
  result: AnalysisResult,
  clusters: IssueCluster[],
): LibraryInspectionReport {
  const trust = result.trustSummary;
  let trustScore = 0;
  if (trust?.classification === "trusted") {
    trustScore = 100;
  } else if (trust?.classification === "directional") {
    trustScore = 60;
  }

  // Compute evidence quality
  const cs = result.confidenceSummary;
  const coverageQuality = cs ? ((cs.sampleCoverage + cs.graphResolution) / 2) * 100 : 50;
  const evidenceQuality = Math.round(trustScore * 0.5 + coverageQuality * 0.5);

  // Compute suitability from composites
  const compositeAvg =
    result.composites.reduce((sum, cc) => sum + (cc.score ?? 0), 0) /
    Math.max(1, result.composites.filter((cc) => cc.score !== null).length);
  const candidateSuitability = Math.round(compositeAvg);

  // Build adoption risks
  const risks: AdoptionRiskCluster[] = [];
  const anyDim = result.dimensions.find((dd) => dd.key === "apiSafety");
  if (anyDim?.score !== null && anyDim?.score !== undefined && anyDim.score < 60) {
    risks.push({
      description: `API safety score is ${anyDim.score}/100 — any/unknown leakage in public surface`,
      mitigable: true,
      mitigation: "Wrap unsafe APIs with validated adapters",
      risk: "any/unknown leakage",
      severity: anyDim.score < 40 ? "high" : "medium",
    });
  }

  const specDim = result.dimensions.find((dd) => dd.key === "apiSpecificity");
  if (specDim?.score !== null && specDim?.score !== undefined && specDim.score < 60) {
    risks.push({
      description: `API specificity score is ${specDim.score}/100 — vague return types`,
      mitigable: true,
      mitigation: "Add type assertions at call sites or use generic wrappers",
      risk: "return-type vagueness",
      severity: specDim.score < 40 ? "high" : "medium",
    });
  }

  const pubDim = result.dimensions.find((dd) => dd.key === "publishQuality");
  if (pubDim?.score !== null && pubDim?.score !== undefined && pubDim.score < 50) {
    risks.push({
      description: `Publish quality score is ${pubDim.score}/100 — declaration layout issues`,
      mitigable: false,
      risk: "publish layout risk",
      severity: pubDim.score < 30 ? "high" : "medium",
    });
  }

  if (result.coverageDiagnostics?.undersampled) {
    risks.push({
      description: "Insufficient type coverage to assess quality reliably",
      mitigable: false,
      risk: "insufficient evidence",
      severity: "high",
    });
  }

  // Build summary
  const highRisks = risks.filter((rr) => rr.severity === "high").length;
  let adoptionSummary = `Library has weak type quality — adoption requires wrappers or alternatives`;
  if (candidateSuitability >= 75 && highRisks === 0) {
    adoptionSummary = "Library has strong type quality — safe to adopt with standard review";
  } else if (candidateSuitability >= 50) {
    adoptionSummary = `Library has moderate type quality — ${highRisks} high-risk area(s) need attention`;
  }

  // Safe/banned subsets based on dimension analysis
  const safeSubset: string[] = [];
  const bannedApis: string[] = [];
  const requiredWrappers: string[] = [];

  for (const dim of result.dimensions) {
    if (dim.score !== null && dim.score >= 80) {
      safeSubset.push(`${dim.label} patterns are well-typed`);
    }
  }
  if (anyDim?.score !== null && anyDim?.score !== undefined && anyDim.score < 40) {
    bannedApis.push("APIs returning unvalidated any/unknown — wrap all call sites");
  }
  if (risks.some((rr) => rr.mitigable)) {
    requiredWrappers.push(
      ...risks.filter((rr) => rr.mitigable && rr.mitigation).map((rr) => rr.mitigation!),
    );
  }

  return {
    adoptionRisks: risks,
    adoptionSummary,
    bannedApis,
    candidateSuitability,
    evidenceQuality,
    issueClusters: clusters,
    requiredWrappers,
    safeSubset,
  };
}

/**
 * Generate up to 3 concrete next-action recommendations from analysis results.
 * Uses canonical dimension keys for stable matching.
 */
function generateRecommendations(
  dimensions: DimensionResult[],
  boundarySummary: ReturnType<typeof buildBoundarySummary> | undefined,
  topIssues: Issue[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const allIssues = dimensions.flatMap((dim) => dim.issues);

  // Soundness cluster: apiSafety, implementationSoundness
  const soundnessKeys = new Set(["apiSafety", "implementationSoundness"]);
  const soundnessIssues = allIssues.filter(
    (iss) =>
      soundnessKeys.has(iss.dimensionKey ?? "") &&
      iss.ownership !== "dependency-owned" &&
      iss.ownership !== "standard-library-owned",
  );
  if (soundnessIssues.length > 0) {
    const errorCount = soundnessIssues.filter((ii) => ii.severity === "error").length;
    const impact: ImpactClass = classifyImpact(errorCount, 3, 1);
    recommendations.push({
      action: `Fix ${soundnessIssues.length} type safety issue(s) — ${errorCount} error-severity`,
      category: "soundness",
      impact,
      reason: "Unsafe casts and missing narrowing reduce consumer type guarantees",
    });
  }

  // Boundary cluster
  if (boundarySummary && boundarySummary.unvalidatedBoundaries > 0) {
    const untrustedCount = boundarySummary.inventory.filter(
      (ee) => !ee.hasValidation && ee.trustLevel === "untrusted-external",
    ).length;
    const impact: ImpactClass = classifyImpact(untrustedCount, 3, 1);
    recommendations.push({
      action: `Add validation to ${boundarySummary.unvalidatedBoundaries} unvalidated boundary(ies)`,
      category: "boundary",
      impact,
      reason: "Unvalidated external data flows weaken runtime trust guarantees",
    });
  }

  // Public surface cluster: apiSpecificity, surfaceConsistency
  const surfaceKeys = new Set(["apiSpecificity", "surfaceConsistency"]);
  const surfaceIssues = allIssues.filter(
    (iss) =>
      surfaceKeys.has(iss.dimensionKey ?? "") &&
      iss.ownership !== "dependency-owned" &&
      iss.ownership !== "standard-library-owned",
  );
  if (surfaceIssues.length > 0) {
    const impact: ImpactClass = classifyImpact(surfaceIssues.length, 5, 2);
    recommendations.push({
      action: `Tighten ${surfaceIssues.length} public API type(s) — reduce any/unknown surface exposure`,
      category: "public-surface",
      impact,
      reason: "Vague public types hurt consumer inference and agent usability",
    });
  }

  // If we still have room and have top issues, add a general recommendation
  if (recommendations.length === 0 && topIssues.length > 0) {
    recommendations.push({
      action: `Address ${topIssues.length} top issue(s) starting from highest severity`,
      category: "general",
      impact: topIssues.some((ii) => ii.severity === "error") ? "medium" : "low",
      reason: "Resolving the highest-severity issues first yields the fastest score improvement",
    });
  }

  return recommendations.slice(0, 3);
}

/**
 * Merge boundary-derived issues into the result's dimensions and topIssues.
 */
function wireBoundaryIssues(result: AnalysisResult, boundaryIssues: Issue[]): void {
  if (boundaryIssues.length === 0) {
    return;
  }

  // Add to boundaryDiscipline dimension if it exists
  const bdDim = result.dimensions.find((dd) => dd.key === "boundaryDiscipline");
  if (bdDim) {
    // Avoid duplicating issues already captured by the dimension analyzer
    const existingKeys = new Set(bdDim.issues.map((ii) => `${ii.file}:${ii.line}`));
    const novel = boundaryIssues.filter((bi) => !existingKeys.has(`${bi.file}:${bi.line}`));
    bdDim.issues.push(...novel);
  }

  // Add high-risk boundary issues to topIssues
  const existingTopKeys = new Set(result.topIssues.map((ii) => `${ii.file}:${ii.line}`));
  const highRisk = boundaryIssues.filter(
    (bi) => bi.severity === "error" && !existingTopKeys.has(`${bi.file}:${bi.line}`),
  );
  result.topIssues.push(...highRisk);
}

function riskToImpact(riskScore: number): "high" | "medium" | "low" {
  if (riskScore >= 70) {
    return "high";
  }
  if (riskScore >= 40) {
    return "medium";
  }
  return "low";
}

function riskToSeverity(riskScore: number): Issue["severity"] {
  if (riskScore >= 70) {
    return "error";
  }
  if (riskScore >= 40) {
    return "warning";
  }
  return "info";
}

/**
 * Convert boundary hotspots into first-class Issue records.
 * Deduplicates by file+line to collapse repeated detections at the same endpoint.
 */
function convertBoundaryHotspotsToIssues(hotspots: BoundaryHotspot[]): Issue[] {
  // Deduplicate by file:line — collapse repeated boundary detections at the same site
  const seen = new Set<string>();
  const issues: Issue[] = [];

  const ROOT_CAUSE_MAP: Record<string, Issue["rootCauseCategory"]> = {
    "UI-input": "missing-validation",
    config: "config-gap",
    database: "missing-validation",
    env: "config-gap",
    filesystem: "missing-validation",
    network: "unsafe-external-input",
    queue: "missing-validation",
    sdk: "missing-validation",
    serialization: "unsafe-external-input",
  };

  const FIX_KIND_MAP: Record<string, Issue["suggestedFixKind"]> = {
    "UI-input": "add-validation",
    config: "add-env-parsing",
    database: "add-validation",
    env: "add-env-parsing",
    filesystem: "add-validation",
    network: "add-validation",
    queue: "add-validation",
    serialization: "wrap-json-parse",
  };

  for (const hotspot of hotspots) {
    const key = `${hotspot.file}:${hotspot.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    // Higher risk hotspots get higher agent priority
    const agentPriority = Math.min(100, Math.round(hotspot.riskScore));

    issues.push({
      agentPriority,
      boundaryType: hotspot.boundaryType,
      column: 0,
      decisionImpact: riskToImpact(hotspot.riskScore),
      dimension: "Boundary Discipline",
      dimensionKey: "boundaryDiscipline",
      file: hotspot.file,
      fixability: "direct",
      issueId: `boundaryDiscipline:${hotspot.file.replace(/.*node_modules\//, "").replace(/.*\/src\//, "src/")}:${hotspot.line}:0`,
      line: hotspot.line,
      message: `Unvalidated ${hotspot.boundaryType} boundary: ${hotspot.description}`,
      ownership: "source-owned",
      rootCauseCategory: ROOT_CAUSE_MAP[hotspot.boundaryType] ?? "boundary-leak",
      severity: riskToSeverity(hotspot.riskScore),
      suggestedFixKind: FIX_KIND_MAP[hotspot.boundaryType] ?? "add-validation",
    });
  }

  return issues;
}

/**
 * Generate recommended fixes from boundary hotspots.
 */
function generateBoundaryFixes(hotspots: BoundaryHotspot[]): BoundaryRecommendedFix[] {
  const FIX_MAP: Record<string, { fix: string; fixKind: BoundaryRecommendedFix["fixKind"] }> = {
    "UI-input": {
      fix: "Add input validation/sanitization before processing",
      fixKind: "add-validation",
    },
    config: { fix: "Parse and validate config values before use", fixKind: "add-env-parsing" },
    database: {
      fix: "Validate database query results against expected schema",
      fixKind: "add-validation",
    },
    env: {
      fix: "Add runtime parsing for environment variables (e.g., zod, valibot)",
      fixKind: "add-env-parsing",
    },
    filesystem: {
      fix: "Validate file content after read with schema parser",
      fixKind: "add-validation",
    },
    network: {
      fix: "Wrap HTTP response with schema validation (zod, valibot)",
      fixKind: "add-validation",
    },
    queue: { fix: "Validate queue payload against expected schema", fixKind: "add-validation" },
    serialization: { fix: "Wrap JSON.parse with schema validation", fixKind: "wrap-json-parse" },
  };

  return hotspots.slice(0, 10).map((hotspot) => {
    const template = FIX_MAP[hotspot.boundaryType] ?? {
      fix: "Add validation at this boundary",
      fixKind: "add-validation" as const,
    };
    return {
      boundaryType: hotspot.boundaryType,
      file: hotspot.file,
      fix: template.fix,
      fixKind: template.fixKind,
      line: hotspot.line,
      riskScore: hotspot.riskScore,
    };
  });
}

/**
 * Lightweight boundary-only analysis.
 * Skips dimensions, domain detection, scenario scoring, composites, explainability.
 * Returns only the boundary graph, summary, quality score, hotspots, and recommended fixes.
 */
export interface BoundaryOnlyResult {
  boundaryQuality: ReturnType<typeof computeBoundaryQuality> | null;
  boundarySummary: ReturnType<typeof buildBoundarySummary> | null;
  /** Ranked boundary hotspots by descending risk */
  boundaryHotspots: BoundaryHotspot[];
  /** Recommended boundary fixes derived from hotspot analysis */
  recommendedFixes: BoundaryRecommendedFix[];
  filesAnalyzed: number;
  projectName: string;
  timeMs: number;
}

export function analyzeBoundariesOnly(projectPath: string): BoundaryOnlyResult {
  const startTime = performance.now();
  const absolutePath = resolve(projectPath);
  const projectName = basename(absolutePath);

  // Use lightweight loader — boundary analysis only needs AST traversal, not type resolution
  const project = loadProjectLightweight(absolutePath);
  const sourceFiles = getSourceFiles(project, undefined, absolutePath);
  const filesAnalyzed = sourceFiles.length;

  if (filesAnalyzed === 0) {
    return {
      boundaryHotspots: [],
      boundaryQuality: null,
      boundarySummary: null,
      filesAnalyzed: 0,
      projectName,
      recommendedFixes: [],
      timeMs: Math.round(performance.now() - startTime),
    };
  }

  const boundaryGraph = buildBoundaryGraph(sourceFiles, project);
  const boundarySummary = buildBoundarySummary(boundaryGraph);
  const boundaryQuality = computeBoundaryQuality(boundarySummary);
  const boundaryHotspots = computeBoundaryHotspots(boundarySummary);
  const recommendedFixes = generateBoundaryFixes(boundaryHotspots);

  return {
    boundaryHotspots,
    boundaryQuality,
    boundarySummary,
    filesAnalyzed,
    projectName,
    recommendedFixes,
    timeMs: Math.round(performance.now() - startTime),
  };
}

/**
 * Detect workspace root and return monorepo health summary if applicable.
 * Non-throwing: returns undefined if the path is not a workspace root or analysis fails.
 */
function tryAttachMonorepoHealth(
  projectPath: string,
  resourceWarnings: ResourceWarning[],
): MonorepoHealthSummary | undefined {
  // Check for workspace indicators
  const hasPnpmWorkspace = existsSync(join(projectPath, "pnpm-workspace.yaml"));
  const hasPackageJson = existsSync(join(projectPath, "package.json"));

  if (!hasPnpmWorkspace && !hasPackageJson) {
    return undefined;
  }

  // Quick check: if package.json has no workspaces field and no pnpm-workspace.yaml, skip
  if (!hasPnpmWorkspace && hasPackageJson) {
    try {
      const raw = readFileSync(join(projectPath, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (!pkg["workspaces"]) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  try {
    const report = analyzeMonorepo({ rootPath: projectPath });
    if (report.packages.length <= 1) {
      // Single-package workspace — not meaningful monorepo health
      return undefined;
    }
    return report.healthSummary;
  } catch {
    resourceWarnings.push({
      kind: "monorepo-fallback",
      message: "Monorepo analysis failed; workspace health not attached",
    });
    return undefined;
  }
}
