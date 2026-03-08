import { DIMENSION_CONFIGS } from "../constants.js";
import type { DimensionResult } from "../types.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "surfaceComplexity")!;

const CONVENTIONAL_NAMES = new Set(["T", "K", "V", "U", "P", "R", "S", "E", "A", "B", "C"]);
const CONVENTIONAL_PREFIX = /^T[A-Z]/;

export function analyzeSurfaceComplexity(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 100;

  // --- Simplicity penalty ---
  // Trivially simple surfaces should NOT get inflated complexity scores.
  // If the surface has very few declarations and no advanced features,
  // Start at 70 instead of 100.
  const totalDecls = surface.declarations.length;
  let hasAdvancedFeatures = false;
  let simplicityPenalty = 0;

  for (const decl of surface.declarations) {
    if (decl.typeParameters.length > 0) {
      hasAdvancedFeatures = true;
      break;
    }
    if (decl.kind === "function" && (decl.overloadCount ?? 0) > 0) {
      hasAdvancedFeatures = true;
      break;
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        if (method.typeParameters.length > 0 || method.overloadCount > 0) {
          hasAdvancedFeatures = true;
          break;
        }
      }
      if (hasAdvancedFeatures) {
        break;
      }
    }
    // Check positions for complex types (generics, unions, intersections)
    for (const pos of decl.positions) {
      if (pos.type.isUnion() || pos.type.isIntersection()) {
        hasAdvancedFeatures = true;
        break;
      }
      const typeText = pos.type.getText();
      if (typeText.includes("<") || countNesting(typeText) > 1) {
        hasAdvancedFeatures = true;
        break;
      }
    }
    if (hasAdvancedFeatures) {
      break;
    }
  }

  if (totalDecls < 5 && !hasAdvancedFeatures) {
    simplicityPenalty = 30;
    score -= simplicityPenalty;
    negatives.push(
      `Trivially simple surface (${totalDecls} declaration(s), no generics/overloads/complex types, -${simplicityPenalty})`,
    );
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
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      for (const tp of method.typeParameters) {
        totalTypeParams++;
        if (!CONVENTIONAL_NAMES.has(tp.name) && !CONVENTIONAL_PREFIX.test(tp.name)) {
          nonConventional++;
        }
      }
    }
  }

  if (totalTypeParams > 0 && nonConventional > 0) {
    score -= 10;
    negatives.push(
      `${nonConventional}/${totalTypeParams} generic params use non-conventional names (-10)`,
    );
  } else if (totalTypeParams > 0) {
    positives.push("All generic parameters use conventional naming");
  }

  // --- Type nesting depth penalties ---
  let deeplyNestedCount = 0;
  for (const pos of surface.positions) {
    const typeText = pos.type.getText();
    const nestingDepth = countNesting(typeText);
    if (nestingDepth > 3) {
      deeplyNestedCount++;
    }
  }

  if (deeplyNestedCount > 0) {
    const penalty = Math.min(15, deeplyNestedCount * 3);
    score -= penalty;
    negatives.push(`${deeplyNestedCount} deeply nested types (>3 levels, -${penalty})`);
  }

  // --- Union/intersection breadth penalties ---
  let wideUnionCount = 0;
  for (const pos of surface.positions) {
    if (pos.type.isUnion()) {
      const members = pos.type.getUnionTypes();
      if (members.length > 8) {
        wideUnionCount++;
      }
    }
    if (pos.type.isIntersection()) {
      const members = pos.type.getIntersectionTypes();
      if (members.length > 5) {
        wideUnionCount++;
      }
    }
  }

  if (wideUnionCount > 0) {
    const penalty = Math.min(10, wideUnionCount * 2);
    score -= penalty;
    negatives.push(`${wideUnionCount} overly broad union/intersection types (-${penalty})`);
  }

  // --- Overload explosion ---
  let overloadCount = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      overloadCount += decl.overloadCount ?? 0;
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        overloadCount += method.overloadCount;
      }
    }
  }

  if (overloadCount > 50) {
    const penalty = Math.min(15, Math.round((overloadCount - 50) / 5));
    score -= penalty;
    negatives.push(`Overload explosion (${overloadCount} total overloads, -${penalty})`);
  }

  // --- Declaration sprawl ---
  const totalDeclarations = surface.declarations.length;
  if (totalDeclarations > 200) {
    const penalty = Math.min(10, Math.round((totalDeclarations - 200) / 20));
    score -= penalty;
    negatives.push(`Declaration sprawl (${totalDeclarations} declarations, -${penalty})`);
  }

  // --- Opaque helper-chain depth ---
  const typeAliasNames = new Set<string>();
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      typeAliasNames.add(decl.name);
    }
  }

  let avgChainDepth = 0;
  if (typeAliasNames.size > 0) {
    let totalChainDepth = 0;
    let chainedAliasCount = 0;

    for (const decl of surface.declarations) {
      if (decl.kind !== "type-alias" || !decl.bodyTypeNode) {
        continue;
      }
      const bodyText = decl.bodyTypeNode.getText();
      let depth = 0;
      for (const otherName of typeAliasNames) {
        if (otherName !== decl.name && bodyText.includes(otherName)) {
          depth++;
        }
      }
      if (depth > 0) {
        totalChainDepth += depth;
        chainedAliasCount++;
      }
    }

    if (chainedAliasCount > 0) {
      avgChainDepth = totalChainDepth / chainedAliasCount;
      if (avgChainDepth > 2) {
        score -= 5;
        negatives.push(
          `High type alias chain depth (avg ${avgChainDepth.toFixed(1)} references, -5)`,
        );
      }
    }
  }

  // --- Ambiguous call surface penalty ---
  // Functions with very similar parameter counts but different types increase cognitive load
  let ambiguousCallSurfaces = 0;
  const fnByName = new Map<string, number[]>();
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      const paramCount = decl.positions.filter((pos) => pos.role === "param").length;
      const existing = fnByName.get(decl.name);
      if (existing) {
        existing.push(paramCount);
      } else {
        fnByName.set(decl.name, [paramCount]);
      }
    }
  }
  for (const counts of fnByName.values()) {
    if (counts.length > 1) {
      const uniqueCounts = new Set(counts);
      if (uniqueCounts.size < counts.length) {
        ambiguousCallSurfaces++;
      }
    }
  }
  if (ambiguousCallSurfaces > 3) {
    const penalty = Math.min(10, ambiguousCallSurfaces * 2);
    score -= penalty;
    negatives.push(`${ambiguousCallSurfaces} functions with ambiguous call surfaces (-${penalty})`);
  }

  // --- Conditional entrypoint sprawl ---
  // Detect functions that accept discriminated option bags — multiple config object types
  // That change behavior. This creates complexity for consumers who must reason about
  // Which configuration shape to use.
  let conditionalEntrypoints = 0;
  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    for (const pos of decl.positions) {
      if (pos.role !== "param") {
        continue;
      }
      const paramType = pos.type;
      // A discriminated option bag shows up as a union of object types at a param position
      if (paramType.isUnion()) {
        const members = paramType.getUnionTypes();
        // Filter out primitive/null/undefined members — only count object-like union members
        const objectMembers = members.filter(
          (mt) =>
            !mt.isNull() &&
            !mt.isUndefined() &&
            !mt.isBoolean() &&
            !mt.isBooleanLiteral() &&
            !mt.isString() &&
            !mt.isStringLiteral() &&
            !mt.isNumber() &&
            !mt.isNumberLiteral() &&
            mt.getProperties().length > 0,
        );
        if (objectMembers.length >= 2) {
          conditionalEntrypoints++;
        }
      }
    }
  }
  if (conditionalEntrypoints > 0) {
    const penalty = Math.min(10, conditionalEntrypoints * 3);
    score -= penalty;
    negatives.push(
      `${conditionalEntrypoints} function(s) with discriminated option bags (-${penalty})`,
    );
  }

  // --- Confusable exports penalty ---
  // Multiple exported functions with the same return type but different names
  // Make consumers wonder "which one should I use?"
  let confusableExports = 0;
  const returnTypeToFnNames = new Map<string, string[]>();
  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    for (const pos of decl.positions) {
      if (pos.role !== "return") {
        continue;
      }
      const retText = pos.type.getText();
      // Skip trivial return types that are expected to be shared
      if (
        retText === "void" ||
        retText === "boolean" ||
        retText === "string" ||
        retText === "number" ||
        retText === "any" ||
        retText === "unknown" ||
        retText === "undefined" ||
        retText === "never"
      ) {
        continue;
      }
      const existing = returnTypeToFnNames.get(retText);
      if (existing) {
        if (!existing.includes(decl.name)) {
          existing.push(decl.name);
        }
      } else {
        returnTypeToFnNames.set(retText, [decl.name]);
      }
    }
  }
  for (const names of returnTypeToFnNames.values()) {
    if (names.length >= 3) {
      confusableExports += names.length;
    }
  }
  if (confusableExports > 0) {
    const penalty = Math.min(10, Math.round(confusableExports / 2));
    score -= penalty;
    negatives.push(
      `${confusableExports} exports share return types with 3+ other differently-named functions (-${penalty})`,
    );
  }

  // --- Duplicate public concepts penalty ---
  const declNames = surface.declarations.map((decl) => decl.name.toLowerCase());
  let duplicateConcepts = 0;
  for (let idx = 0; idx < declNames.length; idx++) {
    for (let jdx = idx + 1; jdx < declNames.length; jdx++) {
      const nameA = declNames[idx]!;
      const nameB = declNames[jdx]!;
      if (nameA === nameB && nameA.length > 2) {
        duplicateConcepts++;
      }
    }
  }
  if (duplicateConcepts > 2) {
    score -= Math.min(5, duplicateConcepts);
    negatives.push(`${duplicateConcepts} duplicate public concept name(s)`);
  }

  score = Math.max(0, Math.min(100, score));

  if (positives.length === 0 && negatives.length === 0) {
    positives.push("API surface has manageable complexity");
  }

  return {
    applicability: "applicable",
    applicabilityReasons: [],
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      ambiguousCallSurfaces,
      avgChainDepth: Math.round(avgChainDepth * 100) / 100,
      conditionalEntrypoints,
      confusableExports,
      deeplyNestedCount,
      duplicateConcepts,
      nonConventionalTypeParams: nonConventional,
      overloadCount,
      simplicityPenalty,
      totalDeclarations,
      totalTypeParams,
      wideUnionCount,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

function countNesting(typeText: string): number {
  let maxDepth = 0;
  let currentDepth = 0;
  for (const char of typeText) {
    if (char === "<" || char === "(") {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === ">" || char === ")") {
      currentDepth--;
    }
  }
  return maxDepth;
}
