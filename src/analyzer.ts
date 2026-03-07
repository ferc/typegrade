import { resolve, basename } from "node:path";
import type { AnalysisResult, TsguardConfig, Issue } from "./types.js";
import { DEFAULT_WEIGHTS } from "./constants.js";
import { loadProject, getSourceFiles, type GetSourceFilesOptions } from "./utils/project-loader.js";
import { computeOverallScore, computeGrade, computeAiReadiness } from "./scorer.js";
import { analyzeStrictConfig } from "./analyzers/strict-config.js";
import { analyzeTypeCoverage } from "./analyzers/type-coverage.js";
import { analyzeTypePrecision } from "./analyzers/type-precision.js";
import { analyzeUnsoundness } from "./analyzers/unsoundness.js";
import { analyzeRuntimeValidation } from "./analyzers/runtime-validation.js";
import { analyzeExportQuality } from "./analyzers/export-quality.js";

export function analyzeProject(
  projectPath: string,
  config?: Partial<TsguardConfig>,
  sourceFilesOptions?: GetSourceFilesOptions,
): AnalysisResult {
  const startTime = performance.now();
  const absolutePath = resolve(projectPath);
  const projectName = basename(absolutePath);

  const project = loadProject(absolutePath);
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);
  const filesAnalyzed = sourceFiles.length;

  // Run all 6 analyzers
  const dimensions = [
    analyzeTypePrecision(project, sourceFilesOptions),
    analyzeTypeCoverage(project, sourceFilesOptions),
    analyzeStrictConfig(project, sourceFilesOptions),
    analyzeUnsoundness(project, sourceFilesOptions),
    analyzeExportQuality(project, sourceFilesOptions),
    analyzeRuntimeValidation(project, sourceFilesOptions),
  ];

  // Apply custom weights if provided
  if (config?.weights) {
    const weightMap: Record<string, number> = {
      "Type Precision": config.weights.typePrecision ?? DEFAULT_WEIGHTS.typePrecision,
      "Type Coverage": config.weights.typeCoverage ?? DEFAULT_WEIGHTS.typeCoverage,
      "Strict Config": config.weights.strictConfig ?? DEFAULT_WEIGHTS.strictConfig,
      Unsoundness: config.weights.unsoundness ?? DEFAULT_WEIGHTS.unsoundness,
      "Export Quality": config.weights.exportQuality ?? DEFAULT_WEIGHTS.exportQuality,
      "Runtime Validation":
        config.weights.runtimeValidation ?? DEFAULT_WEIGHTS.runtimeValidation,
    };
    for (const dim of dimensions) {
      if (weightMap[dim.name] !== undefined) {
        dim.weight = weightMap[dim.name];
      }
    }
  }

  const overallScore = computeOverallScore(dimensions);
  const grade = computeGrade(overallScore);
  const aiReadiness = computeAiReadiness(overallScore);

  // Collect top issues sorted by severity
  const allIssues: Issue[] = dimensions.flatMap((d) => d.issues);
  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const topIssues = allIssues
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, 10);

  const timeMs = Math.round(performance.now() - startTime);

  return {
    projectName,
    filesAnalyzed,
    timeMs,
    overallScore,
    grade,
    dimensions,
    topIssues,
    aiReadiness,
  };
}
