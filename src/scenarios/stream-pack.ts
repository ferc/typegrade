import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Stream/reactive scenario pack.
 *
 * Tests how well a stream/reactive library preserves types through
 * pipe/operator chains, separates value and error channels, and
 * supports type-safe composition patterns.
 *
 * Rubric per scenario (approximate):
 *   40% compile-success analogue  (surface has declarations matching the pattern)
 *   25% compile-failure analogue  (constraints/narrow types reject wrong usage)
 *   25% inferred-type exactness   (precision features of relevant types)
 *   10% wrong-path prevention     (few ambiguous alternatives)
 */

interface MakeResultOpts {
  name: string;
  passed: boolean;
  reason: string;
  score: number;
}

function makeResult(opts: MakeResultOpts): ScenarioResult {
  return { name: opts.name, passed: opts.passed, reason: opts.reason, score: opts.score };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPipeRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "pipe" || lower.includes("operator") || lower.includes("compose") || lower === "flow"
  );
}

function isStreamType(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("observable") ||
    lower.includes("subject") ||
    lower.includes("stream") ||
    lower.includes("subscription") ||
    lower.includes("subscriber") ||
    lower.includes("signal") ||
    lower.includes("sink") ||
    lower.includes("source") ||
    lower.includes("emitter")
  );
}

function isCompositionRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("merge") ||
    lower.includes("concat") ||
    lower.includes("combine") ||
    lower.includes("combinelatest") ||
    lower.includes("fork") ||
    lower.includes("zip") ||
    lower.includes("switch") ||
    lower.includes("switchmap") ||
    lower.includes("exhaustmap") ||
    lower.includes("concatmap") ||
    lower.includes("mergemap") ||
    lower.includes("withlatest") ||
    lower.includes("race") ||
    lower.includes("forkjoin") ||
    lower.includes("partition")
  );
}

/** Check if a function/method has overloaded signatures */
function isOverloaded(decl: { overloadCount?: number }): boolean {
  return (decl.overloadCount ?? 0) > 1;
}

/** Tally generic/constrained type parameters for a declaration or method */
function tallyTypeParams(entry: { typeParameters: { hasConstraint: boolean }[] }): {
  hasGeneric: boolean;
  hasConstraint: boolean;
  multiParam: boolean;
} {
  const len = entry.typeParameters.length;
  return {
    hasConstraint: len > 0 && entry.typeParameters.some((tp) => tp.hasConstraint),
    hasGeneric: len > 0,
    multiParam: len >= 2,
  };
}

/** Check whether positions contain a typed error param (not any/unknown) */
function hasTypedErrorParam(positions: { role: string; type: { getText(): string } }[]): boolean {
  for (const pos of positions) {
    if (pos.role === "param") {
      const typeText = pos.type.getText();
      if (typeText !== "any" && typeText !== "unknown") {
        return true;
      }
    }
  }
  return false;
}

/** Check whether positions contain a tuple return type */
function hasTupleReturn(positions: { role: string; type: { getText(): string } }[]): boolean {
  for (const pos of positions) {
    if (pos.role !== "return") {
      continue;
    }
    const typeText = pos.type.getText();
    if (typeText.startsWith("[") || typeText.includes("readonly [")) {
      return true;
    }
  }
  return false;
}

/** Count operator-pattern declarations (map, filter, scan, etc.) */
function countOperatorDecls(surface: PublicSurface): {
  constrained: number;
  generic: number;
  total: number;
} {
  let total = 0;
  let generic = 0;
  let constrained = 0;
  const operatorNames =
    /^(map|filter|scan|reduce|take|skip|debounce|throttle|delay|distinct|tap|pluck|buffer|window|sample|audit|first|last|every|find|count|min|max|toarray|startwith|endwith|pairwise|groupby|share|publish|replay|retry|catcherror|finalize|timeout|timestamp|withlatestfrom)$/i;

  for (const decl of surface.declarations) {
    if (
      operatorNames.test(decl.name.toLowerCase()) ||
      decl.name.toLowerCase().includes("operator")
    ) {
      total++;
      if (decl.typeParameters.length > 0) {
        generic++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrained++;
        }
      }
    }
    if (!decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (operatorNames.test(method.name.toLowerCase())) {
        total++;
        const tally = tallyTypeParams(method);
        if (tally.hasGeneric) {
          generic++;
        }
        if (tally.hasConstraint) {
          constrained++;
        }
      }
    }
  }
  return { constrained, generic, total };
}

// ---------------------------------------------------------------------------
// Scenario 1: Pipe/operator inference
// ---------------------------------------------------------------------------

const pipeOperatorInference: ScenarioTest = {
  description:
    "Pipe/compose chains should preserve and transform value types through type-preserving operator chains",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let pipeDecls = 0;
    let genericPipes = 0;
    let overloadedPipes = 0;
    let constrainedPipes = 0;
    let multiParamPipes = 0;

    for (const decl of surface.declarations) {
      if (isPipeRelated(decl.name)) {
        pipeDecls++;
        const tally = tallyTypeParams(decl);
        if (tally.hasGeneric) {
          genericPipes++;
          if (tally.multiParam) {
            multiParamPipes++;
          }
          if (tally.hasConstraint) {
            constrainedPipes++;
          }
        }
        if (isOverloaded(decl)) {
          overloadedPipes++;
        }
      }

      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const mName = method.name.toLowerCase();
        if (
          mName !== "pipe" &&
          mName !== "subscribe" &&
          mName !== "next" &&
          mName !== "lift" &&
          mName !== "compose"
        ) {
          continue;
        }
        pipeDecls++;
        const tally = tallyTypeParams(method);
        if (tally.hasGeneric) {
          genericPipes++;
        }
        if (tally.multiParam) {
          multiParamPipes++;
        }
        if (tally.hasConstraint) {
          constrainedPipes++;
        }
        if (method.overloadCount > 1) {
          overloadedPipes++;
        }
      }
    }

    // Count operators
    const operators = countOperatorDecls(surface);

    if (pipeDecls === 0 && operators.total === 0) {
      return makeResult({
        name: "pipeOperatorInference",
        passed: false,
        reason: "No pipe/operator declarations found",
        score: 25,
      });
    }

    // 40% compile-success: pipe declarations with generics
    let compileScore = 0;
    if (genericPipes > 0 || operators.generic > 0) {
      compileScore = 40;
    } else if (pipeDecls >= 3 || operators.total >= 3) {
      compileScore = 20;
    }

    // 25% compile-failure: constrained pipes + overloads reject wrong types
    let failureScore = 0;
    if (constrainedPipes > 0 || operators.constrained > 0) {
      failureScore += 12;
    }
    if (overloadedPipes > 0) {
      failureScore += 8;
    }
    if (multiParamPipes > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: many operators + generic pipes
    let exactnessScore = 0;
    if (operators.generic >= 5) {
      exactnessScore += 12;
    } else if (operators.generic >= 2) {
      exactnessScore += 8;
    }
    if (genericPipes >= 2) {
      exactnessScore += 8;
    }
    if (overloadedPipes > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: non-generic operators are wrong paths
    let wrongPathScore = 0;
    const nonGenericOps = operators.total - operators.generic;
    if (nonGenericOps === 0 && operators.total > 0) {
      wrongPathScore = 10;
    } else if (operators.total > 0 && nonGenericOps < operators.total / 2) {
      wrongPathScore = 5;
    } else if (genericPipes > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "pipeOperatorInference",
      passed,
      reason: passed
        ? `${genericPipes} generic pipes, ${overloadedPipes} overloaded, ${operators.generic}/${operators.total} generic operators`
        : "Pipe operators lack type preservation",
      score,
    });
  },
  name: "pipeOperatorInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Value/error channels
// ---------------------------------------------------------------------------

/** Count typed error callbacks in error-handling methods of a declaration */
function countErrorMethodTyped(methods: PublicSurface["declarations"][number]["methods"]): number {
  if (!methods) {
    return 0;
  }
  let count = 0;
  for (const method of methods) {
    const mName = method.name.toLowerCase();
    const isErrorMethod =
      mName === "error" || mName === "throwerror" || mName === "catcherror" || mName === "onerror";
    // Check if the error param is typed (not just any/unknown)
    if (isErrorMethod && hasTypedErrorParam(method.positions)) {
      count++;
    }
  }
  return count;
}

const valueErrorChannels: ScenarioTest = {
  description:
    "Observable/stream types should separate value and error channels with typed generics for both",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let streamDecls = 0;
    let singleChannelDecls = 0;
    let multiChannelDecls = 0;
    let errorCallbackTyped = 0;
    let constrainedStreamTypes = 0;

    for (const decl of surface.declarations) {
      if (!isStreamType(decl.name)) {
        continue;
      }
      streamDecls++;

      if (decl.typeParameters.length >= 2) {
        multiChannelDecls++;
      } else if (decl.typeParameters.length === 1) {
        singleChannelDecls++;
      }

      if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
        constrainedStreamTypes++;
      }

      // Check methods for error-handling patterns with typed errors
      errorCallbackTyped += countErrorMethodTyped(decl.methods);
    }

    // Also check for error handler in subscribe signatures
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (method.name.toLowerCase() !== "subscribe") {
          continue;
        }
        // Look for observer pattern with error callback
        for (const pos of method.positions) {
          const typeText = pos.type.getText();
          if (typeText.includes("error") && !typeText.includes("any")) {
            errorCallbackTyped++;
          }
        }
      }
    }

    if (streamDecls === 0) {
      return makeResult({
        name: "valueErrorChannels",
        passed: false,
        reason: "No stream type declarations found",
        score: 25,
      });
    }

    // 40% compile-success: stream types with typed generics
    let compileScore = 0;
    if (multiChannelDecls > 0 || singleChannelDecls > 0) {
      compileScore = 40;
    } else if (streamDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained stream types + typed error callbacks
    let failureScore = 0;
    if (constrainedStreamTypes > 0) {
      failureScore += 12;
    }
    if (errorCallbackTyped > 0) {
      failureScore += 8;
    }
    if (multiChannelDecls > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multi-channel > single-channel
    let exactnessScore = 0;
    if (multiChannelDecls > 0) {
      exactnessScore += 15;
    } else if (singleChannelDecls > 0) {
      exactnessScore += 8;
    }
    if (errorCallbackTyped > 0) {
      exactnessScore += 5;
    }
    if (streamDecls >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: fewer untyped stream decls is better
    let wrongPathScore = 0;
    const untypedStreams = streamDecls - multiChannelDecls - singleChannelDecls;
    if (untypedStreams === 0 && streamDecls > 0) {
      wrongPathScore = 10;
    } else if (untypedStreams < streamDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "valueErrorChannels",
      passed,
      reason: passed
        ? `${multiChannelDecls} multi-channel, ${singleChannelDecls} single-channel, ${errorCallbackTyped} typed error callbacks`
        : "Stream types lack channel separation",
      score,
    });
  },
  name: "valueErrorChannels",
};

// ---------------------------------------------------------------------------
// Scenario 3: Composition patterns
// ---------------------------------------------------------------------------

const compositionPatterns: ScenarioTest = {
  description:
    "combineLatest, merge, switchMap and similar composition operators should preserve type information through combination",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let compositionFns = 0;
    let genericCompositions = 0;
    let overloadedCompositions = 0;
    let multiParamCompositions = 0;
    let constrainedCompositions = 0;
    let tupleReturns = 0;

    for (const decl of surface.declarations) {
      if (isCompositionRelated(decl.name)) {
        compositionFns++;
        const tally = tallyTypeParams(decl);
        if (tally.hasGeneric) {
          genericCompositions++;
          if (tally.multiParam) {
            multiParamCompositions++;
          }
          if (tally.hasConstraint) {
            constrainedCompositions++;
          }
        }
        if (isOverloaded(decl)) {
          overloadedCompositions++;
        }

        // Check for tuple return types (combineLatest, zip return [A, B, C])
        if (hasTupleReturn(decl.positions)) {
          tupleReturns++;
        }
      }

      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (!isCompositionRelated(method.name)) {
          continue;
        }
        compositionFns++;
        const tally = tallyTypeParams(method);
        if (tally.hasGeneric) {
          genericCompositions++;
        }
        if (tally.multiParam) {
          multiParamCompositions++;
        }
        if (tally.hasConstraint) {
          constrainedCompositions++;
        }
        if (method.overloadCount > 1) {
          overloadedCompositions++;
        }

        if (hasTupleReturn(method.positions)) {
          tupleReturns++;
        }
      }
    }

    if (compositionFns === 0) {
      return makeResult({
        name: "compositionPatterns",
        passed: false,
        reason: "No composition patterns found",
        score: 25,
      });
    }

    // 40% compile-success: composition functions with generics
    let compileScore = 0;
    if (genericCompositions > 0) {
      compileScore = 40;
    } else if (compositionFns >= 3) {
      compileScore = 20;
    }

    // 25% compile-failure: constrained + multi-param compositions
    let failureScore = 0;
    if (constrainedCompositions > 0) {
      failureScore += 12;
    }
    if (multiParamCompositions > 0) {
      failureScore += 8;
    }
    if (overloadedCompositions > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: tuple returns + overloads
    let exactnessScore = 0;
    if (tupleReturns > 0) {
      exactnessScore += 12;
    }
    if (overloadedCompositions > 0) {
      exactnessScore += 8;
    }
    if (genericCompositions >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: non-generic compositions are wrong paths
    let wrongPathScore = 0;
    const nonGeneric = compositionFns - genericCompositions;
    if (nonGeneric === 0 && compositionFns > 0) {
      wrongPathScore = 10;
    } else if (nonGeneric < compositionFns / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "compositionPatterns",
      passed,
      reason: passed
        ? `${genericCompositions}/${compositionFns} generic compositions, ${overloadedCompositions} overloaded, ${tupleReturns} tuple returns`
        : "Limited stream composition support",
      score,
    });
  },
  name: "compositionPatterns",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const STREAM_PACK: ScenarioPack = {
  description:
    "Tests stream/reactive libraries for pipe inference, value/error channels, and composition",
  domain: "stream",
  isApplicable: (surface) => {
    const streamNames = ["observable", "subject", "stream", "subscription", "operator"];
    const matchCount = surface.declarations.filter((decl) =>
      streamNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 2,
      reason:
        matchCount >= 2
          ? `${matchCount} stream/reactive declarations found`
          : "Insufficient stream/reactive declarations",
    };
  },
  name: "stream",
  scenarios: [pipeOperatorInference, valueErrorChannels, compositionPatterns],
};
