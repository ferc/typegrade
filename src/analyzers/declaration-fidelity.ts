import type { SourceFile } from "ts-morph";
import type { DimensionResult, Issue } from "../types.js";
import { analyzePrecision } from "../utils/type-utils.js";
import { DIMENSION_CONFIGS } from "../constants.js";

const CONFIG = DIMENSION_CONFIGS.find((c) => c.key === "declarationFidelity")!;

export function analyzeDeclarationFidelity(
  sourceFiles: SourceFile[],
  declarationFiles: SourceFile[],
): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  // Collect exported symbols from source
  const sourceExports = new Map<string, { file: string; line: number }>();
  for (const sf of sourceFiles) {
    for (const exp of sf.getExportedDeclarations()) {
      const [name, decls] = exp;
      for (const decl of decls) {
        sourceExports.set(name, {
          file: sf.getFilePath(),
          line: decl.getStartLineNumber(),
        });
      }
    }
  }

  // Collect exported symbols from declarations
  const declExports = new Set<string>();
  for (const sf of declarationFiles) {
    for (const [name] of sf.getExportedDeclarations()) {
      declExports.add(name);
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

  if (lostExports === 0 && anyLeakage === 0) {
    positives.push("Declarations faithfully represent source exports");
  }

  const score = Math.max(0, Math.min(100, 100 - penalties));

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      sourceExportCount: sourceExports.size,
      declExportCount: declExports.size,
      lostExports,
      anyLeakage,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
