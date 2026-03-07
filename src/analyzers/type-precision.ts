import { Project, Node, SyntaxKind, Type } from "ts-morph";
import { DEFAULT_WEIGHTS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";
import { classifyTypePrecision, getPrecisionScore } from "../utils/type-utils.js";

export function analyzeTypePrecision(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);

  const scores: number[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Analyze exported functions
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const fnName = fn.getName() ?? "<anonymous>";

      // Score parameters
      for (const param of fn.getParameters()) {
        const type = param.getType();
        const level = classifyTypePrecision(type);
        const precScore = getPrecisionScore(level);
        scores.push(precScore);

        if (precScore <= 35) {
          issues.push({
            file: filePath,
            line: param.getStartLineNumber(),
            column: param.getStart() - param.getStartLinePos() + 1,
            message: `parameter '${param.getName()}' in ${fnName}() has ${level} type (${type.getText()})`,
            severity: precScore === 0 ? "error" : "warning",
            dimension: "Type Precision",
          });
        }
      }

      // Score return type
      const returnType = fn.getReturnType();
      const returnLevel = classifyTypePrecision(returnType);
      const returnScore = getPrecisionScore(returnLevel);
      scores.push(returnScore);

      if (returnScore <= 35) {
        issues.push({
          file: filePath,
          line: fn.getStartLineNumber(),
          column: fn.getStart() - fn.getStartLinePos() + 1,
          message: `${fnName}() has ${returnLevel} return type (${returnType.getText()})`,
          severity: returnScore === 0 ? "error" : "warning",
          dimension: "Type Precision",
        });
      }
    }

    // Analyze exported interfaces and type aliases
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) continue;
      for (const prop of iface.getProperties()) {
        const type = prop.getType();
        const level = classifyTypePrecision(type);
        scores.push(getPrecisionScore(level));
      }
    }

    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) continue;
      const type = alias.getType();
      const level = classifyTypePrecision(type);
      scores.push(getPrecisionScore(level));
    }

    // Analyze exported variables
    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) continue;
      for (const decl of varStmt.getDeclarations()) {
        const type = decl.getType();
        const level = classifyTypePrecision(type);
        const precScore = getPrecisionScore(level);
        scores.push(precScore);

        if (precScore <= 35) {
          issues.push({
            file: filePath,
            line: decl.getStartLineNumber(),
            column: decl.getStart() - decl.getStartLinePos() + 1,
            message: `exported '${decl.getName()}' has ${level} type (${type.getText()})`,
            severity: precScore === 0 ? "error" : "warning",
            dimension: "Type Precision",
          });
        }
      }
    }
  }

  const avgScore =
    scores.length === 0
      ? 0
      : Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  details.push(`${scores.length} exported type positions analyzed`);
  details.push(`Average precision score: ${avgScore}/100`);

  return {
    name: "Type Precision",
    score: avgScore,
    weight: DEFAULT_WEIGHTS.typePrecision,
    details,
    issues,
  };
}
