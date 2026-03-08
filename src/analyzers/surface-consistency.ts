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
      const isResultLike =
        typeText.includes("Result") ||
        typeText.includes("Either") ||
        (typeText.includes("|") && typeText.includes("{"));
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

  // --- Method signature consistency ---
  // For interfaces/classes with multiple methods, check if methods follow consistent
  // Async/sync patterns (all Promise vs mixed) and callback vs return patterns
  let methodSignatureInconsistencies = 0;
  for (const decl of surface.declarations) {
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    const methods = decl.methods.filter((mt) => !mt.isPrivate);
    if (methods.length < 3) {
      continue;
    }

    // Check async/sync consistency: all returning Promise vs mixed
    let asyncMethods = 0;
    let syncMethods = 0;
    // Check callback-style consistency: accepting callback params vs returning values
    let callbackMethods = 0;
    let returnMethods = 0;

    for (const method of methods) {
      const returnPositions = method.positions.filter((pos) => pos.role === "return");
      const paramPositions = method.positions.filter((pos) => pos.role === "param");

      for (const retPos of returnPositions) {
        const retText = retPos.type.getText();
        if (retText.includes("Promise<") || retText.includes("PromiseLike<")) {
          asyncMethods++;
        } else if (retText !== "void" && retText !== "undefined") {
          syncMethods++;
        }
      }

      const hasCallbackParam = paramPositions.some((pm) => {
        const pmText = pm.type.getText();
        return pmText.includes("=>") || pmText.includes("Callback") || pmText.includes("callback");
      });
      if (hasCallbackParam) {
        callbackMethods++;
      } else if (returnPositions.length > 0) {
        returnMethods++;
      }
    }

    // Flag mixed async/sync patterns (some Promise, some not)
    if (asyncMethods > 0 && syncMethods > 0) {
      const total = asyncMethods + syncMethods;
      const dominantRatio = Math.max(asyncMethods, syncMethods) / total;
      if (dominantRatio < 0.75) {
        methodSignatureInconsistencies++;
      }
    }

    // Flag mixed callback/return patterns
    if (callbackMethods > 0 && returnMethods > 0) {
      const total = callbackMethods + returnMethods;
      const dominantRatio = Math.max(callbackMethods, returnMethods) / total;
      if (dominantRatio < 0.75) {
        methodSignatureInconsistencies++;
      }
    }
  }

  if (methodSignatureInconsistencies > 0) {
    const penalty = Math.min(10, methodSignatureInconsistencies * 5);
    score -= penalty;
    negatives.push(
      `${methodSignatureInconsistencies} interface(s)/class(es) with inconsistent method signatures (mixed async/sync or callback/return, -${penalty})`,
    );
  }

  // --- Option bag consistency ---
  // If multiple functions accept option-like object parameters, check if they follow
  // A consistent naming pattern (all use "options", "opts", "config", etc.)
  const optionBagNames: string[] = [];
  const OPTION_BAG_PATTERNS = /^(options|opts|config|settings|params|args|props)$/i;
  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    for (const pos of decl.positions) {
      if (pos.role !== "param") {
        continue;
      }
      const paramName = pos.name;
      const typeText = pos.type.getText();
      // Detect option bags: param is an object-like type with a conventional name,
      // Or any param whose type is an object literal / interface-like shape
      const isObjectLike =
        typeText.startsWith("{") ||
        typeText.includes("Options") ||
        typeText.includes("Config") ||
        typeText.includes("Settings") ||
        typeText.includes("Props");
      if (isObjectLike || OPTION_BAG_PATTERNS.test(paramName)) {
        optionBagNames.push(paramName.toLowerCase());
      }
    }
  }

  if (optionBagNames.length >= 3) {
    const nameCounts = new Map<string, number>();
    for (const nm of optionBagNames) {
      nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);
    }
    let maxCount = 0;
    for (const count of nameCounts.values()) {
      if (count > maxCount) {
        maxCount = count;
      }
    }
    const dominantRatio = maxCount / optionBagNames.length;
    if (dominantRatio < 0.6) {
      score -= 5;
      const uniqueNames = [...nameCounts.keys()].slice(0, 4).join(", ");
      negatives.push(
        `Inconsistent option bag naming (${uniqueNames}${nameCounts.size > 4 ? "..." : ""}, -5)`,
      );
    } else {
      positives.push("Consistent option bag naming convention");
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
      descriptiveGenerics,
      explicitReturns,
      methodSignatureInconsistencies,
      optionBagNames: optionBagNames.length,
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
