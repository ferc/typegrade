import { DIMENSION_CONFIGS } from "../constants.js";
import type { DimensionResult } from "../types.js";
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
      negatives.push(
        `High overload density (${overloadRatio.toFixed(1)} overloads/function, -${penalty})`,
      );
    }
  }

  // --- Overload ordering quality ---
  // Check if overloaded functions have narrowest-first ordering
  let poorlyOrderedOverloads = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function" && (decl.overloadCount ?? 0) > 1) {
      // Check if last overload is broader than first (good practice = narrow-first)
      const params = decl.positions.filter((pos) => pos.role === "param");
      if (params.length >= 2) {
        const firstParamText = params[0]!.type.getText();
        const lastParamText = params.at(-1)!.type.getText();
        if (firstParamText.includes("any") && !lastParamText.includes("any")) {
          poorlyOrderedOverloads++;
        }
      }
    }
  }
  if (poorlyOrderedOverloads > 0) {
    score -= Math.min(10, poorlyOrderedOverloads * 3);
    negatives.push(
      `${poorlyOrderedOverloads} overloaded function(s) with suboptimal signature ordering`,
    );
  }

  // --- Return type explicitness penalty ---
  let explicitReturns = 0;
  let totalReturnable = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalReturnable++;
      if (decl.hasExplicitReturnType) {
        explicitReturns++;
      }
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        totalReturnable++;
        if (method.hasExplicitReturnType) {
          explicitReturns++;
        }
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
    .filter((decl) => decl.kind === "function")
    .map((decl) => decl.name);

  if (functionNames.length >= 3) {
    const camelCase = functionNames.filter((nm) => /^[a-z]/.test(nm)).length;
    const pascalCase = functionNames.filter((nm) => /^[A-Z]/.test(nm)).length;
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
      if (typeText.includes("null")) {
        usesNull++;
      }
      if (typeText.includes("undefined")) {
        usesUndefined++;
      }
    }
  }

  if (usesNull > 0 && usesUndefined > 0) {
    const total = usesNull + usesUndefined;
    const dominantRatio = Math.max(usesNull, usesUndefined) / total;
    if (dominantRatio < 0.7) {
      score -= 5;
      negatives.push(
        `Mixed null/undefined conventions (${usesNull} null, ${usesUndefined} undefined, -5)`,
      );
    }
  }

  // --- Generic parameter discipline ---
  let singleLetterGenerics = 0;
  let descriptiveGenerics = 0;
  for (const decl of surface.declarations) {
    for (const tp of decl.typeParameters) {
      if (/^[A-Z]$/.test(tp.name)) {
        singleLetterGenerics++;
      } else {
        descriptiveGenerics++;
      }
    }
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      for (const tp of method.typeParameters) {
        if (/^[A-Z]$/.test(tp.name)) {
          singleLetterGenerics++;
        } else {
          descriptiveGenerics++;
        }
      }
    }
  }

  const totalGenerics = singleLetterGenerics + descriptiveGenerics;
  if (totalGenerics >= 3) {
    const dominantGenericRatio =
      Math.max(singleLetterGenerics, descriptiveGenerics) / totalGenerics;
    if (dominantGenericRatio < 0.7) {
      score -= 5;
      negatives.push(
        `Mixed generic naming styles (${singleLetterGenerics} single-letter, ${descriptiveGenerics} descriptive, -5)`,
      );
    } else {
      positives.push("Consistent generic parameter naming style");
    }
  }

  // --- Error/result shape consistency ---
  const discriminantProperties = new Set<string>();
  const KNOWN_DISCRIMINANTS = ["type", "kind", "tag", "_tag", "status", "code"];
  let resultFunctionCount = 0;

  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    for (const pos of decl.positions) {
      if (pos.role !== "return") {
        continue;
      }
      const typeText = pos.type.getText();
      const isResultLike = typeText.includes("Result") || typeText.includes("Either") || (typeText.includes("|") && typeText.includes("{"));
      if (isResultLike) {
        resultFunctionCount++;
        for (const prop of KNOWN_DISCRIMINANTS.filter((dp) => typeText.includes(dp))) {
          discriminantProperties.add(prop);
        }
      }
    }
  }

  if (resultFunctionCount > 1 && discriminantProperties.size > 1) {
    score -= 5;
    negatives.push(`Mixed result discriminants (${[...discriminantProperties].join(", ")}, -5)`);
  } else if (resultFunctionCount > 1 && discriminantProperties.size === 1) {
    positives.push(`Consistent result discriminant: ${[...discriminantProperties][0]}`);
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
      descriptiveGenerics,
      explicitReturns,
      overloadRatio:
        totalFunctions > 0 ? Math.round((totalOverloads / totalFunctions) * 100) / 100 : 0,
      poorlyOrderedOverloads,
      resultFunctionCount,
      singleLetterGenerics,
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
