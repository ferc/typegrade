import { type Project, type SourceFile } from "ts-morph";
import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG = DIMENSION_CONFIGS.find((c) => c.key === "publishQuality")!;

export function analyzePublishQuality(
  sourceFiles: SourceFile[],
  project: Project,
): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  let totalExportedFns = 0;
  let fnsWithExplicitReturn = 0;
  let fnsWithFullyTypedParams = 0;
  let exportedWithJSDoc = 0;
  let totalExportedDecls = 0;
  let overloadCount = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      totalExportedFns++;
      totalExportedDecls++;

      if (fn.getReturnTypeNode()) {
        fnsWithExplicitReturn++;
      } else {
        issues.push({
          column: fn.getStart() - fn.getStartLinePos() + 1,
          dimension: CONFIG.label,
          file: filePath,
          line: fn.getStartLineNumber(),
          message: `exported ${fn.getName() ?? "function"}() has no explicit return type`,
          severity: "warning",
        });
      }

      const allParamsTyped = fn.getParameters().every((p) => p.getTypeNode());
      if (allParamsTyped) {fnsWithFullyTypedParams++;}

      if (fn.getJsDocs().length > 0) {exportedWithJSDoc++;}

      const overloads = fn.getOverloads();
      if (overloads.length > 0) {overloadCount += overloads.length;}
    }

    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      totalExportedDecls++;
      if (iface.getJsDocs().length > 0) {exportedWithJSDoc++;}
    }

    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) {continue;}
      totalExportedDecls++;
      if (alias.getJsDocs().length > 0) {exportedWithJSDoc++;}
    }

    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) {continue;}
      totalExportedDecls += varStmt.getDeclarations().length;
      if (varStmt.getJsDocs().length > 0) {
        exportedWithJSDoc += varStmt.getDeclarations().length;
      }
    }
  }

  let score = 0;

  // 40% from explicit return types
  if (totalExportedFns > 0) {
    const returnRatio = fnsWithExplicitReturn / totalExportedFns;
    score += Math.round(returnRatio * 40);
    positives.push(
      `${fnsWithExplicitReturn}/${totalExportedFns} exported functions have explicit return types`,
    );
  } else {
    score += 40;
  }

  // 20% from fully typed params
  if (totalExportedFns > 0) {
    const paramRatio = fnsWithFullyTypedParams / totalExportedFns;
    score += Math.round(paramRatio * 20);
    positives.push(
      `${fnsWithFullyTypedParams}/${totalExportedFns} exported functions have all params typed`,
    );
  } else {
    score += 20;
  }

  // +15 for types field in package.json
  const tsconfigPath = project.getCompilerOptions().configFilePath;
  if (typeof tsconfigPath === "string") {
    const pkgPath = join(dirname(tsconfigPath), "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.types || pkg.typings) {
          score += 15;
          positives.push("package.json has types/typings field");
        } else {
          negatives.push("package.json missing types/typings field");
        }
      } catch {
        // Ignore
      }
    }
  }

  // +15 for JSDoc
  if (totalExportedDecls > 0) {
    const jsDocRatio = exportedWithJSDoc / totalExportedDecls;
    score += Math.round(jsDocRatio * 15);
    positives.push(`${exportedWithJSDoc}/${totalExportedDecls} exported declarations have JSDoc`);
  }

  // +10 for overloads
  if (overloadCount > 0) {
    score += Math.min(10, overloadCount * 3);
    positives.push(`${overloadCount} function overload(s)`);
  }

  score = Math.min(100, score);

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      totalExportedFns,
      fnsWithExplicitReturn,
      fnsWithFullyTypedParams,
      exportedWithJSDoc,
      totalExportedDecls,
      overloadCount,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
