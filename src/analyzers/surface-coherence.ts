import type { DimensionResult } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "surfaceCoherence")!;

const CONVENTIONAL_NAMES = new Set(["T", "K", "V", "U", "P", "R", "S", "E", "A", "B", "C"]);
const CONVENTIONAL_PREFIX = /^T[A-Z]/;

export function analyzeSurfaceCoherence(surface: PublicSurface): DimensionResult {
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

  // --- Non-conventional generic parameter naming penalty ---
  let totalTypeParams = 0;
  let nonConventional = 0;
  for (const decl of surface.declarations) {
    for (const tp of decl.typeParameters) {
      totalTypeParams++;
      if (!CONVENTIONAL_NAMES.has(tp.name) && !CONVENTIONAL_PREFIX.test(tp.name)) {
        nonConventional++;
      }
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        for (const tp of method.typeParameters) {
          totalTypeParams++;
          if (!CONVENTIONAL_NAMES.has(tp.name) && !CONVENTIONAL_PREFIX.test(tp.name)) {
            nonConventional++;
          }
        }
      }
    }
  }

  if (totalTypeParams > 0 && nonConventional > 0) {
    score -= 10;
    negatives.push(`${nonConventional}/${totalTypeParams} generic params use non-conventional names (-10)`);
  } else if (totalTypeParams > 0) {
    positives.push("All generic parameters use conventional naming");
  }

  score = Math.max(0, Math.min(100, score));

  if (positives.length === 0 && negatives.length === 0) {
    positives.push("API surface is coherent");
  }

  return {
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      explicitReturns,
      nonConventionalTypeParams: nonConventional,
      overloadRatio: totalFunctions > 0 ? Math.round((totalOverloads / totalFunctions) * 100) / 100 : 0,
      totalFunctions,
      totalOverloads,
      totalReturnable,
      totalTypeParams,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
