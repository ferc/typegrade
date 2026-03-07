import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { SourceFile } from "ts-morph";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSafety")!;

export function analyzeApiSafety(sourceFiles: SourceFile[]): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  let totalPositions = 0;
  let anyPositions = 0;
  let unknownPositions = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Exported functions
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      const fnName = fn.getName() ?? "<anonymous>";

      for (const param of fn.getParameters()) {
        totalPositions++;
        const result = analyzePrecision(param.getType());
        if (result.containsAny) {
          anyPositions++;
          issues.push({
            column: param.getStart() - param.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: param.getStartLineNumber(),
            message: `parameter '${param.getName()}' in ${fnName}() leaks 'any'`,
            severity: "error",
          });
        } else if (result.containsUnknown) {
          unknownPositions++;
          issues.push({
            column: param.getStart() - param.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: param.getStartLineNumber(),
            message: `parameter '${param.getName()}' in ${fnName}() contains 'unknown'`,
            severity: "warning",
          });
        }
      }

      // Return type
      totalPositions++;
      const returnResult = analyzePrecision(fn.getReturnType());
      if (returnResult.containsAny) {
        anyPositions++;
        issues.push({
          column: fn.getStart() - fn.getStartLinePos() + 1,
          dimension: CONFIG.label,
          file: filePath,
          line: fn.getStartLineNumber(),
          message: `${fnName}() return type leaks 'any'`,
          severity: "error",
        });
      } else if (returnResult.containsUnknown) {
        unknownPositions++;
      }
    }

    // Exported interfaces
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      for (const prop of iface.getProperties()) {
        totalPositions++;
        const result = analyzePrecision(prop.getType());
        if (result.containsAny) {
          anyPositions++;
          issues.push({
            column: prop.getStart() - prop.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: prop.getStartLineNumber(),
            message: `property '${prop.getName()}' in ${iface.getName()} leaks 'any'`,
            severity: "error",
          });
        } else if (result.containsUnknown) {
          unknownPositions++;
        }
      }
    }

    // Exported type aliases
    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) {continue;}
      totalPositions++;
      const result = analyzePrecision(alias.getType());
      if (result.containsAny) {
        anyPositions++;
        issues.push({
          column: alias.getStart() - alias.getStartLinePos() + 1,
          dimension: CONFIG.label,
          file: filePath,
          line: alias.getStartLineNumber(),
          message: `type '${alias.getName()}' leaks 'any'`,
          severity: "error",
        });
      } else if (result.containsUnknown) {
        unknownPositions++;
      }
    }

    // Exported variables
    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) {continue;}
      for (const decl of varStmt.getDeclarations()) {
        totalPositions++;
        const result = analyzePrecision(decl.getType());
        if (result.containsAny) {
          anyPositions++;
          issues.push({
            column: decl.getStart() - decl.getStartLinePos() + 1,
            dimension: CONFIG.label,
            file: filePath,
            line: decl.getStartLineNumber(),
            message: `exported '${decl.getName()}' leaks 'any'`,
            severity: "error",
          });
        } else if (result.containsUnknown) {
          unknownPositions++;
        }
      }
    }
  }

  if (totalPositions === 0) {
    return {
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: { anyPositions: 0, totalPositions: 0, unknownPositions: 0 },
      negatives: [],
      positives: ["No exported positions to check"],
      score: 100,
      weights: CONFIG.weights,
    };
  }

  const anyDensity = anyPositions / totalPositions;
  const unknownDensity = unknownPositions / totalPositions;
  const score = Math.max(0, Math.min(100, Math.round(100 - anyDensity * 80 - unknownDensity * 20)));

  if (anyPositions === 0) {positives.push("No 'any' leakage in exported API");}
  if (anyPositions > 0) {negatives.push(`${anyPositions}/${totalPositions} positions leak 'any'`);}
  if (unknownPositions > 0)
    {negatives.push(`${unknownPositions}/${totalPositions} positions contain 'unknown'`);}

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: { anyDensity, anyPositions, totalPositions, unknownDensity, unknownPositions },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
