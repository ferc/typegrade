import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisMode,
  type AnalysisProfile,
  type AnalysisResult,
  type AnalysisStatus,
  type CompositeScore,
  type ConfidenceSummary,
  type CoverageDiagnostics,
  type CoverageFailureMode,
  type DimensionResult,
  type DomainKey,
  type DomainScore,
  type EvidenceSummary,
  type ExplainabilityReport,
  type FixabilityScore,
  type GlobalScores,
  type Grade,
  type Issue,
  type PackageAnalysisContext,
  type PackageIdentity,
  type ScenarioApplicabilityStatus,
  type ScenarioScore,
  type ScoreComparability,
  type ScoreValidity,
  type SourceModeConfidence,
  type SuppressionEntry,
  type TrustSummary,
} from "./types.js";
import { type DomainType, detectDomain } from "./domain.js";
import {
  type GetSourceFilesOptions,
  getSourceFiles,
  loadProject,
  loadProjectLightweight,
} from "./utils/project-loader.js";
import { basename, resolve } from "node:path";
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
import { DOMAIN_FIT_ADJUSTMENTS } from "./constants.js";
import type { GraphStats } from "./graph/types.js";
import { Project } from "ts-morph";
import { analyzeAgentUsability } from "./analyzers/agent-usability.js";
import { analyzeApiSafety } from "./analyzers/api-safety.js";
import { analyzeApiSpecificity } from "./analyzers/api-specificity.js";
import { analyzeBoundaryDiscipline } from "./analyzers/boundary-discipline.js";
import { analyzeConfigDiscipline } from "./analyzers/config-discipline.js";
import { analyzeDeclarationFidelity } from "./analyzers/declaration-fidelity.js";
import { analyzeImplementationSoundness } from "./analyzers/implementation-soundness.js";
import { analyzePublishQuality } from "./analyzers/publish-quality.js";
import { analyzeSemanticLift } from "./analyzers/semantic-lift.js";
import { analyzeSpecializationPower } from "./analyzers/specialization-power.js";
import { analyzeSurfaceComplexity } from "./analyzers/surface-complexity.js";
import { analyzeSurfaceConsistency } from "./analyzers/surface-consistency.js";
import { applySuppressions } from "./suppression/index.js";
import { classifyFileOrigin } from "./origin/classifier.js";
import { filterIssues } from "./origin/filter.js";
import { getScenarioPackWithVariant } from "./scenarios/index.js";
import { resolveFileOwnership } from "./ownership/index.js";

/** Minimum domain confidence to emit domainFitScore */
const DOMAIN_CONFIDENCE_THRESHOLD = 0.7;
/** Minimum gap between winner and runner-up for domain emission */
const DOMAIN_AMBIGUITY_GAP = 0.15;
/** Minimum domain confidence to run scenario packs */
const SCENARIO_CONFIDENCE_THRESHOLD = 0.7;
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
    }
  }

  // --- Trust summary computation ---
  result.trustSummary = computeTrustSummary(result);

  // --- Stable issue IDs (WS7) ---
  assignStableIssueIds(result);

  return result;
}

/**
 * Assign deterministic, stable issue IDs to all issues in the result.
 * ID format: dimension:file:line:col — stable across runs on the same codebase.
 */
function assignStableIssueIds(result: AnalysisResult): void {
  // Assign IDs to dimension issues
  for (const dim of result.dimensions) {
    for (const issue of dim.issues) {
      if (!issue.issueId) {
        issue.issueId = computeIssueId(issue);
      }
    }
  }
  // Assign IDs to topIssues
  for (const issue of result.topIssues) {
    if (!issue.issueId) {
      issue.issueId = computeIssueId(issue);
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

  // Trusted: complete with strong evidence
  reasons.push("Complete analysis with sufficient coverage");
  return { canCompare: true, canGate: true, classification: "trusted", reasons };
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

  let samplingClass:
    | "complete"
    | "compact"
    | "compact-complete"
    | "compact-partial"
    | "undersampled" = "complete";
  let compactReason: string | undefined = undefined;

  if (reasons.length === 0) {
    samplingClass = "complete";
  } else if (fewFilesOnly && hasSufficientSurface) {
    // Distinguish compact-complete (enough surface for accurate scoring) from compact-partial
    const isFullySufficient =
      surfacePositions >= MIN_MEASURED_POSITIONS * 2 &&
      surfaceDeclarations >= MIN_MEASURED_DECLARATIONS * 2;
    samplingClass = isFullySufficient ? "compact-complete" : "compact-partial";
    compactReason = `${graphStats.totalReachable} file(s) but ${surfacePositions} positions and ${surfaceDeclarations} declarations — small-by-design library`;
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

  // Build consumer view
  let consumerFiles = sourceFiles;
  const sourceOnlyFiles = sourceFiles;
  const caveats: string[] = [];
  let usingSourceFallback = false;

  if (mode === "source" && !options?.skipDeclEmit) {
    try {
      const emitResult = project.emitToMemory({ emitOnlyDtsFiles: true });
      const emittedFiles = emitResult.getFiles();
      const diagnostics = emitResult.getDiagnostics();

      const emitDiagnosticCount = diagnostics.length;
      if (emitDiagnosticCount > 0) {
        caveats.push(`Declaration emit produced ${emitDiagnosticCount} diagnostic(s)`);
      }

      if (emittedFiles.length > 0) {
        const emitSuccessRate = emittedFiles.length / sourceFiles.length;
        const dtsProject = new Project({
          compilerOptions: { module: 99, skipLibCheck: true, strict: true, target: 2 },
          useInMemoryFileSystem: true,
        });
        for (const file of emittedFiles) {
          dtsProject.createSourceFile(file.filePath, file.text);
        }
        consumerFiles = dtsProject.getSourceFiles();
        if (emitSuccessRate < 1) {
          caveats.push(
            `Partial declaration emit: ${emittedFiles.length}/${sourceFiles.length} files (${Math.round(emitSuccessRate * 100)}%)`,
          );
        }
      } else {
        usingSourceFallback = true;
        caveats.push("Could not emit declarations; consumer analysis uses source files directly");
      }
    } catch {
      usingSourceFallback = true;
      caveats.push("Declaration emit failed; consumer analysis uses source files directly");
    }
  } else if (mode === "source" && options?.skipDeclEmit) {
    usingSourceFallback = true;
  }

  // Extract public surface once, shared by all consumer-facing analyzers
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

  // Run consumer-facing dimensions against the shared surface
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

  // Source-only dimensions
  if (mode === "source") {
    dimensions.push(analyzeDeclarationFidelity(sourceOnlyFiles, consumerFiles));
    dimensions.push(analyzeImplementationSoundness(sourceOnlyFiles));
    dimensions.push(analyzeBoundaryDiscipline(sourceOnlyFiles, project));
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

  // Resolve profile early so we can pass it to the scorer
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

  // Allow domain scoring even with fallback glob, but only if not auto-disabled
  if (domainConfidenceMet && !usedFallbackGlob) {
    domainScore = computeDomainScore(
      dimensions,
      domainInference.domain as DomainType,
      domainInference.confidence,
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
  if (scenarioApplicabilityStatus === "not_applicable") {
    scenarioAbstentionReason =
      domainOpt === "off"
        ? "Domain scoring disabled"
        : `Domain confidence too low (${domainInference.confidence.toFixed(2)}) — scenario not applicable`;
  } else if (!domainConfidenceMet) {
    scenarioAbstentionReason = `Domain confidence too low (${domainInference.confidence.toFixed(2)})`;
  } else if (usedFallbackGlob) {
    scenarioAbstentionReason = "Graph used fallback glob — scenario evaluation skipped";
  } else if (domainInference.confidence < SCENARIO_CONFIDENCE_THRESHOLD) {
    scenarioAbstentionReason = `Domain confidence ${domainInference.confidence.toFixed(2)} below scenario threshold`;
  } else {
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
        scenarioScore.scenarioApplicability = scenarioApplicabilityStatus;
      } else {
        scenarioAbstentionReason = `Scenario pack '${pack.name}' not applicable: ${applicabilityCheck.reason}`;
      }
    } else {
      scenarioAbstentionReason = `No scenario pack for domain '${domainInference.domain}'`;
    }
  }
  if (scenarioAbstentionReason && !scenarioScore) {
    caveats.push(scenarioAbstentionReason);
  }

  // Collect top issues
  const allIssues: Issue[] = dimensions.flatMap((dim) => dim.issues);
  const severityOrder: Record<string, number> = { error: 0, info: 2, warning: 1 };
  const fixabilityOrder: Record<string, number> = {
    direct: 0,
    external: 2,
    indirect: 1,
    not_actionable: 3,
  };
  // Ownership priority: source-owned first, dependency-owned last
  const ownershipOrder: Record<string, number> = {
    "dependency-owned": 4,
    generated: 3,
    mixed: 2,
    "source-owned": 0,
    "standard-library-owned": 5,
    unresolved: 6,
    "workspace-owned": 1,
  };
  // Filter top issues: exclude generated/dist/vendor/config-origin by default
  const noiseOrigins = new Set(["generated", "dist", "vendor", "config"]);
  const sourceIssues = allIssues.filter((iss) => {
    const origin = iss.fileOrigin ?? "source";
    return !noiseOrigins.has(origin);
  });
  // Fall back to all issues if no source issues exist
  const issueCandidates = sourceIssues.length > 0 ? sourceIssues : allIssues;
  const topIssues = issueCandidates
    .toSorted((lhs, rhs) => {
      // Source-owned issues sort first
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
    })
    .slice(0, 10);

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
  // Source mode: undersampling is informational only — don't degrade the result (WS6).
  // Source analyses always have usable scores; only package analyses degrade on insufficient coverage.
  const shouldDegradeForUndersampling = isUndersampled && mode === "package";
  const analysisStatus: AnalysisStatus = shouldDegradeForUndersampling ? "degraded" : "complete";
  let scoreValidity: ScoreValidity = "fully-comparable";
  if (shouldDegradeForUndersampling) {
    scoreValidity = "not-comparable";
  } else if (isUndersampled) {
    scoreValidity = "partially-comparable";
  } else if (isFallbackGlob) {
    scoreValidity = "partially-comparable";
  }
  const degradedReason: string | undefined = isUndersampled
    ? `Undersampled: ${coverageDiagnostics.undersampledReasons.join("; ")}`
    : undefined;

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

  const result: AnalysisResult = {
    actionabilitySummary,
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    analysisScope,
    caveats,
    composites,
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
    noiseSummary: noiseSummary.generatedIssueCount > 0 ? noiseSummary : undefined,
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
      declarationEmitSuccess: 1,
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
  }
  if (boundaryQuality) {
    result.boundaryQuality = boundaryQuality;
  }
  if (suppressions.length > 0) {
    result.suppressions = suppressions;
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
 * Lightweight boundary-only analysis.
 * Skips dimensions, domain detection, scenario scoring, composites, explainability.
 * Returns only the boundary graph, summary, and quality score.
 */
export interface BoundaryOnlyResult {
  boundaryQuality: ReturnType<typeof computeBoundaryQuality> | null;
  boundarySummary: ReturnType<typeof buildBoundarySummary> | null;
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
      boundaryQuality: null,
      boundarySummary: null,
      filesAnalyzed: 0,
      projectName,
      timeMs: Math.round(performance.now() - startTime),
    };
  }

  const boundaryGraph = buildBoundaryGraph(sourceFiles, project);
  const boundarySummary = buildBoundarySummary(boundaryGraph);
  const boundaryQuality = computeBoundaryQuality(boundarySummary);

  return {
    boundaryQuality,
    boundarySummary,
    filesAnalyzed,
    projectName,
    timeMs: Math.round(performance.now() - startTime),
  };
}
