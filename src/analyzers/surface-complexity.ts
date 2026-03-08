import type { DimensionResult } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "surfaceComplexity")!;

const CONVENTIONAL_NAMES = new Set(["T", "K", "V", "U", "P", "R", "S", "E", "A", "B", "C"]);
const CONVENTIONAL_PREFIX = /^T[A-Z]/;

export function analyzeSurfaceComplexity(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 100;

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

  score = Math.max(0, Math.min(100, score));

  if (positives.length === 0 && negatives.length === 0) {
    positives.push("API surface has manageable complexity");
  }

  return {
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      deeplyNestedCount,
      nonConventionalTypeParams: nonConventional,
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
