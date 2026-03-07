import { type Project, type SourceFile, SyntaxKind, Node } from "ts-morph";
import { DIMENSION_CONFIGS, VALIDATION_LIBRARIES } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG = DIMENSION_CONFIGS.find((c) => c.key === "boundaryDiscipline")!;

interface BoundaryFileResult {
  typeGuardCount: number;
  assertFunctionCount: number;
  satisfiesCount: number;
  jsonParseCount: number;
  hasBoundaryMarkers: boolean;
  issues: Issue[];
}

function analyzeSourceFileBoundaries(sf: SourceFile): BoundaryFileResult {
  const issues: Issue[] = [];
  let typeGuardCount = 0;
  let assertFunctionCount = 0;
  let satisfiesCount = 0;
  let jsonParseCount = 0;
  let hasBoundaryMarkers = false;
  const filePath = sf.getFilePath();

  for (const fn of sf.getFunctions()) {
    const returnTypeNode = fn.getReturnTypeNode();
    if (returnTypeNode) {
      const text = returnTypeNode.getText();
      if (text.includes(" is ")) {
        typeGuardCount++;
        hasBoundaryMarkers = true;
      }
      if (text.startsWith("asserts ")) {
        assertFunctionCount++;
        hasBoundaryMarkers = true;
      }
    }
  }

  sf.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.SatisfiesExpression) {
      satisfiesCount++;
      hasBoundaryMarkers = true;
    }

    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isPropertyAccessExpression(expr)) {
        const objText = expr.getExpression().getText();
        const propText = expr.getName();

        if (objText === "JSON" && propText === "parse") {
          jsonParseCount++;
          hasBoundaryMarkers = true;
          issues.push({
            column: node.getStart() - node.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: node.getStartLineNumber(),
            message: "JSON.parse() without runtime validation",
            severity: "warning",
          });
        }
      }
    }
  });

  return { typeGuardCount, assertFunctionCount, satisfiesCount, jsonParseCount, hasBoundaryMarkers, issues };
}

export function analyzeBoundaryDiscipline(
  sourceFiles: SourceFile[],
  project: Project,
): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 0;

  // Check package.json for validation libraries
  const tsconfigPath = project.getCompilerOptions().configFilePath;
  let projectDir: string | undefined;
  if (typeof tsconfigPath === "string") {
    projectDir = dirname(tsconfigPath);
  }

  let hasValidationLib = false;
  if (projectDir) {
    const pkgPath = join(projectDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const lib of VALIDATION_LIBRARIES) {
          if (allDeps[lib]) {
            hasValidationLib = true;
            positives.push(`Validation library found: ${lib}`);
            break;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  if (hasValidationLib) {score += 30;}

  let typeGuardCount = 0;
  let assertFunctionCount = 0;
  let satisfiesCount = 0;
  let jsonParseCount = 0;
  let hasBoundaryMarkers = false;

  for (const sf of sourceFiles) {
    const fileResult = analyzeSourceFileBoundaries(sf);
    typeGuardCount += fileResult.typeGuardCount;
    assertFunctionCount += fileResult.assertFunctionCount;
    satisfiesCount += fileResult.satisfiesCount;
    jsonParseCount += fileResult.jsonParseCount;
    if (fileResult.hasBoundaryMarkers) {hasBoundaryMarkers = true;}
    issues.push(...fileResult.issues);
  }

  // If no boundary markers at all, disable this dimension
  if (!hasBoundaryMarkers && !hasValidationLib) {
    return {
      applicabilityReason: "No I/O boundaries detected in project",
      enabled: false,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: {},
      negatives: [],
      positives: [],
      score: null,
      weights: CONFIG.weights,
    };
  }

  if (typeGuardCount > 0) {
    score += 20;
    positives.push(`${typeGuardCount} type guard function(s)`);
  }
  if (assertFunctionCount > 0) {
    score += 15;
    positives.push(`${assertFunctionCount} assertion function(s)`);
  }
  if (satisfiesCount > 0) {
    score += 10;
    positives.push(`${satisfiesCount} satisfies usage(s)`);
  }

  const jsonParsePenalty = Math.min(jsonParseCount * 5, 25);
  score -= jsonParsePenalty;

  if (jsonParseCount > 0) {
    negatives.push(`${jsonParseCount} JSON.parse() without validation (-${jsonParsePenalty})`);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      typeGuardCount,
      assertFunctionCount,
      satisfiesCount,
      jsonParseCount,
      hasValidationLib,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
