import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

function makeResult(name: string, passed: boolean, score: number, reason: string): ScenarioResult {
  return { name, passed, reason, score };
}

const keyPreservingTransforms: ScenarioTest = {
  description: "Type utilities should preserve object keys through transformations",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let mappedTypes = 0;
    let keyofUsage = 0;

    for (const decl of surface.declarations) {
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (/\[.*\s+in\s+keyof\s/.test(bodyText) || bodyText.includes("keyof")) {
          keyofUsage++;
        }
        if (bodyText.includes("[") && bodyText.includes("in")) {
          mappedTypes++;
        }
      }
    }

    if (keyofUsage > 0) {
      score += 40;
    }
    if (mappedTypes > 0) {
      score += 30;
    }
    if (keyofUsage >= 3) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "keyPreservingTransforms",
      passed,
      score,
      passed
        ? `${keyofUsage} key-preserving patterns, ${mappedTypes} mapped types`
        : "Limited key-preserving transforms",
    );
  },
  name: "keyPreservingTransforms",
};

const deepTransforms: ScenarioTest = {
  description: "Deep utility types (DeepPartial, DeepRequired) should recurse properly",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let deepTypes = 0;
    let recursiveTypes = 0;

    for (const decl of surface.declarations) {
      if (decl.kind === "type-alias") {
        const lowerName = decl.name.toLowerCase();
        if (
          lowerName.includes("deep") ||
          lowerName.includes("recursive") ||
          lowerName.includes("nested")
        ) {
          deepTypes++;
        }
        if (decl.bodyTypeNode) {
          const bodyText = decl.bodyTypeNode.getText();
          if (bodyText.includes(decl.name)) {
            recursiveTypes++;
          }
        }
      }
    }

    if (deepTypes > 0) {
      score += 35;
    }
    if (recursiveTypes > 0) {
      score += 35;
    }
    if (deepTypes >= 3) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "deepTransforms",
      passed,
      score,
      passed
        ? `${deepTypes} deep types, ${recursiveTypes} recursive`
        : "Limited deep/recursive type support",
    );
  },
  name: "deepTransforms",
};

const aliasReadability: ScenarioTest = {
  description: "Composed utility types should remain readable after application",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let descriptiveAliases = 0;
    let totalAliases = 0;

    for (const decl of surface.declarations) {
      if (decl.kind === "type-alias") {
        totalAliases++;
        if (decl.name.length > 4 && /^[A-Z]/.test(decl.name)) {
          descriptiveAliases++;
        }
      }
    }

    if (totalAliases === 0) {
      return makeResult("aliasReadability", false, 30, "No type aliases found");
    }
    const ratio = descriptiveAliases / totalAliases;
    score = Math.round(ratio * 80) + (totalAliases >= 5 ? 20 : 0);
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "aliasReadability",
      passed,
      score,
      passed
        ? `${descriptiveAliases}/${totalAliases} aliases are descriptive`
        : "Type aliases lack readability",
    );
  },
  name: "aliasReadability",
};

export const SCHEMA_PACK: ScenarioPack = {
  description:
    "Tests schema/utility libraries for key preservation, deep transforms, and alias readability",
  domain: "schema",
  name: "schema",
  scenarios: [keyPreservingTransforms, deepTransforms, aliasReadability],
};
