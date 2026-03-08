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

/** Scenario: unknown input to validated output */
const unknownToValidated: ScenarioTest = {
  description: "Validation functions should accept unknown input and return strongly-typed output",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let validationFns = 0;
    let unknownInputFns = 0;
    let typedOutputFns = 0;

    for (const decl of surface.declarations) {
      if (decl.kind !== "function") {
        continue;
      }
      const lowerName = decl.name.toLowerCase();
      if (
        !lowerName.includes("parse") &&
        !lowerName.includes("validate") &&
        !lowerName.includes("safeParse") &&
        !lowerName.includes("check") &&
        !lowerName.includes("assert") &&
        !lowerName.includes("guard") &&
        !lowerName.includes("decode") &&
        !lowerName.includes("create")
      ) {
        continue;
      }

      validationFns++;
      const hasUnknownInput = decl.positions.some(
        (pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0,
      );
      if (hasUnknownInput) {
        unknownInputFns++;
      }

      const hasTypedOutput = decl.positions.some((pos) => {
        if (pos.role !== "return") {
          return false;
        }
        const typeText = pos.type.getText();
        return typeText !== "any" && typeText !== "unknown" && typeText !== "void";
      });
      if (hasTypedOutput) {
        typedOutputFns++;
      }
    }

    if (validationFns === 0) {
      return makeResult({ name: "unknownToValidated", passed: false, reason: "No validation functions found", score: 20 });
    }

    if (unknownInputFns > 0) {
      score += 30;
    }
    if (typedOutputFns > 0) {
      score += 40;
    }
    if (validationFns >= 3) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "unknownToValidated", passed: passed, reason: passed
        ? `${unknownInputFns} accept unknown, ${typedOutputFns} return typed output`
        : "Validation pipeline lacks unknown→typed flow", score: score });
  },
  name: "unknownToValidated",
};

/** Scenario: Refinement/transform pipelines */
const refinementPipeline: ScenarioTest = {
  description: "Schema composition should preserve type information through transforms",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let pipelineFns = 0;
    let genericPipelines = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("pipe") ||
        lowerName.includes("transform") ||
        lowerName.includes("refine") ||
        lowerName.includes("chain") ||
        lowerName.includes("and") ||
        lowerName.includes("then")
      ) {
        pipelineFns++;
        if (decl.typeParameters.length > 0) {
          genericPipelines++;
        }
      }
    }

    if (pipelineFns === 0) {
      return makeResult({ name: "refinementPipeline", passed: false, reason: "No pipeline/transform functions found", score: 25 });
    }

    if (genericPipelines > 0) {
      score += 50;
    }
    if (pipelineFns >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "refinementPipeline", passed: passed, reason: passed
        ? `${genericPipelines}/${pipelineFns} pipelines preserve types`
        : "Pipeline functions lack generic type preservation", score: score });
  },
  name: "refinementPipeline",
};

/** Scenario: Discriminated schema composition */
const discriminatedComposition: ScenarioTest = {
  description: "Union schemas should produce discriminated unions for exhaustive matching",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let unionDecls = 0;
    let discriminatedUnions = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("union") ||
        lowerName.includes("discriminat") ||
        lowerName.includes("variant")
      ) {
        unionDecls++;
        if (decl.typeParameters.length > 0) {
          score += 15;
        }
      }
      // Check for discriminated union types in type aliases
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (bodyText.includes("|") && /["']?(type|kind|tag|_tag)["']?\s*:/.test(bodyText)) {
          discriminatedUnions++;
        }
      }
    }

    if (discriminatedUnions > 0) {
      score += 40;
    }
    if (unionDecls > 0) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "discriminatedComposition", passed: passed, reason: passed
        ? `${discriminatedUnions} discriminated unions, ${unionDecls} union constructors`
        : "Limited discriminated union support", score: score });
  },
  name: "discriminatedComposition",
};

/** Scenario: Parse/assert/guard ergonomics */
const parseGuardErgonomics: ScenarioTest = {
  description: "Library should provide multiple ergonomic ways to validate: parse, assert, guard",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    const patterns = new Set<string>();

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (lowerName.includes("parse")) {
        patterns.add("parse");
      }
      if (lowerName.includes("safeparse") || lowerName.includes("safe_parse")) {
        patterns.add("safeParse");
      }
      if (lowerName.includes("assert")) {
        patterns.add("assert");
      }
      if (lowerName.includes("guard") || lowerName.includes("is")) {
        patterns.add("guard");
      }
      if (lowerName.includes("validate")) {
        patterns.add("validate");
      }
      if (lowerName.includes("decode")) {
        patterns.add("decode");
      }
    }

    score = Math.min(100, patterns.size * 20);

    const passed = score >= 40;
    return makeResult({ name: "parseGuardErgonomics", passed: passed, reason: passed
        ? `${patterns.size} validation patterns: ${[...patterns].join(", ")}`
        : `Only ${patterns.size} validation pattern(s) found`, score: score });
  },
  name: "parseGuardErgonomics",
};

export const VALIDATION_PACK: ScenarioPack = {
  description:
    "Tests validation libraries for unknown→typed flow, pipelines, discriminated unions, and ergonomics",
  domain: "validation",
  name: "validation",
  scenarios: [
    unknownToValidated,
    refinementPipeline,
    discriminatedComposition,
    parseGuardErgonomics,
  ],
};
