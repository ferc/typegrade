import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

function makeResult(name: string, passed: boolean, score: number, reason: string): ScenarioResult {
  return { name, passed, reason, score };
}

const schemaToQueryInference: ScenarioTest = {
  description: "Schema definitions should flow into query result types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let schemaDecls = 0;
    let queryDecls = 0;
    let genericQueryDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("schema") ||
        lowerName.includes("table") ||
        lowerName.includes("column") ||
        lowerName.includes("model")
      ) {
        schemaDecls++;
      }
      if (
        lowerName.includes("query") ||
        lowerName.includes("select") ||
        lowerName.includes("find") ||
        lowerName.includes("where")
      ) {
        queryDecls++;
        if (decl.typeParameters.length > 0) {
          genericQueryDecls++;
        }
      }
    }

    if (schemaDecls > 0) {
      score += 25;
    }
    if (genericQueryDecls > 0) {
      score += 45;
    }
    if (queryDecls >= 3) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "schemaToQueryInference",
      passed,
      score,
      passed
        ? `${schemaDecls} schema defs, ${genericQueryDecls} generic queries`
        : "Limited schema-to-query type flow",
    );
  },
  name: "schemaToQueryInference",
};

const joinPrecision: ScenarioTest = {
  description: "Join operations should produce correctly merged result types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let joinDecls = 0;
    let genericJoins = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("join") ||
        lowerName.includes("merge") ||
        lowerName.includes("relation")
      ) {
        joinDecls++;
        if (decl.typeParameters.length > 0) {
          genericJoins++;
        }
      }
    }

    if (joinDecls === 0) {
      return makeResult("joinPrecision", false, 30, "No join declarations found");
    }
    if (genericJoins > 0) {
      score += 50;
    }
    if (joinDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "joinPrecision",
      passed,
      score,
      passed
        ? `${genericJoins}/${joinDecls} joins preserve types`
        : "Join results lack type precision",
    );
  },
  name: "joinPrecision",
};

const columnNarrowing: ScenarioTest = {
  description: "Select operations should narrow result type to selected columns only",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let selectDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("select") ||
        lowerName.includes("pick") ||
        lowerName.includes("column")
      ) {
        selectDecls++;
        if (decl.typeParameters.length > 0) {
          score += 20;
        }
        // Check for keyof constraints
        for (const tp of decl.typeParameters) {
          const constraintText = tp.constraint?.getText() ?? "";
          if (constraintText.includes("keyof")) {
            score += 25;
          }
        }
      }
    }

    if (selectDecls === 0) {
      return makeResult("columnNarrowing", false, 25, "No select/column declarations found");
    }
    if (selectDecls >= 2) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "columnNarrowing",
      passed,
      score,
      passed
        ? `${selectDecls} column selection patterns`
        : "Select operations lack column narrowing",
    );
  },
  name: "columnNarrowing",
};

export const ORM_PACK: ScenarioPack = {
  description:
    "Tests ORM libraries for schema-to-query inference, join precision, and column narrowing",
  domain: "orm",
  name: "orm",
  scenarios: [schemaToQueryInference, joinPrecision, columnNarrowing],
};
