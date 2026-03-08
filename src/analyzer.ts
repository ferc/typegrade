import type {
  AnalysisMode,
  AnalysisResult,
  CompositeScore,
  ConfidenceSummary,
  CoverageDiagnostics,
  DimensionResult,
  DomainKey,
  DomainScore,
  ExplainabilityReport,
  GlobalScores,
  Issue,
  PackageAnalysisContext,
  ScenarioScore,
  ScoreComparability,
} from "./types.js";
import { type DomainType, detectDomain } from "./domain.js";
import { type GetSourceFilesOptions, getSourceFiles, loadProject } from "./utils/project-loader.js";
import { basename, resolve } from "node:path";
import { computeComposites, computeGrade } from "./scorer.js";
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
import { evaluateScenarioPack } from "./scenarios/types.js";
import { extractPublicSurface } from "./surface/index.js";
import { getScenarioPack } from "./scenarios/index.js";

/** Minimum domain confidence to emit domainFitScore */
const DOMAIN_CONFIDENCE_THRESHOLD = 0.7;
/** Minimum gap between winner and runner-up for domain emission */
const DOMAIN_AMBIGUITY_GAP = 0.15;
/** Minimum domain confidence to run scenario packs */
const SCENARIO_CONFIDENCE_THRESHOLD = 0.7;
/** Confidence cap when graph resolution used fallback glob */
const FALLBACK_CONFIDENCE_CAP = 0.55;

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
 * Detect undersampling — packages where we have too little data
 * to produce a reliable score.
 */
function computeCoverageDiagnostics(opts: {
  graphStats: GraphStats;
  surfacePositions: number;
  surfaceDeclarations: number;
  typesSource: "bundled" | "@types" | "mixed" | "unknown";
}): CoverageDiagnostics {
  const { graphStats, surfacePositions, surfaceDeclarations, typesSource } = opts;
  const reasons: string[] = [];

  if (graphStats.totalReachable < MIN_REACHABLE_FILES && !graphStats.usedFallbackGlob) {
    reasons.push(
      `Only ${graphStats.totalReachable} reachable file(s) from entrypoints (minimum: ${MIN_REACHABLE_FILES})`,
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
  if (graphStats.usedFallbackGlob) {
    reasons.push("Graph resolution used fallback glob — entrypoint traversal failed");
  }
  if (
    graphStats.totalAfterDedup < MIN_REACHABLE_FILES &&
    graphStats.totalReachable >= MIN_REACHABLE_FILES
  ) {
    reasons.push(
      `After dedup only ${graphStats.totalAfterDedup} file(s) remain (high dedup ratio may indicate incomplete surface)`,
    );
  }

  return {
    measuredDeclarations: surfaceDeclarations,
    measuredPositions: surfacePositions,
    reachableFiles: graphStats.totalReachable,
    typesSource,
    undersampled: reasons.length > 0,
    undersampledReasons: reasons,
  };
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
}

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
  let sourceFiles = getSourceFiles(project, sourceFilesOptions);
  if (options?.fileFilter) {
    sourceFiles = sourceFiles.filter((sf) => options.fileFilter!.has(sf.getFilePath()));
  }
  const filesAnalyzed = sourceFiles.length;

  // No source files -> score 0
  if (filesAnalyzed === 0) {
    const timeMs = Math.round(performance.now() - startTime);
    return {
      caveats: [],
      composites: [
        { grade: "N/A", key: "agentReadiness", rationale: ["No files found"], score: 0 },
        { grade: "N/A", key: "consumerApi", rationale: ["No files found"], score: 0 },
        { grade: "N/A", key: "typeSafety", rationale: ["No files found"], score: 0 },
        { grade: "N/A", key: "implementationQuality", rationale: ["No files found"], score: null },
      ],
      dedupStats: { filesRemoved: 0, groups: 0 },
      dimensions: [],
      filesAnalyzed: 0,
      graphStats,
      mode,
      projectName,
      scoreComparability: "global",
      scoreProfile: isPackageMode ? "published-declarations" : "source-project",
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
    };
  }

  // Build consumer view
  let consumerFiles = sourceFiles;
  const sourceOnlyFiles = sourceFiles;
  const caveats: string[] = [];
  let usingSourceFallback = false;

  if (mode === "source") {
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
  }

  // Extract public surface once, shared by all consumer-facing analyzers
  const consumerSurface = extractPublicSurface(consumerFiles);

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
        applicabilityReason: "Not applicable for published declarations",
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

  const composites = computeComposites(dimensions, mode);

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

  // Run scenario pack if domain was detected with sufficient confidence and no fallback glob
  let scenarioScore: ScenarioScore | undefined = undefined;
  if (
    domainConfidenceMet &&
    !usedFallbackGlob &&
    domainInference.confidence >= SCENARIO_CONFIDENCE_THRESHOLD
  ) {
    const pack = getScenarioPack(domainInference.domain as DomainKey);
    if (pack) {
      scenarioScore = evaluateScenarioPack(pack, consumerSurface, packageName);
    }
  }

  // Collect top issues
  const allIssues: Issue[] = dimensions.flatMap((dim) => dim.issues);
  const severityOrder: Record<string, number> = { error: 0, info: 2, warning: 1 };
  const topIssues = allIssues
    .toSorted((lhs, rhs) => (severityOrder[lhs.severity] ?? 0) - (severityOrder[rhs.severity] ?? 0))
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

  // Compute coverage diagnostics
  const typesSource = options?.packageContext?.typesSource ?? "unknown";
  const coverageDiagnostics = computeCoverageDiagnostics({
    graphStats,
    surfaceDeclarations: consumerSurface.stats.totalDeclarations,
    surfacePositions: consumerSurface.stats.totalPositions,
    typesSource,
  });
  if (coverageDiagnostics.undersampled) {
    caveats.push(`Package is undersampled: ${coverageDiagnostics.undersampledReasons.join("; ")}`);
  }

  const result: AnalysisResult = {
    caveats,
    composites,
    confidenceSummary,
    coverageDiagnostics,
    dedupStats,
    dimensions,
    domainInference,
    domainScore,
    filesAnalyzed,
    globalScores,
    graphStats,
    mode,
    projectName,
    scenarioScore,
    scoreComparability,
    scoreProfile: isPackageMode ? "published-declarations" : "source-project",
    timeMs,
    topIssues,
  };

  // Build explainability report if requested
  if (options?.explain) {
    result.explainability = buildExplainability(dimensions, domainInference);
  }

  return result;
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
