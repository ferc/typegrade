import type { AnalysisMode, AnalysisResult, DimensionResult, ExplainabilityReport, Issue, PackageAnalysisContext } from "./types.js";
import { type GetSourceFilesOptions, getSourceFiles, loadProject } from "./utils/project-loader.js";
import { basename, resolve } from "node:path";
import { Project } from "ts-morph";
import { analyzeApiSafety } from "./analyzers/api-safety.js";
import { analyzeApiSpecificity } from "./analyzers/api-specificity.js";
import { analyzeBoundaryDiscipline } from "./analyzers/boundary-discipline.js";
import { analyzeConfigDiscipline } from "./analyzers/config-discipline.js";
import { analyzeDeclarationFidelity } from "./analyzers/declaration-fidelity.js";
import { analyzeImplementationSoundness } from "./analyzers/implementation-soundness.js";
import { analyzePublishQuality } from "./analyzers/publish-quality.js";
import { analyzeSemanticLift } from "./analyzers/semantic-lift.js";
import { analyzeSurfaceConsistency } from "./analyzers/surface-consistency.js";
import { analyzeSurfaceComplexity } from "./analyzers/surface-complexity.js";
import { analyzeAgentUsability } from "./analyzers/agent-usability.js";
import { detectDomain } from "./domain.js";
import { computeComposites } from "./scorer.js";
import { extractPublicSurface } from "./surface/index.js";

export interface AnalyzeOptions {
  sourceFilesOptions?: GetSourceFilesOptions;
  mode?: AnalysisMode;
  packageContext?: PackageAnalysisContext;
  /** If provided, only analyze files in this set (post-graph filtering) */
  fileFilter?: Set<string>;
  /** If true, generate explainability report */
  explain?: boolean;
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
        { grade: "N/A", key: "implementationQuality", rationale: ["No files found"], score: null },
      ],
      dimensions: [],
      filesAnalyzed: 0,
      mode,
      projectName,
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
  // In source mode, emit declarations in-memory for consumer-facing analysis
  // In package mode, source files ARE the declarations
  let consumerFiles = sourceFiles;
  const sourceOnlyFiles = sourceFiles;
  const caveats: string[] = [];

  if (mode === "source") {
    try {
      const emitResult = project.emitToMemory({ emitOnlyDtsFiles: true });
      const emittedFiles = emitResult.getFiles();
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
          caveats.push(`Partial declaration emit: ${emittedFiles.length}/${sourceFiles.length} files (${Math.round(emitSuccessRate * 100)}%)`);
        }
      } else {
        caveats.push("Could not emit declarations; consumer analysis uses source files directly");
      }
    } catch {
      caveats.push("Declaration emit failed; consumer analysis uses source files directly");
    }
  }

  // Extract public surface once, shared by all consumer-facing analyzers
  const consumerSurface = extractPublicSurface(consumerFiles);

  // Domain detection
  const domainInference = detectDomain(consumerSurface, options?.packageContext?.packageName);

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

  // Source-only dimensions (5-8)
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
        label: key.replaceAll(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim(),
        metrics: {},
        negatives: [],
        positives: [],
        score: null,
        weights: {},
      });
    }
  }

  const composites = computeComposites(dimensions, mode);

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
    filesAnalyzed,
    mode,
    projectName,
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

function buildExplainability(
  dimensions: DimensionResult[],
  domainInference: { domain: string; confidence: number; signals: string[]; suppressedIssues?: string[] },
): ExplainabilityReport {
  // Lowest specificity: issues from apiSpecificity, sorted by score
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

  // Highest lift: from semantic lift positives
  const liftDim = dimensions.find((d) => d.key === "semanticLift");
  const highestLift = (liftDim?.positives ?? [])
    .slice(0, 10)
    .map((p) => ({
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

  // Domain suppressions
  const domainSuppressions: Array<{ name: string; reason: string }> = [];
  if (domainInference.suppressedIssues) {
    for (const issue of domainInference.suppressedIssues) {
      domainSuppressions.push({
        name: domainInference.domain,
        reason: issue,
      });
    }
  }

  return {
    domainSuppressions,
    highestLift,
    lowestSpecificity,
    safetyLeaks,
  };
}
