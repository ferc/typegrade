import { DIMENSION_CONFIGS, STRICT_FLAGS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import type { Project, SourceFile } from "ts-morph";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "configDiscipline")!;

const STRICT_UMBRELLA_FLAGS = new Set([
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
]);

export function analyzeConfigDiscipline(
  sourceFiles: SourceFile[],
  project: Project,
): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];
  const opts = project.getCompilerOptions();
  const isStrictMode = opts.strict === true;

  let score = 0;

  for (const [flag, points] of Object.entries(STRICT_FLAGS)) {
    const value = opts[flag as keyof typeof opts];
    const enabled = value === true || (isStrictMode && STRICT_UMBRELLA_FLAGS.has(flag));
    if (enabled) {
      score += points;
      positives.push(`${flag}: enabled (+${points})`);
    } else {
      issues.push({
        column: 0,
        dimension: CONFIG.label,
        file: "tsconfig.json",
        line: 0,
        message: `enable ${flag} for +${points} strict score`,
        severity: points >= 10 ? "warning" : "info",
      });
    }
  }

  // Bonus: @ts-expect-error usage over @ts-ignore
  let tsIgnoreCount = 0;
  let tsExpectErrorCount = 0;

  for (const sf of sourceFiles) {
    const fullText = sf.getFullText();
    const lines = fullText.split("\n");
    for (const line of lines) {
      if (line.includes("@ts-ignore")) {
        tsIgnoreCount++;
      }
      if (line.includes("@ts-expect-error")) {
        tsExpectErrorCount++;
      }
    }
  }

  if (tsExpectErrorCount > 0 && tsIgnoreCount === 0) {
    score = Math.min(100, score + 5);
    positives.push("Uses @ts-expect-error over @ts-ignore (+5 bonus)");
  }

  if (tsIgnoreCount > 0) {
    negatives.push(`${tsIgnoreCount} @ts-ignore usage(s)`);
  }

  score = Math.min(100, score);

  return {
    applicability: "applicable",
    applicabilityReasons: [],
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: { isStrictMode, tsExpectErrorCount, tsIgnoreCount },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
