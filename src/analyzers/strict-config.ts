import { Project, SyntaxKind } from "ts-morph";
import { STRICT_FLAGS } from "../constants.js";
import { DEFAULT_WEIGHTS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";

// Flags that `strict: true` enables implicitly
const STRICT_UMBRELLA_FLAGS = new Set([
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
]);

export function analyzeStrictConfig(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const opts = project.getCompilerOptions();
  const isStrictMode = opts.strict === true;

  let score = 0;

  // Score each strict flag
  for (const [flag, points] of Object.entries(STRICT_FLAGS)) {
    const value = opts[flag as keyof typeof opts];
    // Flag is enabled if explicitly true, OR if strict: true and it's a strict umbrella flag
    const enabled = value === true || (isStrictMode && STRICT_UMBRELLA_FLAGS.has(flag));
    if (enabled) {
      score += points;
      details.push(`${flag}: enabled (+${points})`);
    } else {
      issues.push({
        file: "tsconfig.json",
        line: 0,
        column: 0,
        message: `enable ${flag} for +${points} strict score`,
        severity: points >= 10 ? "warning" : "info",
        dimension: "Strict Config",
      });
    }
  }

  // Bonus: check @ts-expect-error usage over @ts-ignore
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);
  let tsIgnoreCount = 0;
  let tsExpectErrorCount = 0;

  for (const sf of sourceFiles) {
    const fullText = sf.getFullText();
    const lines = fullText.split("\n");
    for (const line of lines) {
      if (line.includes("@ts-ignore")) tsIgnoreCount++;
      if (line.includes("@ts-expect-error")) tsExpectErrorCount++;
    }
  }

  if (tsExpectErrorCount > 0 && tsIgnoreCount === 0) {
    score = Math.min(100, score + 5);
    details.push(
      `Uses @ts-expect-error over @ts-ignore (+5 bonus)`,
    );
  }

  score = Math.min(100, score);

  return {
    name: "Strict Config",
    score,
    weight: DEFAULT_WEIGHTS.strictConfig,
    details,
    issues,
  };
}
