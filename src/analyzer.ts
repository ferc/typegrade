import { basename, resolve } from "node:path";
import { Project } from "ts-morph";
import type { AnalysisMode, AnalysisResult, DimensionResult, Issue } from "./types.js";
import { type GetSourceFilesOptions, getSourceFiles, loadProject } from "./utils/project-loader.js";
import { computeComposites } from "./scorer.js";
import { analyzeApiSpecificity } from "./analyzers/api-specificity.js";
import { analyzeApiSafety } from "./analyzers/api-safety.js";
import { analyzeApiExpressiveness } from "./analyzers/api-expressiveness.js";
import { analyzePublishQuality } from "./analyzers/publish-quality.js";
import { analyzeDeclarationFidelity } from "./analyzers/declaration-fidelity.js";
import { analyzeImplementationSoundness } from "./analyzers/implementation-soundness.js";
import { analyzeBoundaryDiscipline } from "./analyzers/boundary-discipline.js";
import { analyzeConfigDiscipline } from "./analyzers/config-discipline.js";

export interface AnalyzeOptions {
  sourceFilesOptions?: GetSourceFilesOptions;
  mode?: AnalysisMode;
}

export function analyzeProject(projectPath: string, options?: AnalyzeOptions): AnalysisResult {
  const startTime = performance.now();
  const absolutePath = resolve(projectPath);
  const projectName = basename(absolutePath);
  const sourceFilesOptions = options?.sourceFilesOptions;
  const isPackageMode = options?.mode === "package" || sourceFilesOptions?.includeDts === true;
  const mode: AnalysisMode = isPackageMode ? "package" : "source";

  const project = loadProject(absolutePath);
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);
  const filesAnalyzed = sourceFiles.length;

  // No source files -> score 0
  if (filesAnalyzed === 0) {
    const timeMs = Math.round(performance.now() - startTime);
    return {
      caveats: [],
      composites: [
        { key: "agentReadiness", score: 0, grade: "N/A", rationale: ["No files found"] },
        { key: "consumerApi", score: 0, grade: "N/A", rationale: ["No files found"] },
        { key: "implementationQuality", score: null, grade: "N/A", rationale: ["No files found"] },
      ],
      dimensions: [],
      filesAnalyzed: 0,
      mode,
      projectName,
      scoreProfile: isPackageMode ? "published-declarations" : "source-project",
      timeMs,
      topIssues: [
        {
          file: absolutePath,
          line: 0,
          column: 0,
          message: "No source files found to analyze",
          severity: "error",
          dimension: "General",
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
        const dtsProject = new Project({
          compilerOptions: { module: 99, skipLibCheck: true, strict: true, target: 2 },
          useInMemoryFileSystem: true,
        });
        for (const file of emittedFiles) {
          dtsProject.createSourceFile(file.filePath, file.text);
        }
        consumerFiles = dtsProject.getSourceFiles();
      } else {
        caveats.push("Could not emit declarations; consumer analysis uses source files directly");
      }
    } catch {
      caveats.push("Declaration emit failed; consumer analysis uses source files directly");
    }
  }

  // Run consumer-facing dimensions (1-4) against consumer view
  const dimensions: DimensionResult[] = [];

  dimensions.push(analyzeApiSpecificity(consumerFiles));
  dimensions.push(analyzeApiSafety(consumerFiles));
  dimensions.push(analyzeApiExpressiveness(consumerFiles));
  dimensions.push(analyzePublishQuality(consumerFiles, project));

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
        label: key.replace(/([A-Z])/g, " $1").trim(),
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
  const allIssues: Issue[] = dimensions.flatMap((d) => d.issues);
  const severityOrder: Record<string, number> = { error: 0, info: 2, warning: 1 };
  const topIssues = allIssues
    .toSorted((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, 10);

  const timeMs = Math.round(performance.now() - startTime);

  return {
    caveats,
    composites,
    dimensions,
    filesAnalyzed,
    mode,
    projectName,
    scoreProfile: isPackageMode ? "published-declarations" : "source-project",
    timeMs,
    topIssues,
  };
}
