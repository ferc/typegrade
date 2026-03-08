import type { DimensionResult, Issue, PackageAnalysisContext } from "../types.js";
import type { Project } from "ts-morph";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "publishQuality")!;

export function analyzePublishQuality(
  surface: PublicSurface,
  project: Project,
  packageContext?: PackageAnalysisContext,
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

  for (const decl of surface.declarations) {
    totalExportedDecls++;
    if (decl.hasJSDoc) {exportedWithJSDoc++;}

    switch (decl.kind) {
      case "function": {
        totalExportedFns++;
        if (decl.hasExplicitReturnType) {
          fnsWithExplicitReturn++;
        } else {
          issues.push({
            column: decl.positions[0]?.column ?? 1,
            dimension: CONFIG.label,
            file: decl.filePath,
            line: decl.line,
            message: `exported ${decl.name}() has no explicit return type`,
            severity: "warning",
          });
        }
        if (decl.allParamsTyped) {fnsWithFullyTypedParams++;}
        if ((decl.overloadCount ?? 0) > 0) {overloadCount += decl.overloadCount!;}
        break;
      }
      case "class": {
        // Class methods count as exported functions
        for (const method of decl.methods ?? []) {
          totalExportedFns++;
          if (method.hasJSDoc) {exportedWithJSDoc++;}
          if (method.hasExplicitReturnType) {fnsWithExplicitReturn++;}
          if (method.allParamsTyped) {fnsWithFullyTypedParams++;}
          if (method.overloadCount > 0) {overloadCount += method.overloadCount;}
        }
        break;
      }
      case "variable": {
        // Variable declarations inherit JSDoc from the statement.
        // Already counted above via decl.hasJSDoc.
        // But variables can have multiple declarations per statement that all
        // share JSDoc — already handled by sampler (each decl gets stmt JSDoc).
        break;
      }
      // interface, type-alias, enum: just counted + JSDoc above
    }
  }

  let score = 0;

  // 45% from explicit return types
  if (totalExportedFns > 0) {
    const returnRatio = fnsWithExplicitReturn / totalExportedFns;
    score += Math.round(returnRatio * 45);
    positives.push(
      `${fnsWithExplicitReturn}/${totalExportedFns} exported functions have explicit return types`,
    );
  } else {
    score += 45;
  }

  // 25% from fully typed params
  if (totalExportedFns > 0) {
    const paramRatio = fnsWithFullyTypedParams / totalExportedFns;
    score += Math.round(paramRatio * 25);
    positives.push(
      `${fnsWithFullyTypedParams}/${totalExportedFns} exported functions have all params typed`,
    );
  } else {
    score += 25;
  }

  // +15 for types field in package.json
  let pkgJsonResolved = false;
  if (packageContext) {
    try {
      const pkg = JSON.parse(readFileSync(packageContext.packageJsonPath, "utf8"));
      pkgJsonResolved = true;
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
  if (!pkgJsonResolved) {
    const tsconfigPath = project.getCompilerOptions()['configFilePath'];
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
  }

  // +15 for JSDoc
  if (totalExportedDecls > 0) {
    const jsDocRatio = exportedWithJSDoc / totalExportedDecls;
    score += Math.round(jsDocRatio * 15);
    positives.push(`${exportedWithJSDoc}/${totalExportedDecls} exported declarations have JSDoc`);
  }

  score = Math.min(100, score);

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      exportedWithJSDoc,
      fnsWithExplicitReturn,
      fnsWithFullyTypedParams,
      overloadCount,
      totalExportedDecls,
      totalExportedFns,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
