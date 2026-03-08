import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

interface MakeResultOpts {
  name: string;
  passed: boolean;
  score: number;
  reason: string;
}

function makeResult(opts: MakeResultOpts): ScenarioResult {
  return { name: opts.name, passed: opts.passed, reason: opts.reason, score: opts.score };
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
    return makeResult({ name: "keyPreservingTransforms", passed: passed, reason: passed
        ? `${keyofUsage} key-preserving patterns, ${mappedTypes} mapped types`
        : "Limited key-preserving transforms", score: score });
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
    return makeResult({ name: "deepTransforms", passed: passed, reason: passed
        ? `${deepTypes} deep types, ${recursiveTypes} recursive`
        : "Limited deep/recursive type support", score: score });
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
      return makeResult({ name: "aliasReadability", passed: false, reason: "No type aliases found", score: 30 });
    }
    const ratio = descriptiveAliases / totalAliases;
    score = Math.round(ratio * 80) + (totalAliases >= 5 ? 20 : 0);
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "aliasReadability", passed: passed, reason: passed
        ? `${descriptiveAliases}/${totalAliases} aliases are descriptive`
        : "Type aliases lack readability", score: score });
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
