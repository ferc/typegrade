import type { ConfidenceSignal, DimensionResult, Issue, PackageAnalysisContext } from "../types.js";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { Project } from "ts-morph";
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
  const confidenceSignals: ConfidenceSignal[] = [];

  let totalExportedFns = 0;
  let fnsWithExplicitReturn = 0;
  let fnsWithFullyTypedParams = 0;
  let exportedWithJSDoc = 0;
  let totalExportedDecls = 0;
  let overloadCount = 0;

  for (const decl of surface.declarations) {
    totalExportedDecls++;
    if (decl.hasJSDoc) {
      exportedWithJSDoc++;
    }

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
        if (decl.allParamsTyped) {
          fnsWithFullyTypedParams++;
        }
        if ((decl.overloadCount ?? 0) > 0) {
          overloadCount += decl.overloadCount!;
        }
        break;
      }
      case "class": {
        for (const method of decl.methods ?? []) {
          totalExportedFns++;
          if (method.hasJSDoc) {
            exportedWithJSDoc++;
          }
          if (method.hasExplicitReturnType) {
            fnsWithExplicitReturn++;
          }
          if (method.allParamsTyped) {
            fnsWithFullyTypedParams++;
          }
          if (method.overloadCount > 0) {
            overloadCount += method.overloadCount;
          }
        }
        break;
      }
      case "variable": {
        break;
      }
    }
  }

  let score = 0;

  // 35% from explicit return types
  if (totalExportedFns > 0) {
    const returnRatio = fnsWithExplicitReturn / totalExportedFns;
    score += Math.round(returnRatio * 35);
    positives.push(
      `${fnsWithExplicitReturn}/${totalExportedFns} exported functions have explicit return types`,
    );
  } else {
    score += 35;
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

  // Entrypoint clarity: +15 for types/typings field, +10 bonus for exports with types conditions
  let pkgJsonResolved = false;
  let hasExportsWithTypes = false;

  if (packageContext) {
    try {
      const pkg = JSON.parse(readFileSync(packageContext.packageJsonPath, "utf8"));
      pkgJsonResolved = true;
      confidenceSignals.push({
        reason: "package.json resolved",
        source: "metadata-availability",
        value: 1,
      });

      if (pkg.types || pkg.typings) {
        score += 15;
        positives.push("package.json has types/typings field");
      } else {
        negatives.push("package.json missing types/typings field");
      }

      // Check for exports with types conditions
      if (pkg.exports) {
        hasExportsWithTypes = checkExportsHaveTypes(pkg.exports);
        if (hasExportsWithTypes) {
          score += 10;
          positives.push("package.json exports field has types conditions (+10)");
        }
      }
    } catch {
      confidenceSignals.push({
        reason: "package.json parse failed",
        source: "metadata-availability",
        value: 0.5,
      });
    }
  }
  if (!pkgJsonResolved) {
    const tsconfigResult = tryResolvePkgJsonFromTsconfig(project);
    if (tsconfigResult) {
      pkgJsonResolved = true;
      confidenceSignals.push({
        reason: "package.json resolved via tsconfig",
        source: "metadata-availability",
        value: 0.9,
      });
      if (tsconfigResult.hasTypesField) {
        score += 15;
        positives.push("package.json has types/typings field");
      } else {
        negatives.push("package.json missing types/typings field");
      }
      if (tsconfigResult.hasExportsWithTypes) {
        hasExportsWithTypes = true;
        score += 10;
        positives.push("package.json exports field has types conditions (+10)");
      }
    }
    if (!pkgJsonResolved) {
      confidenceSignals.push({
        reason: "no package.json found",
        source: "metadata-availability",
        value: 0.7,
      });
    }
  }

  // +15 for JSDoc coverage
  if (totalExportedDecls > 0) {
    const jsDocRatio = exportedWithJSDoc / totalExportedDecls;
    score += Math.round(jsDocRatio * 15);
    positives.push(`${exportedWithJSDoc}/${totalExportedDecls} exported declarations have JSDoc`);

    // Docs density bonus: >80% JSDoc on exported functions
    if (totalExportedFns > 0) {
      const fnJsDocCount = surface.declarations.filter(
        (decl) => decl.kind === "function" && decl.hasJSDoc,
      ).length;
      const fnJsDocRatio = fnJsDocCount / totalExportedFns;
      if (fnJsDocRatio >= 0.8) {
        score += 5;
        positives.push(`${Math.round(fnJsDocRatio * 100)}% function JSDoc coverage (+5)`);
      }
    }
  }

  score = Math.min(100, score);

  const confidence = pkgJsonResolved ? 1 : 0.7;

  return {
    applicability: "applicable",
    applicabilityReasons: [],
    confidence,
    confidenceSignals,
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      exportedWithJSDoc,
      fnsWithExplicitReturn,
      fnsWithFullyTypedParams,
      hasExportsWithTypes,
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

interface TsconfigPkgResult {
  hasTypesField: boolean;
  hasExportsWithTypes: boolean;
}

function tryResolvePkgJsonFromTsconfig(project: Project): TsconfigPkgResult | undefined {
  const tsconfigPath = project.getCompilerOptions()["configFilePath"];
  if (typeof tsconfigPath !== "string") {
    return undefined;
  }
  const pkgPath = join(dirname(tsconfigPath), "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return {
      hasExportsWithTypes: pkg.exports ? checkExportsHaveTypes(pkg.exports) : false,
      hasTypesField: Boolean(pkg.types || pkg.typings),
    };
  } catch {
    return undefined;
  }
}

function checkExportsHaveTypes(exports: unknown): boolean {
  if (typeof exports !== "object" || exports === null) {
    return false;
  }
  for (const value of Object.values(exports)) {
    if (typeof value === "object" && value !== null) {
      if ("types" in value) {
        return true;
      }
      // Recurse into nested conditions
      if (checkExportsHaveTypes(value)) {
        return true;
      }
    }
  }
  return false;
}
