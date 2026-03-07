import { Project, SyntaxKind, TypeFlags, Node } from "ts-morph";
import { DEFAULT_WEIGHTS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";

export function analyzeUnsoundness(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    sf.forEachDescendant((node) => {
      // Type assertions: `as SomeType`
      if (Node.isAsExpression(node)) {
        const targetType = node.getType();
        const line = node.getStartLineNumber();
        const col = node.getStart() - node.getStartLinePos() + 1;

        // Check for `as any`
        if (targetType.getFlags() & TypeFlags.Any) {
          errorCount++;
          issues.push({
            file: filePath,
            line,
            column: col,
            message: "type assertion to 'any' (as any)",
            severity: "error",
            dimension: "Unsoundness",
          });
          return;
        }

        // Check for double assertion: `as unknown as X`
        const child = node.getExpression();
        if (Node.isAsExpression(child)) {
          errorCount++;
          issues.push({
            file: filePath,
            line,
            column: col,
            message: "double type assertion (as unknown as X)",
            severity: "error",
            dimension: "Unsoundness",
          });
          return;
        }

        // Regular `as SomeType`
        warningCount++;
        issues.push({
          file: filePath,
          line,
          column: col,
          message: `type assertion: as ${targetType.getText().slice(0, 50)}`,
          severity: "warning",
          dimension: "Unsoundness",
        });
      }

      // Non-null assertion: `value!`
      if (Node.isNonNullExpression(node)) {
        warningCount++;
        const line = node.getStartLineNumber();
        const col = node.getStart() - node.getStartLinePos() + 1;
        issues.push({
          file: filePath,
          line,
          column: col,
          message: "non-null assertion (value!)",
          severity: "warning",
          dimension: "Unsoundness",
        });
      }
    });

    // Check comments for @ts-ignore and @ts-expect-error
    const fullText = sf.getFullText();
    const lines = fullText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("@ts-ignore")) {
        errorCount++;
        issues.push({
          file: filePath,
          line: i + 1,
          column: line.indexOf("@ts-ignore") + 1,
          message: "@ts-ignore (prefer @ts-expect-error)",
          severity: "error",
          dimension: "Unsoundness",
        });
      }
      if (line.includes("@ts-expect-error")) {
        infoCount++;
        issues.push({
          file: filePath,
          line: i + 1,
          column: line.indexOf("@ts-expect-error") + 1,
          message: "@ts-expect-error (acceptable)",
          severity: "info",
          dimension: "Unsoundness",
        });
      }
    }
  }

  // Scoring: penalties normalized by project size
  const penaltyPerError = 2.0;
  const penaltyPerWarning = 0.5;
  const penaltyPerInfo = 0.1;

  const rawPenalty =
    errorCount * penaltyPerError +
    warningCount * penaltyPerWarning +
    infoCount * penaltyPerInfo;

  const maxPenalty = Math.max(sourceFiles.length * 10, 1);
  const score = Math.max(0, Math.round(100 - (rawPenalty / maxPenalty) * 100));

  details.push(`${errorCount} errors, ${warningCount} warnings, ${infoCount} info`);
  details.push(`Penalty: ${rawPenalty.toFixed(1)} / ${maxPenalty} max`);

  return {
    name: "Unsoundness",
    score,
    weight: DEFAULT_WEIGHTS.unsoundness,
    details,
    issues,
  };
}
