import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

function makeResult(name: string, passed: boolean, score: number, reason: string): ScenarioResult {
  return { name, passed, reason, score };
}

const pipeOperatorInference: ScenarioTest = {
  description: "Pipe/operator chains should preserve and transform value types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let pipeDecls = 0;
    let genericPipes = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (lowerName === "pipe" || lowerName.includes("operator") || lowerName.includes("compose")) {
        pipeDecls++;
        if (decl.typeParameters.length > 0) {
          genericPipes++;
        }
      }
      if (decl.methods) {
        for (const method of decl.methods) {
          const mName = method.name.toLowerCase();
          if (mName === "pipe" || mName === "subscribe" || mName === "next") {
            pipeDecls++;
            if (method.typeParameters.length > 0) {
              genericPipes++;
            }
          }
        }
      }
    }

    if (pipeDecls === 0) {
      return makeResult("pipeOperatorInference", false, 25, "No pipe/operator declarations found");
    }
    if (genericPipes > 0) {
      score += 50;
    }
    if (pipeDecls >= 3) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "pipeOperatorInference",
      passed,
      score,
      passed
        ? `${genericPipes}/${pipeDecls} pipe patterns preserve types`
        : "Pipe operators lack type preservation",
    );
  },
  name: "pipeOperatorInference",
};

const valueErrorChannels: ScenarioTest = {
  description: "Observable/stream types should separate value and error channels",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let streamDecls = 0;
    let multiChannelDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("observable") ||
        lowerName.includes("subject") ||
        lowerName.includes("stream") ||
        lowerName.includes("subscription") ||
        lowerName.includes("subscriber")
      ) {
        streamDecls++;
        if (decl.typeParameters.length > 0) {
          multiChannelDecls++;
        }
      }
    }

    if (streamDecls === 0) {
      return makeResult("valueErrorChannels", false, 25, "No stream type declarations found");
    }
    if (multiChannelDecls > 0) {
      score += 50;
    }
    if (streamDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "valueErrorChannels",
      passed,
      score,
      passed
        ? `${multiChannelDecls}/${streamDecls} stream types with typed channels`
        : "Stream types lack channel separation",
    );
  },
  name: "valueErrorChannels",
};

const compositionPatterns: ScenarioTest = {
  description: "Subject/observable composition should be type-safe",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let compositionFns = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("merge") ||
        lowerName.includes("concat") ||
        lowerName.includes("combine") ||
        lowerName.includes("fork") ||
        lowerName.includes("zip") ||
        lowerName.includes("switch")
      ) {
        compositionFns++;
        if (decl.typeParameters.length > 0) {
          score += 15;
        }
      }
    }

    if (compositionFns === 0) {
      return makeResult("compositionPatterns", false, 25, "No composition patterns found");
    }
    if (compositionFns >= 3) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "compositionPatterns",
      passed,
      score,
      passed
        ? `${compositionFns} typed composition patterns`
        : "Limited stream composition support",
    );
  },
  name: "compositionPatterns",
};

export const STREAM_PACK: ScenarioPack = {
  description:
    "Tests stream/reactive libraries for pipe inference, value/error channels, and composition",
  domain: "stream",
  name: "stream",
  scenarios: [pipeOperatorInference, valueErrorChannels, compositionPatterns],
};
