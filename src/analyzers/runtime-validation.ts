import { Project, SyntaxKind, Node } from "ts-morph";
import { DEFAULT_WEIGHTS, VALIDATION_LIBRARIES } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function analyzeRuntimeValidation(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);

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
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        for (const lib of VALIDATION_LIBRARIES) {
          if (allDeps[lib]) {
            hasValidationLib = true;
            details.push(`Validation library found: ${lib}`);
            break;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (hasValidationLib) {
    score += 30;
  }

  // Count type guards, assertion functions, satisfies usage
  let typeGuardCount = 0;
  let assertFunctionCount = 0;
  let satisfiesCount = 0;
  let jsonParseCount = 0;
  let fetchWithoutValidationCount = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Check for type guard functions (return type with `is` predicate)
    for (const fn of sf.getFunctions()) {
      const returnTypeNode = fn.getReturnTypeNode();
      if (returnTypeNode) {
        const text = returnTypeNode.getText();
        if (text.includes(" is ")) {
          typeGuardCount++;
        }
        if (text.startsWith("asserts ")) {
          assertFunctionCount++;
        }
      }
    }

    // Walk AST for satisfies and JSON.parse
    sf.forEachDescendant((node) => {
      // Satisfies expressions
      if (node.getKind() === SyntaxKind.SatisfiesExpression) {
        satisfiesCount++;
      }

      // JSON.parse without validation
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const objText = expr.getExpression().getText();
          const propText = expr.getName();

          if (objText === "JSON" && propText === "parse") {
            jsonParseCount++;
            issues.push({
              file: filePath,
              line: node.getStartLineNumber(),
              column: node.getStart() - node.getStartLinePos() + 1,
              message: "JSON.parse() without runtime validation",
              severity: "warning",
              dimension: "Runtime Validation",
            });
          }
        }
      }
    });
  }

  if (typeGuardCount > 0) {
    score += 20;
    details.push(`${typeGuardCount} type guard function(s)`);
  }
  if (assertFunctionCount > 0) {
    score += 15;
    details.push(`${assertFunctionCount} assertion function(s)`);
  }
  if (satisfiesCount > 0) {
    score += 10;
    details.push(`${satisfiesCount} satisfies usage(s)`);
  }

  // Penalties
  const jsonParsePenalty = Math.min(jsonParseCount * 5, 25);
  const fetchPenalty = Math.min(fetchWithoutValidationCount * 5, 25);
  score -= jsonParsePenalty + fetchPenalty;

  if (jsonParseCount > 0) {
    details.push(
      `${jsonParseCount} JSON.parse() without validation (-${jsonParsePenalty})`,
    );
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: "Runtime Validation",
    score,
    weight: DEFAULT_WEIGHTS.runtimeValidation,
    details,
    issues,
  };
}
