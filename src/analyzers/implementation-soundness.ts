import { type AsExpression, Node, type SourceFile, SyntaxKind, TypeFlags } from "ts-morph";
import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "implementationSoundness")!;

/**
 * Detect safe type assertions that are not unsoundness signals:
 * - `as const` — literal narrowing
 * - `as readonly [...]` — readonly tuple narrowing from const arrays
 * - `"literal" as const` — string literal narrowing
 * - `[] as Type[]` — empty array with explicit element type
 * - Assertions to a string literal union member (narrowing, not widening)
 */
function isSafeAssertion(node: AsExpression): boolean {
  const typeNode = node.getTypeNode();
  if (!typeNode) {
    return false;
  }

  const typeText = typeNode.getText();

  // `as const` is always safe
  if (typeText === "const") {
    return true;
  }

  // `as readonly [...]` — readonly tuple narrowing
  if (typeText.startsWith("readonly [")) {
    return true;
  }

  // Empty array literal with type annotation: `[] as string[]`, `[] as Foo[]`
  const expr = node.getExpression();
  if (Node.isArrayLiteralExpression(expr) && expr.getElements().length === 0) {
    return true;
  }

  // Narrowing to a string/number literal type from a union context:
  // E.g. `"general" as const` or `value as "undersampled"` where the target is a literal
  const targetKind = typeNode.getKind();
  if (targetKind === SyntaxKind.LiteralType) {
    // Assertion to a single literal type — this narrows, not widens
    return true;
  }

  return false;
}

interface FileAnalysisResult {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: Issue[];
}

function analyzeSourceFile(sf: SourceFile): FileAnalysisResult {
  const issues: Issue[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const filePath = sf.getFilePath();
  const handledPositions = new Set<number>();

  sf.forEachDescendant((node) => {
    if (Node.isAsExpression(node)) {
      if (handledPositions.has(node.getStart())) {
        return;
      }

      const targetType = node.getType();
      const line = node.getStartLineNumber();
      const col = node.getStart() - node.getStartLinePos() + 1;

      // Skip safe patterns: `as const`, literal narrowing, empty array typing
      if (isSafeAssertion(node)) {
        return;
      }

      if (targetType.getFlags() & TypeFlags.Any) {
        errorCount++;
        issues.push({
          column: col,
          dimension: CONFIG.label,
          file: filePath,
          line,
          message: "type assertion to 'any' (as any)",
          severity: "error",
        });
        return;
      }

      const child = node.getExpression();
      if (Node.isAsExpression(child)) {
        handledPositions.add(child.getStart());
        errorCount++;
        issues.push({
          column: col,
          dimension: CONFIG.label,
          file: filePath,
          line,
          message: "double type assertion (as unknown as X)",
          severity: "error",
        });
        return;
      }

      warningCount++;
      issues.push({
        column: col,
        dimension: CONFIG.label,
        file: filePath,
        line,
        message: `type assertion: as ${targetType.getText().slice(0, 50)}`,
        severity: "warning",
      });
    }

    if (Node.isNonNullExpression(node)) {
      warningCount++;
      const line = node.getStartLineNumber();
      const col = node.getStart() - node.getStartLinePos() + 1;
      issues.push({
        column: col,
        dimension: CONFIG.label,
        file: filePath,
        line,
        message: "non-null assertion (value!)",
        severity: "warning",
      });
    }
  });

  const fullText = sf.getFullText();
  const lines = fullText.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line === undefined) {
      continue;
    }
    if (line.includes("@ts-ignore")) {
      errorCount++;
      issues.push({
        column: line.indexOf("@ts-ignore") + 1,
        dimension: CONFIG.label,
        file: filePath,
        line: lineIdx + 1,
        message: "@ts-ignore (prefer @ts-expect-error)",
        severity: "error",
      });
    }
    if (line.includes("@ts-expect-error")) {
      infoCount++;
      issues.push({
        column: line.indexOf("@ts-expect-error") + 1,
        dimension: CONFIG.label,
        file: filePath,
        line: lineIdx + 1,
        message: "@ts-expect-error (acceptable)",
        severity: "info",
      });
    }
  }

  return { errorCount, infoCount, issues, warningCount };
}

export function analyzeImplementationSoundness(sourceFiles: SourceFile[]): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const sf of sourceFiles) {
    const fileResult = analyzeSourceFile(sf);
    errorCount += fileResult.errorCount;
    warningCount += fileResult.warningCount;
    infoCount += fileResult.infoCount;
    issues.push(...fileResult.issues);
  }

  const penaltyPerError = 2;
  const penaltyPerWarning = 0.5;
  const penaltyPerInfo = 0.1;

  const rawPenalty =
    errorCount * penaltyPerError + warningCount * penaltyPerWarning + infoCount * penaltyPerInfo;

  const maxPenalty = Math.max(sourceFiles.length * 10, 1);
  const score = Math.max(0, Math.round(100 - (rawPenalty / maxPenalty) * 100));

  if (errorCount === 0 && warningCount === 0) {
    positives.push("No type assertions or unsafe patterns");
  }
  if (errorCount > 0) {
    negatives.push(`${errorCount} error-level unsoundness issues`);
  }
  if (warningCount > 0) {
    negatives.push(`${warningCount} warning-level assertions`);
  }

  return {
    applicability: "applicable",
    applicabilityReasons: [],
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: { errorCount, infoCount, maxPenalty, rawPenalty, warningCount },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
