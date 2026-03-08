import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

function makeResult(name: string, passed: boolean, score: number, reason: string): ScenarioResult {
  return { name, passed, reason, score };
}

const errorChannelPropagation: ScenarioTest = {
  description: "Error types should propagate through map/flatMap/chain operations",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let resultDecls = 0;
    let errorGenericDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("result") ||
        lowerName.includes("either") ||
        lowerName.includes("effect")
      ) {
        resultDecls++;
        // Check for multiple generic params (value + error)
        if (decl.typeParameters.length >= 2) {
          errorGenericDecls++;
        }
      }
    }

    if (resultDecls > 0) {
      score += 25;
    }
    if (errorGenericDecls > 0) {
      score += 45;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "errorChannelPropagation",
      passed,
      score,
      passed
        ? `${errorGenericDecls} result types with error channel generics`
        : "Limited error channel propagation",
    );
  },
  name: "errorChannelPropagation",
};

const mapFlatMapPrecision: ScenarioTest = {
  description: "map/flatMap/match should preserve and transform types precisely",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let transformFns = 0;
    let genericTransforms = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName === "map" ||
        lowerName === "flatmap" ||
        lowerName === "chain" ||
        lowerName === "match" ||
        lowerName === "fold" ||
        lowerName === "mapright" ||
        lowerName === "mapleft" ||
        lowerName === "bimap"
      ) {
        transformFns++;
        if (decl.typeParameters.length > 0) {
          genericTransforms++;
        }
      }
      // Also check methods
      if (decl.methods) {
        for (const method of decl.methods) {
          const mName = method.name.toLowerCase();
          if (
            mName === "map" ||
            mName === "flatmap" ||
            mName === "chain" ||
            mName === "match" ||
            mName === "fold"
          ) {
            transformFns++;
            if (method.typeParameters.length > 0) {
              genericTransforms++;
            }
          }
        }
      }
    }

    if (transformFns === 0) {
      return makeResult("mapFlatMapPrecision", false, 20, "No map/flatMap functions found");
    }
    if (genericTransforms > 0) {
      score += 50;
    }
    if (transformFns >= 3) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "mapFlatMapPrecision",
      passed,
      score,
      passed
        ? `${genericTransforms}/${transformFns} transforms preserve types`
        : "Transform functions lack type precision",
    );
  },
  name: "mapFlatMapPrecision",
};

const asyncComposition: ScenarioTest = {
  description: "Async result composition should maintain type safety",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let asyncDecls = 0;

    for (const decl of surface.declarations) {
      for (const pos of decl.positions) {
        if (pos.role === "return") {
          const typeText = pos.type.getText();
          if (
            typeText.includes("Promise") ||
            typeText.includes("Task") ||
            typeText.includes("Effect")
          ) {
            asyncDecls++;
            if (decl.typeParameters.length > 0) {
              score += 15;
            }
          }
        }
      }
    }

    if (asyncDecls > 0) {
      score += 30;
    }
    if (asyncDecls >= 3) {
      score += 20;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "asyncComposition",
      passed,
      score,
      passed ? `${asyncDecls} async compositions detected` : "Limited async composition support",
    );
  },
  name: "asyncComposition",
};

export const RESULT_PACK: ScenarioPack = {
  description:
    "Tests result/effect libraries for error propagation, map/flatMap precision, and async composition",
  domain: "result",
  name: "result",
  scenarios: [errorChannelPropagation, mapFlatMapPrecision, asyncComposition],
};
