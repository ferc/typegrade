import { Project, Node } from "ts-morph";
import { DEFAULT_WEIGHTS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function analyzeExportQuality(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);

  let totalExportedFns = 0;
  let fnsWithExplicitReturn = 0;
  let fnsWithFullyTypedParams = 0;
  let exportedWithJSDoc = 0;
  let totalExportedDecls = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Exported functions
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      totalExportedFns++;
      totalExportedDecls++;

      // Explicit return type?
      if (fn.getReturnTypeNode()) {
        fnsWithExplicitReturn++;
      } else {
        issues.push({
          file: filePath,
          line: fn.getStartLineNumber(),
          column: fn.getStart() - fn.getStartLinePos() + 1,
          message: `exported ${fn.getName() ?? "function"}() has no explicit return type`,
          severity: "warning",
          dimension: "Export Quality",
        });
      }

      // All params typed?
      const allParamsTyped = fn.getParameters().every((p) => p.getTypeNode());
      if (allParamsTyped) {
        fnsWithFullyTypedParams++;
      }

      // JSDoc?
      if (fn.getJsDocs().length > 0) {
        exportedWithJSDoc++;
      }
    }

    // Exported interfaces
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) continue;
      totalExportedDecls++;
      if (iface.getJsDocs().length > 0) {
        exportedWithJSDoc++;
      }
    }

    // Exported type aliases
    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) continue;
      totalExportedDecls++;
      if (alias.getJsDocs().length > 0) {
        exportedWithJSDoc++;
      }
    }

    // Exported variables
    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) continue;
      totalExportedDecls += varStmt.getDeclarations().length;
      if (varStmt.getJsDocs().length > 0) {
        exportedWithJSDoc += varStmt.getDeclarations().length;
      }
    }
  }

  // Scoring
  let score = 0;

  // 40% from explicit return types
  if (totalExportedFns > 0) {
    score += Math.round((fnsWithExplicitReturn / totalExportedFns) * 40);
    details.push(
      `${fnsWithExplicitReturn}/${totalExportedFns} exported functions have explicit return types`,
    );
  } else {
    score += 40; // No functions = no penalty
  }

  // 30% from fully typed params
  if (totalExportedFns > 0) {
    score += Math.round((fnsWithFullyTypedParams / totalExportedFns) * 30);
    details.push(
      `${fnsWithFullyTypedParams}/${totalExportedFns} exported functions have all params typed`,
    );
  } else {
    score += 30;
  }

  // +15 for types field in package.json
  const tsconfigPath = project.getCompilerOptions().configFilePath;
  if (typeof tsconfigPath === "string") {
    const pkgPath = join(dirname(tsconfigPath), "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.types || pkg.typings) {
          score += 15;
          details.push("package.json has types/typings field");
        }
      } catch {
        // ignore
      }
    }
  }

  // +15 for JSDoc
  if (totalExportedDecls > 0) {
    const jsDocRatio = exportedWithJSDoc / totalExportedDecls;
    score += Math.round(jsDocRatio * 15);
    details.push(
      `${exportedWithJSDoc}/${totalExportedDecls} exported declarations have JSDoc`,
    );
  }

  score = Math.min(100, score);

  return {
    name: "Export Quality",
    score,
    weight: DEFAULT_WEIGHTS.exportQuality,
    details,
    issues,
  };
}
