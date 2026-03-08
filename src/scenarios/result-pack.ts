import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Result/Effect scenario pack.
 *
 * Tests how well a result/effect library preserves error channel types,
 * transforms both channels through map/flatMap, and composes async operations.
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
  score: number;
  reason: string;
}

function makeResult(opts: MakeResultOpts): ScenarioResult {
  return { name: opts.name, passed: opts.passed, reason: opts.reason, score: opts.score };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isResultRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("result") ||
    lower.includes("either") ||
    lower.includes("effect") ||
    lower.includes("option") ||
    lower.includes("maybe") ||
    lower.includes("outcome") ||
    lower.includes("try") ||
    lower.includes("io")
  );
}

function isTransformRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "map" ||
    lower === "flatmap" ||
    lower === "chain" ||
    lower === "match" ||
    lower === "fold" ||
    lower === "mapright" ||
    lower === "mapleft" ||
    lower === "bimap" ||
    lower === "maperror" ||
    lower === "mapErr" ||
    lower === "mapboth" ||
    lower === "recover" ||
    lower === "catcherror" ||
    lower === "tap" ||
    lower === "andthen" ||
    lower === "orthen" ||
    lower === "orelse"
  );
}

/** Count transform methods/functions found in the surface */
function countTransforms(surface: PublicSurface): {
  dualChannelTransforms: number;
  genericTransforms: number;
  overloadedTransforms: number;
  transformFns: number;
} {
  let transformFns = 0;
  let genericTransforms = 0;
  let dualChannelTransforms = 0;
  let overloadedTransforms = 0;

  for (const decl of surface.declarations) {
    if (isTransformRelated(decl.name)) {
      transformFns++;
      if (decl.typeParameters.length > 0) {
        genericTransforms++;
      }
      if (decl.typeParameters.length >= 2) {
        dualChannelTransforms++;
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedTransforms++;
      }
    }

    if (!decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (!isTransformRelated(method.name)) {
        continue;
      }
      transformFns++;
      if (method.typeParameters.length > 0) {
        genericTransforms++;
      }
      if (method.typeParameters.length >= 2) {
        dualChannelTransforms++;
      }
      if (method.overloadCount > 1) {
        overloadedTransforms++;
      }
    }
  }

  return { dualChannelTransforms, genericTransforms, overloadedTransforms, transformFns };
}

// ---------------------------------------------------------------------------
// Scenario 1: Error channel propagation
// ---------------------------------------------------------------------------

const errorChannelPropagation: ScenarioTest = {
  description:
    "Result/Either types should have dual-channel generics (Result<T, E>) with typed error channel that propagates through operations",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let resultDecls = 0;
    // Result<T, E> with >= 2 type params
    let dualGenericDecls = 0;
    let singleGenericDecls = 0;
    let errorSpecificDecls = 0;
    let neverErrorDecls = 0;
    let constrainedErrorParams = 0;

    for (const decl of surface.declarations) {
      if (!isResultRelated(decl.name)) {
        continue;
      }
      resultDecls++;

      if (decl.typeParameters.length >= 2) {
        dualGenericDecls++;
        // Check if the second (error) param has a constraint
        const [, errorParam] = decl.typeParameters;
        if (errorParam && errorParam.hasConstraint) {
          constrainedErrorParams++;
        }
      } else if (decl.typeParameters.length === 1) {
        singleGenericDecls++;
      }

      // Check for error-specific type aliases (Err<E>, Left<E>, Failure<E>)
      const lowerName = decl.name.toLowerCase();
      if (
        (lowerName.includes("err") ||
          lowerName.includes("left") ||
          lowerName.includes("failure") ||
          lowerName.includes("defect")) &&
        decl.typeParameters.length > 0
      ) {
        errorSpecificDecls++;
      }

      // Check for never-typed error positions (Ok<T, never>)
      for (const pos of decl.positions) {
        const typeText = pos.type.getText();
        if (
          typeText.includes("never") &&
          (lowerName.includes("ok") || lowerName.includes("right") || lowerName.includes("success"))
        ) {
          neverErrorDecls++;
        }
      }
    }

    // Check methods for error-propagating transforms
    const transforms = countTransforms(surface);

    // 40% compile-success: Result types exist with dual generics
    let compileScore = 0;
    if (dualGenericDecls > 0) {
      compileScore = 40;
    } else if (singleGenericDecls > 0) {
      compileScore = 25;
    } else if (resultDecls > 0) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained error params + error-specific types
    let failureScore = 0;
    if (constrainedErrorParams > 0) {
      failureScore += 10;
    }
    if (errorSpecificDecls > 0) {
      failureScore += 10;
    }
    if (neverErrorDecls > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: dual-channel transforms
    let exactnessScore = 0;
    if (transforms.dualChannelTransforms > 0) {
      exactnessScore += 15;
    }
    if (dualGenericDecls >= 2) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: fewer single-generic (lossy) result types
    let wrongPathScore = 0;
    if (singleGenericDecls === 0 && dualGenericDecls > 0) {
      wrongPathScore = 10;
    } else if (singleGenericDecls < dualGenericDecls) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "errorChannelPropagation",
      passed,
      reason: passed
        ? `${dualGenericDecls} dual-generic result types, ${errorSpecificDecls} error-specific, ${transforms.dualChannelTransforms} dual-channel transforms`
        : "Limited error channel propagation",
      score,
    });
  },
  name: "errorChannelPropagation",
};

// ---------------------------------------------------------------------------
// Scenario 2: map/flatMap/chain precision
// ---------------------------------------------------------------------------

const mapFlatMapPrecision: ScenarioTest = {
  description:
    "map/flatMap/chain/match should preserve both value and error channels, with generic return types that track transformations",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    const transforms = countTransforms(surface);

    // Additional checks: look for mapLeft/mapError/bimap (dual-channel awareness)
    let errorChannelTransforms = 0;
    let matchExhaustivePatterns = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName === "mapleft" ||
        lowerName === "maperror" ||
        lowerName === "maperr" ||
        lowerName === "bimap" ||
        lowerName === "mapboth"
      ) {
        errorChannelTransforms++;
      }
      if (lowerName === "match" || lowerName === "fold" || lowerName === "cata") {
        matchExhaustivePatterns++;
      }

      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const mName = method.name.toLowerCase();
        if (
          mName === "mapleft" ||
          mName === "maperror" ||
          mName === "maperr" ||
          mName === "bimap" ||
          mName === "mapboth"
        ) {
          errorChannelTransforms++;
        }
        if (mName === "match" || mName === "fold" || mName === "cata") {
          matchExhaustivePatterns++;
        }
      }
    }

    if (transforms.transformFns === 0) {
      return makeResult({
        name: "mapFlatMapPrecision",
        passed: false,
        reason: "No map/flatMap functions found",
        score: 20,
      });
    }

    // 40% compile-success: transform functions with generics
    let compileScore = 0;
    if (transforms.genericTransforms > 0) {
      compileScore = 40;
    } else if (transforms.transformFns >= 3) {
      compileScore = 20;
    }

    // 25% compile-failure: dual-channel transforms + error-channel transforms
    let failureScore = 0;
    if (errorChannelTransforms > 0) {
      failureScore += 15;
    }
    if (transforms.dualChannelTransforms > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: overloaded transforms + match/fold
    let exactnessScore = 0;
    if (transforms.overloadedTransforms > 0) {
      exactnessScore += 10;
    }
    if (matchExhaustivePatterns > 0) {
      exactnessScore += 10;
    }
    if (transforms.genericTransforms >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: non-generic transforms are wrong paths
    let wrongPathScore = 0;
    const nonGeneric = transforms.transformFns - transforms.genericTransforms;
    if (nonGeneric === 0 && transforms.transformFns > 0) {
      wrongPathScore = 10;
    } else if (nonGeneric < transforms.transformFns / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "mapFlatMapPrecision",
      passed,
      reason: passed
        ? `${transforms.genericTransforms}/${transforms.transformFns} generic transforms, ${errorChannelTransforms} error-channel, ${matchExhaustivePatterns} match/fold`
        : "Transform functions lack type precision",
      score,
    });
  },
  name: "mapFlatMapPrecision",
};

// ---------------------------------------------------------------------------
// Scenario 3: Async composition
// ---------------------------------------------------------------------------

/** Check if a method name is async-related */
function isAsyncMethod(mName: string): boolean {
  return (
    mName.includes("then") ||
    mName.includes("asyncmap") ||
    mName.includes("flatmapassync") ||
    mName.includes("trypromise") ||
    mName.includes("fromPromise") ||
    mName.includes("toPromise") ||
    mName.includes("run") ||
    mName.includes("execute") ||
    mName.includes("runpromise") ||
    mName.includes("runasync")
  );
}

/** Process async methods on a declaration */
function countAsyncMethods(
  methods: readonly {
    name: string;
    typeParameters: readonly { hasConstraint: boolean }[];
    overloadCount: number;
  }[],
): { asyncTransforms: number; genericAsyncDecls: number } {
  let asyncTransforms = 0;
  let genericAsyncDecls = 0;
  for (const method of methods) {
    const mName = method.name.toLowerCase();
    if (isAsyncMethod(mName)) {
      asyncTransforms++;
      if (method.typeParameters.length > 0) {
        genericAsyncDecls++;
      }
    }
  }
  return { asyncTransforms, genericAsyncDecls };
}

const asyncComposition: ScenarioTest = {
  description:
    "Async result composition (Task, IO, Effect with Promise) should maintain type safety with typed async result types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let asyncDecls = 0;
    let genericAsyncDecls = 0;
    let taskEffectTypes = 0;
    let asyncTransforms = 0;
    let promiseWrappedResults = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();

      // Check for Task/IO/Effect types (async result types)
      if (
        (lowerName.includes("task") ||
          lowerName.includes("io") ||
          lowerName.includes("effect") ||
          lowerName.includes("future") ||
          lowerName.includes("async")) &&
        decl.typeParameters.length > 0
      ) {
        taskEffectTypes++;
      }

      // Check return positions for async result types
      for (const pos of decl.positions) {
        if (pos.role !== "return") {
          continue;
        }
        const typeText = pos.type.getText();
        const isAsync =
          typeText.includes("Promise") ||
          typeText.includes("Task") ||
          typeText.includes("Effect") ||
          typeText.includes("IO") ||
          typeText.includes("Future");
        if (isAsync) {
          asyncDecls++;
          if (decl.typeParameters.length > 0) {
            genericAsyncDecls++;
          }
          // Check for Promise<Result<T, E>> pattern
          if (
            typeText.includes("Promise<") &&
            (typeText.includes("Result") ||
              typeText.includes("Either") ||
              typeText.includes("Option"))
          ) {
            promiseWrappedResults++;
          }
        }
      }

      // Check for async-specific transform methods
      if (decl.methods) {
        const methodCounts = countAsyncMethods(decl.methods);
        asyncTransforms += methodCounts.asyncTransforms;
        genericAsyncDecls += methodCounts.genericAsyncDecls;
      }
    }

    // 40% compile-success: async declarations exist with generics
    let compileScore = 0;
    if (genericAsyncDecls > 0 || taskEffectTypes > 0) {
      compileScore = 40;
    } else if (asyncDecls > 0) {
      compileScore = 20;
    }

    // 25% compile-failure: async type params constrain result types
    let failureScore = 0;
    if (taskEffectTypes > 0) {
      failureScore += 15;
    }
    if (promiseWrappedResults > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: async transforms + generic async decls
    let exactnessScore = 0;
    if (asyncTransforms > 0) {
      exactnessScore += 12;
    }
    if (genericAsyncDecls >= 3) {
      exactnessScore += 8;
    }
    if (taskEffectTypes >= 2) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (asyncDecls > 0 && genericAsyncDecls >= asyncDecls / 2) {
      wrongPathScore = 10;
    } else if (genericAsyncDecls > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "asyncComposition",
      passed,
      reason: passed
        ? `${genericAsyncDecls} generic async decls, ${taskEffectTypes} Task/Effect types, ${asyncTransforms} async transforms, ${promiseWrappedResults} Promise-wrapped results`
        : "Limited async composition support",
      score,
    });
  },
  name: "asyncComposition",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const RESULT_PACK: ScenarioPack = {
  description:
    "Tests result/effect libraries for error propagation, map/flatMap precision, and async composition",
  domain: "result",
  name: "result",
  scenarios: [errorChannelPropagation, mapFlatMapPrecision, asyncComposition],
};
