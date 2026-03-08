import type {
  AnalysisMode,
  AnalysisResult,
  DimensionResult,
  DomainScore,
  ExplainabilityReport,
  GlobalScores,
  Issue,
  PackageAnalysisContext,
  ScoreComparability,
} from "./types.js";
import { type GetSourceFilesOptions, getSourceFiles, loadProject } from "./utils/project-loader.js";
import { basename, resolve } from "node:path";
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
import { analyzeSurfaceComplexity } from "./analyzers/surface-complexity.js";
import { analyzeSurfaceConsistency } from "./analyzers/surface-consistency.js";
import { DOMAIN_FIT_ADJUSTMENTS } from "./constants.js";
import { type DomainType, detectDomain } from "./domain.js";
import { computeComposites, computeGrade } from "./scorer.js";
import { getScenarioPack } from "./scenarios/index.js";
import { evaluateScenarioPack } from "./scenarios/types.js";
import { extractPublicSurface } from "./surface/index.js";

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
      dimensions: [],
      filesAnalyzed: 0,
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
          confidence: 0,
          domain: "general" as const,
          falsePositiveRisk: 0,
          matchedRules: [] as string[],
          signals: [] as string[],
        }
      : detectDomain(consumerSurface, options?.packageContext?.packageName);

  // Run consumer-facing dimensions against the shared surface
  const packageName = options?.packageContext?.packageName;
  const dimensions: DimensionResult[] = [
    analyzeApiSpecificity(consumerSurface),
    analyzeApiSafety(consumerSurface, packageName),
    analyzeSemanticLift(consumerSurface),
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
          .replace(/^./, (c) => c.toUpperCase())
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
      if (dim.confidence === undefined) {
        dim.confidence = 0.6;
      } else {
        dim.confidence = Math.min(dim.confidence, 0.6);
      }
      dim.confidenceSignals = dim.confidenceSignals ?? [];
      dim.confidenceSignals.push({
        reason: "Consumer analysis using raw source files instead of declarations",
        source: "source-fallback",
        value: 0.6,
      });
    }
  }

  if (mode === "source") {
    caveats.push(`Source mode: ${consumerFiles.length} consumer files analyzed`);
  }

  const composites = computeComposites(dimensions, mode);

  // Build globalScores structure
  const globalScores = buildGlobalScores(composites);

  // Compute domainFitScore if domain was detected with sufficient confidence
  let domainScore: DomainScore | undefined;
  let scoreComparability: ScoreComparability = "global";
  if (
    domainInference.domain !== "general" &&
    domainInference.confidence >= 0.5 &&
    domainOpt !== "off"
  ) {
    domainScore = computeDomainScore(
      dimensions,
      domainInference.domain as DomainType,
      domainInference.confidence,
    );
    // Default is always global; domain is additive
    scoreComparability = "global";
  }

  // Run scenario pack if domain was detected with sufficient confidence
  let scenarioScore: import("./types.js").ScenarioScore | undefined;
  if (
    domainInference.domain !== "general" &&
    domainInference.confidence >= 0.5 &&
    domainOpt !== "off"
  ) {
    const pack = getScenarioPack(domainInference.domain as import("./types.js").DomainKey);
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

  const result: AnalysisResult = {
    caveats,
    composites,
    dimensions,
    domainInference,
    domainScore,
    filesAnalyzed,
    globalScores,
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

  // Pass through graph stats from package context
  if (options?.packageContext?.graphStats) {
    result.graphStats = options.packageContext.graphStats;
    const gs = options.packageContext.graphStats;
    result.dedupStats = {
      filesRemoved: gs.filesDeduped,
      groups: Object.values(gs.dedupByStrategy).reduce((a, b) => a + b, 0),
    };
  }

  return result;
}

function buildGlobalScores(composites: import("./types.js").CompositeScore[]): GlobalScores {
  const consumerApi = composites.find((c) => c.key === "consumerApi")!;
  const agentReadiness = composites.find((c) => c.key === "agentReadiness")!;
  const typeSafety = composites.find((c) => c.key === "typeSafety")!;
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
    const adj = domainAdj.find((a) => a.dimension === dim.key);
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
    confidence: domainConfidence,
    domain: domain as import("./types.js").DomainKey,
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
  },
): ExplainabilityReport {
  // Lowest specificity: issues from apiSpecificity
  const specDim = dimensions.find((d) => d.key === "apiSpecificity");
  const lowestSpecificity = (specDim?.issues ?? [])
    .filter((i) => i.severity === "error" || i.severity === "warning")
    .slice(0, 10)
    .map((i) => ({
      file: i.file,
      line: i.line,
      name: i.message,
      score: 0,
    }));

  // Highest specificity: from apiSpecificity positives
  const highestSpecificity = (specDim?.positives ?? []).slice(0, 10).map((p) => ({
    name: p,
    score: specDim?.score ?? 0,
  }));

  // Highest lift: from semantic lift positives
  const liftDim = dimensions.find((d) => d.key === "semanticLift");
  const highestLift = (liftDim?.positives ?? []).slice(0, 10).map((p) => ({
    name: p,
    score: liftDim?.score ?? 0,
  }));

  // Safety leaks: from apiSafety issues
  const safetyDim = dimensions.find((d) => d.key === "apiSafety");
  const safetyLeaks = (safetyDim?.issues ?? [])
    .filter((i) => i.severity === "error")
    .slice(0, 10)
    .map((i) => ({
      file: i.file,
      line: i.line,
      name: i.message,
      score: 0,
    }));

  // Lowest usability: from agentUsability negatives
  const usabilityDim = dimensions.find((d) => d.key === "agentUsability");
  const lowestUsability = (usabilityDim?.negatives ?? []).slice(0, 10).map((n) => ({
    name: n,
    score: usabilityDim?.score ?? 0,
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
  if (domainInference.confidence < 0.5) {
    domainAmbiguities.push({
      confidence: domainInference.confidence,
      domain: domainInference.domain,
    });
  }

  return {
    domainAmbiguities,
    domainSuppressions,
    highestLift,
    highestSpecificity,
    lowestSpecificity,
    lowestUsability,
    safetyLeaks,
  };
}
