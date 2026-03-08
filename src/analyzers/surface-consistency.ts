import type { DimensionResult } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "surfaceConsistency")!;

export function analyzeSurfaceConsistency(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 100;

  // --- Overload density penalty ---
  let totalFunctions = 0;
  let totalOverloads = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalFunctions++;
      totalOverloads += decl.overloadCount ?? 0;
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        totalFunctions++;
        totalOverloads += method.overloadCount;
      }
    }
  }

  if (totalFunctions > 0) {
    const overloadRatio = totalOverloads / totalFunctions;
    if (overloadRatio > 3) {
      const penalty = Math.min(25, Math.round((overloadRatio - 3) * 10));
      score -= penalty;
      negatives.push(`High overload density (${overloadRatio.toFixed(1)} overloads/function, -${penalty})`);
    }
  }

  // --- Return type explicitness penalty ---
  let explicitReturns = 0;
  let totalReturnable = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalReturnable++;
      if (decl.hasExplicitReturnType) {explicitReturns++;}
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        totalReturnable++;
        if (method.hasExplicitReturnType) {explicitReturns++;}
      }
    }
  }

  if (totalReturnable > 0) {
    const explicitPct = (explicitReturns / totalReturnable) * 100;
    if (explicitPct < 80) {
      const penalty = Math.min(20, Math.round((80 - explicitPct) / 4));
      score -= penalty;
      negatives.push(`Low return type explicitness (${Math.round(explicitPct)}%, -${penalty})`);
    } else {
      positives.push(`${Math.round(explicitPct)}% return types explicitly annotated`);
    }
  }

  // --- Consistent casing check ---
  const functionNames = surface.declarations
    .filter((d) => d.kind === "function")
    .map((d) => d.name);

  if (functionNames.length >= 3) {
    const camelCase = functionNames.filter((n) => /^[a-z]/.test(n)).length;
    const pascalCase = functionNames.filter((n) => /^[A-Z]/.test(n)).length;
    const total = functionNames.length;
    const dominantRatio = Math.max(camelCase, pascalCase) / total;

    if (dominantRatio < 0.8) {
      score -= 5;
      negatives.push("Inconsistent function naming convention (-5)");
    } else {
      positives.push("Consistent function naming convention");
    }
  }

  // --- Consistent nullability conventions ---
  let usesNull = 0;
  let usesUndefined = 0;
  for (const pos of surface.positions) {
    if (pos.role === "return" || pos.role === "property") {
      const typeText = pos.type.getText();
      if (typeText.includes("null")) {usesNull++;}
      if (typeText.includes("undefined")) {usesUndefined++;}
    }
  }

  if (usesNull > 0 && usesUndefined > 0) {
    const total = usesNull + usesUndefined;
    const dominantRatio = Math.max(usesNull, usesUndefined) / total;
    if (dominantRatio < 0.7) {
      score -= 5;
      negatives.push(`Mixed null/undefined conventions (${usesNull} null, ${usesUndefined} undefined, -5)`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  if (positives.length === 0 && negatives.length === 0) {
    positives.push("API surface is consistent");
  }

  return {
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      explicitReturns,
      overloadRatio: totalFunctions > 0 ? Math.round((totalOverloads / totalFunctions) * 100) / 100 : 0,
      totalFunctions,
      totalOverloads,
      totalReturnable,
      usesNull,
      usesUndefined,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
