import type { AnalysisMode, AnalysisResult, DimensionResult, Issue } from "./types.js";
import { type GetSourceFilesOptions, getSourceFiles, loadProject } from "./utils/project-loader.js";
import { basename, resolve } from "node:path";
import { Project } from "ts-morph";
import { analyzeApiExpressiveness } from "./analyzers/api-expressiveness.js";
import { analyzeApiSafety } from "./analyzers/api-safety.js";
import { analyzeApiSpecificity } from "./analyzers/api-specificity.js";
import { analyzeBoundaryDiscipline } from "./analyzers/boundary-discipline.js";
import { analyzeConfigDiscipline } from "./analyzers/config-discipline.js";
import { analyzeDeclarationFidelity } from "./analyzers/declaration-fidelity.js";
import { analyzeImplementationSoundness } from "./analyzers/implementation-soundness.js";
import { analyzePublishQuality } from "./analyzers/publish-quality.js";
import { computeComposites } from "./scorer.js";

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
  const dimensions: DimensionResult[] = [
    analyzeApiSpecificity(consumerFiles),
    analyzeApiSafety(consumerFiles),
    analyzeApiExpressiveness(consumerFiles),
    analyzePublishQuality(consumerFiles, project),
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
        label: key.replaceAll(/([A-Z])/g, " $1").trim(),
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
