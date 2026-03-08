import type { DimensionResult, Issue } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import { Node, type SourceFile } from "ts-morph";
import { analyzePrecision } from "../utils/type-utils.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "declarationFidelity")!;

export function analyzeDeclarationFidelity(
  sourceFiles: SourceFile[],
  declarationFiles: SourceFile[],
): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  // Collect exported symbols from source with type parameter info
  interface SourceExportInfo {
    file: string;
    line: number;
    typeParamCount: number;
    hasConstraints: boolean;
  }
  const sourceExports = new Map<string, SourceExportInfo>();
  for (const sf of sourceFiles) {
    for (const exp of sf.getExportedDeclarations()) {
      const [name, decls] = exp;
      for (const decl of decls) {
        let typeParamCount = 0;
        let hasConstraints = false;
        if (
          Node.isFunctionDeclaration(decl) ||
          Node.isInterfaceDeclaration(decl) ||
          Node.isTypeAliasDeclaration(decl) ||
          Node.isClassDeclaration(decl)
        ) {
          const typeParams = decl.getTypeParameters();
          typeParamCount = typeParams.length;
          hasConstraints = typeParams.some((tp) => tp.getConstraint() !== undefined);
        }
        sourceExports.set(name, {
          file: sf.getFilePath(),
          hasConstraints,
          line: decl.getStartLineNumber(),
          typeParamCount,
        });
      }
    }
  }

  // Collect exported symbols from declarations with type parameter info
  interface DeclExportInfo {
    typeParamCount: number;
    hasConstraints: boolean;
  }
  const declExports = new Map<string, DeclExportInfo>();
  for (const sf of declarationFiles) {
    for (const [name, decls] of sf.getExportedDeclarations()) {
      for (const decl of decls) {
        let typeParamCount = 0;
        let hasConstraints = false;
        if (
          Node.isFunctionDeclaration(decl) ||
          Node.isInterfaceDeclaration(decl) ||
          Node.isTypeAliasDeclaration(decl) ||
          Node.isClassDeclaration(decl)
        ) {
          const typeParams = decl.getTypeParameters();
          typeParamCount = typeParams.length;
          hasConstraints = typeParams.some((tp) => tp.getConstraint() !== undefined);
        }
        declExports.set(name, { hasConstraints, typeParamCount });
      }
    }
  }

  let penalties = 0;

  // Check for lost exports
  let lostExports = 0;
  for (const [name, loc] of sourceExports) {
    if (!declExports.has(name)) {
      lostExports++;
      penalties += 5;
      issues.push({
        column: 0,
        dimension: CONFIG.label,
        file: loc.file,
        line: loc.line,
        message: `exported '${name}' not found in declarations`,
        severity: "warning",
      });
    }
  }

  if (lostExports > 0) {
    negatives.push(`${lostExports} exported symbol(s) missing from declarations`);
  }

  // Check for generic parameter count differences and constraint loss
  let genericLoss = 0;
  let constraintLoss = 0;
  for (const [name, srcInfo] of sourceExports) {
    const declInfo = declExports.get(name);
    if (!declInfo) {
      continue;
    }

    if (srcInfo.typeParamCount > 0 && declInfo.typeParamCount < srcInfo.typeParamCount) {
      genericLoss++;
      penalties += 5;
      issues.push({
        column: 0,
        dimension: CONFIG.label,
        file: srcInfo.file,
        line: srcInfo.line,
        message: `'${name}' lost generic parameters (source: ${srcInfo.typeParamCount}, declaration: ${declInfo.typeParamCount})`,
        severity: "warning",
      });
    }

    if (srcInfo.hasConstraints && !declInfo.hasConstraints) {
      constraintLoss++;
      penalties += 3;
      issues.push({
        column: 0,
        dimension: CONFIG.label,
        file: srcInfo.file,
        line: srcInfo.line,
        message: `'${name}' lost generic constraints in declaration`,
        severity: "info",
      });
    }
  }

  if (genericLoss > 0) {
    negatives.push(`${genericLoss} export(s) lost generic parameters in declarations`);
  }
  if (constraintLoss > 0) {
    negatives.push(`${constraintLoss} export(s) lost generic constraints in declarations`);
  }

  // Check for any/unknown leakage in declarations not present in source
  let anyLeakage = 0;
  for (const sf of declarationFiles) {
    for (const fn of sf.getFunctions()) {
      const returnType = fn.getReturnType();
      const result = analyzePrecision(returnType);
      if (result.containsAny) {
        anyLeakage++;
        penalties += 3;
      }
    }
    for (const iface of sf.getInterfaces()) {
      for (const prop of iface.getProperties()) {
        const result = analyzePrecision(prop.getType());
        if (result.containsAny) {
          anyLeakage++;
          penalties += 2;
        }
      }
    }
  }

  if (anyLeakage > 0) {
    negatives.push(`${anyLeakage} 'any' leakage(s) in declarations`);
  }

  if (lostExports === 0 && anyLeakage === 0 && genericLoss === 0 && constraintLoss === 0) {
    positives.push("Declarations faithfully represent source exports");
  }

  const score = Math.max(0, Math.min(100, 100 - penalties));

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      anyLeakage,
      constraintLoss,
      declExportCount: declExports.size,
      genericLoss,
      lostExports,
      sourceExportCount: sourceExports.size,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
