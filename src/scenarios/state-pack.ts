import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * State management scenario pack.
 *
 * Tests how well a state management library preserves types through
 * store/atom definitions, derived/computed state, and subscription patterns.
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

interface MethodStats {
  matchCount: number;
  genericCount: number;
  constrainedCount: number;
  overloadedCount: number;
}

interface MethodLike {
  name: string;
  typeParameters: readonly { hasConstraint: boolean }[];
  overloadCount: number;
}

function countMethodMatches(
  methods: readonly MethodLike[],
  matchFn: (name: string) => boolean,
): MethodStats {
  let matchCount = 0;
  let genericCount = 0;
  let constrainedCount = 0;
  let overloadedCount = 0;
  for (const method of methods) {
    if (!matchFn(method.name)) {
      continue;
    }
    matchCount++;
    if (method.typeParameters.length > 0) {
      genericCount++;
      if (method.typeParameters.some((tp) => tp.hasConstraint)) {
        constrainedCount++;
      }
    }
    if (method.overloadCount > 1) {
      overloadedCount++;
    }
  }
  return { constrainedCount, genericCount, matchCount, overloadedCount };
}

interface PositionLike {
  role: string;
  type: { getText(): string };
}

function hasTypedCallback(positions: readonly PositionLike[]): boolean {
  for (const pos of positions) {
    if (pos.role !== "param") {
      continue;
    }
    const typeText = pos.type.getText();
    if (typeText !== "any" && typeText !== "unknown" && typeText.includes("=>")) {
      return true;
    }
  }
  return false;
}

function isStoreRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("store") ||
    lower.includes("atom") ||
    lower.includes("state") ||
    lower.includes("slice") ||
    lower.includes("signal")
  );
}

function isSelectorRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("selector") ||
    lower.includes("derived") ||
    lower.includes("computed") ||
    lower.includes("getter") ||
    lower.includes("select")
  );
}

function isSubscribeRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("subscribe") ||
    lower.includes("listen") ||
    lower.includes("watch") ||
    lower.includes("on") ||
    lower.includes("observer")
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: Store/atom slice inference
// ---------------------------------------------------------------------------

const storeSliceInference: ScenarioTest = {
  description:
    "Store/atom types should have generic type params for state shape, enabling typed slice access and updates",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let storeDecls = 0;
    let genericStoreDecls = 0;
    let constrainedStoreDecls = 0;
    let multiParamStoreDecls = 0;
    let storeMethodsWithGenerics = 0;

    for (const decl of surface.declarations) {
      if (!isStoreRelated(decl.name)) {
        continue;
      }
      storeDecls++;

      if (decl.typeParameters.length > 0) {
        genericStoreDecls++;
        if (decl.typeParameters.length >= 2) {
          multiParamStoreDecls++;
        }
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedStoreDecls++;
        }
      }

      // Check methods for generic store operations (set, get, update)
      if (decl.methods) {
        for (const method of decl.methods) {
          if (method.typeParameters.length > 0) {
            storeMethodsWithGenerics++;
          }
        }
      }
    }

    // 40% compile-success: store declarations exist with generics
    let compileScore = 0;
    if (genericStoreDecls > 0) {
      compileScore = 40;
    } else if (storeDecls >= 2) {
      compileScore = 20;
    } else if (storeDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained store types reject wrong state shapes
    let failureScore = 0;
    if (constrainedStoreDecls > 0) {
      failureScore += 12;
    }
    if (multiParamStoreDecls > 0) {
      failureScore += 8;
    }
    if (storeMethodsWithGenerics > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic store types
    let exactnessScore = 0;
    if (genericStoreDecls >= 2) {
      exactnessScore += 12;
    }
    if (storeMethodsWithGenerics >= 2) {
      exactnessScore += 8;
    }
    if (multiParamStoreDecls > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: fewer untyped store decls
    let wrongPathScore = 0;
    const untypedStores = storeDecls - genericStoreDecls;
    if (untypedStores === 0 && storeDecls > 0) {
      wrongPathScore = 10;
    } else if (storeDecls > 0 && untypedStores < storeDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "storeSliceInference",
      passed,
      reason: passed
        ? `${genericStoreDecls} generic store types, ${constrainedStoreDecls} constrained, ${storeMethodsWithGenerics} generic methods`
        : "Limited store/atom type inference",
      score,
    });
  },
  name: "storeSliceInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Selector/derived state narrowing
// ---------------------------------------------------------------------------

const selectorNarrowing: ScenarioTest = {
  description:
    "Selectors/derived state should narrow store shape, propagating computed types through the state graph",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let selectorDecls = 0;
    let genericSelectors = 0;
    let constrainedSelectors = 0;
    let overloadedSelectors = 0;

    for (const decl of surface.declarations) {
      if (!isSelectorRelated(decl.name)) {
        continue;
      }
      selectorDecls++;

      if (decl.typeParameters.length > 0) {
        genericSelectors++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedSelectors++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedSelectors++;
      }

      // Check methods
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isSelectorRelated);
        selectorDecls += ms.matchCount;
        genericSelectors += ms.genericCount;
        constrainedSelectors += ms.constrainedCount;
        overloadedSelectors += ms.overloadedCount;
      }
    }

    if (selectorDecls === 0) {
      return makeResult({
        name: "selectorNarrowing",
        passed: false,
        reason: "No selector/derived declarations found",
        score: 25,
      });
    }

    // 40% compile-success: selector declarations with generics
    let compileScore = 0;
    if (genericSelectors > 0) {
      compileScore = 40;
    } else if (selectorDecls >= 2) {
      compileScore = 20;
    }

    // 25% compile-failure: constrained selectors reject wrong shapes
    let failureScore = 0;
    if (constrainedSelectors > 0) {
      failureScore += 15;
    }
    if (overloadedSelectors > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic selectors
    let exactnessScore = 0;
    if (genericSelectors >= 2) {
      exactnessScore += 15;
    }
    if (constrainedSelectors >= 2) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const nonGeneric = selectorDecls - genericSelectors;
    if (nonGeneric === 0 && selectorDecls > 0) {
      wrongPathScore = 10;
    } else if (nonGeneric < selectorDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "selectorNarrowing",
      passed,
      reason: passed
        ? `${genericSelectors}/${selectorDecls} generic selectors, ${constrainedSelectors} constrained, ${overloadedSelectors} overloaded`
        : "Selectors lack type narrowing",
      score,
    });
  },
  name: "selectorNarrowing",
};

// ---------------------------------------------------------------------------
// Scenario 3: Subscription typing
// ---------------------------------------------------------------------------

const subscriptionTyping: ScenarioTest = {
  description:
    "Subscribe/listener patterns should propagate state types, ensuring callbacks receive correctly typed state snapshots",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let subscribeDecls = 0;
    let genericSubscribes = 0;
    let constrainedSubscribes = 0;
    let typedCallbackSubscribes = 0;

    for (const decl of surface.declarations) {
      const nameMatch = isSubscribeRelated(decl.name);
      if (nameMatch) {
        subscribeDecls++;
        if (decl.typeParameters.length > 0) {
          genericSubscribes++;
          if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
            constrainedSubscribes++;
          }
        }
        // Check for typed callback params
        if (hasTypedCallback(decl.positions)) {
          typedCallbackSubscribes++;
        }
      }

      // Check methods
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isSubscribeRelated);
        subscribeDecls += ms.matchCount;
        genericSubscribes += ms.genericCount;
        constrainedSubscribes += ms.constrainedCount;

        // Check typed callbacks in subscribe methods
        for (const method of decl.methods) {
          if (isSubscribeRelated(method.name) && hasTypedCallback(method.positions)) {
            typedCallbackSubscribes++;
          }
        }
      }
    }

    if (subscribeDecls === 0) {
      return makeResult({
        name: "subscriptionTyping",
        passed: false,
        reason: "No subscribe/listener declarations found",
        score: 25,
      });
    }

    // 40% compile-success: subscribe declarations with generics
    let compileScore = 0;
    if (genericSubscribes > 0) {
      compileScore = 40;
    } else if (typedCallbackSubscribes > 0) {
      compileScore = 30;
    } else if (subscribeDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained subscriptions
    let failureScore = 0;
    if (constrainedSubscribes > 0) {
      failureScore += 15;
    }
    if (typedCallbackSubscribes > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic subscribes
    let exactnessScore = 0;
    if (genericSubscribes >= 2) {
      exactnessScore += 15;
    }
    if (typedCallbackSubscribes >= 2) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const nonGeneric = subscribeDecls - genericSubscribes;
    if (nonGeneric === 0 && subscribeDecls > 0) {
      wrongPathScore = 10;
    } else if (nonGeneric < subscribeDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "subscriptionTyping",
      passed,
      reason: passed
        ? `${genericSubscribes}/${subscribeDecls} generic subscribes, ${constrainedSubscribes} constrained, ${typedCallbackSubscribes} typed callbacks`
        : "Subscribe patterns lack type propagation",
      score,
    });
  },
  name: "subscriptionTyping",
};

// ---------------------------------------------------------------------------
// Scenario 4: Action/update payload precision
// ---------------------------------------------------------------------------

function isActionRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("action") ||
    lower.includes("dispatch") ||
    lower.includes("update") ||
    lower.includes("reducer") ||
    lower.includes("setstate")
  );
}

function hasAnyPayload(positions: readonly PositionLike[]): boolean {
  for (const pos of positions) {
    if (pos.role !== "param") {
      continue;
    }
    const typeText = pos.type.getText();
    if (typeText === "any") {
      return true;
    }
  }
  return false;
}

const actionPayloadPrecision: ScenarioTest = {
  description:
    "Action/update types should have typed payloads and preserve state shape through generic constraints on dispatch and reducers",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let actionDecls = 0;
    let genericActions = 0;
    let constrainedActions = 0;
    let anyPayloadCount = 0;
    let actionMethodCount = 0;

    for (const decl of surface.declarations) {
      if (!isActionRelated(decl.name)) {
        continue;
      }
      actionDecls++;

      if (decl.typeParameters.length > 0) {
        genericActions++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedActions++;
        }
      }

      // Check for any-typed payloads
      if (hasAnyPayload(decl.positions)) {
        anyPayloadCount++;
      }

      // Check methods for action/dispatch patterns
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isActionRelated);
        actionMethodCount += ms.matchCount;
        genericActions += ms.genericCount;
        constrainedActions += ms.constrainedCount;

        // Check for any payloads in action methods
        for (const method of decl.methods) {
          if (isActionRelated(method.name) && hasAnyPayload(method.positions)) {
            anyPayloadCount++;
          }
        }
      }
    }

    if (actionDecls === 0) {
      return makeResult({
        name: "actionPayloadPrecision",
        passed: false,
        reason: "No action/dispatch/update declarations found",
        score: 25,
      });
    }

    // 40% compile-success: action declarations exist
    let compileScore = 0;
    if (genericActions > 0) {
      compileScore = 40;
    } else if (actionDecls >= 2) {
      compileScore = 20;
    } else if (actionDecls > 0) {
      compileScore = 10;
    }

    // 25% inferred-type exactness: generic constraints on actions
    let exactnessScore = 0;
    if (constrainedActions > 0) {
      exactnessScore += 15;
    }
    if (genericActions >= 2) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 25% type safety: no any payloads
    let safetyScore = 0;
    const totalActionSurface = actionDecls + actionMethodCount;
    if (anyPayloadCount === 0 && totalActionSurface > 0) {
      safetyScore = 25;
    } else if (totalActionSurface > 0 && anyPayloadCount < totalActionSurface / 2) {
      safetyScore = 12;
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedActions = actionDecls - genericActions;
    if (untypedActions === 0 && actionDecls > 0) {
      wrongPathScore = 10;
    } else if (actionDecls > 0 && untypedActions < actionDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + exactnessScore + safetyScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "actionPayloadPrecision",
      passed,
      reason: passed
        ? `${genericActions}/${actionDecls} generic actions, ${constrainedActions} constrained, ${anyPayloadCount} any payloads`
        : "Action/update payloads lack type precision",
      score,
    });
  },
  name: "actionPayloadPrecision",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const STATE_PACK: ScenarioPack = {
  description:
    "Tests state management libraries for store inference, selector narrowing, subscription typing, and action payload precision",
  domain: "state",
  isApplicable: (surface) => {
    const stateNames = ["store", "atom", "signal", "selector", "dispatch", "derived", "state"];
    const matchCount = surface.declarations.filter((decl) =>
      stateNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 2,
      reason:
        matchCount >= 2
          ? `${matchCount} state-related declarations found`
          : "Insufficient state management declarations",
    };
  },
  name: "state",
  scenarios: [storeSliceInference, selectorNarrowing, subscriptionTyping, actionPayloadPrecision],
};
