import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Frontend domain scenario pack.
 *
 * Tests how well a frontend/component library preserves types through
 * component props, event handlers, and render return types.
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
// Scenario 1: Component props inference
// ---------------------------------------------------------------------------

const componentPropsInference: ScenarioTest = {
  description:
    "Component props are properly typed and infer from usage — props-related declarations should be generic or constrained",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let propsDecls = 0;
    let genericPropsDecls = 0;
    let constrainedPropsDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      const hasPropsTypeParam = decl.typeParameters.some((tp) =>
        tp.name.toLowerCase().includes("props"),
      );

      if (lowerName.includes("props") || hasPropsTypeParam) {
        propsDecls++;
        if (decl.typeParameters.length > 0) {
          genericPropsDecls++;
        }
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedPropsDecls++;
        }
      }
    }

    if (propsDecls === 0) {
      return makeResult({
        name: "componentPropsInference",
        passed: false,
        reason: "No props declarations found",
        score: 0,
      });
    }

    // 40% compile-success: props declarations exist with generics
    let compileScore = 0;
    if (genericPropsDecls > 0) {
      compileScore = 40;
    } else if (propsDecls >= 2) {
      compileScore = 25;
    } else {
      compileScore = 15;
    }

    // 25% compile-failure: constrained props reject wrong shapes
    let failureScore = 0;
    if (constrainedPropsDecls > 0) {
      failureScore = 25;
    } else if (genericPropsDecls > 0) {
      failureScore = 12;
    }

    // 25% inferred-type exactness: multiple generic props declarations
    let exactnessScore = 0;
    if (genericPropsDecls >= 3) {
      exactnessScore = 25;
    } else if (genericPropsDecls >= 1) {
      exactnessScore = 12;
    } else if (propsDecls >= 3) {
      exactnessScore = 8;
    }

    // 10% wrong-path prevention: most props are typed, not loose
    let wrongPathScore = 0;
    if (genericPropsDecls === propsDecls && propsDecls > 0) {
      wrongPathScore = 10;
    } else if (genericPropsDecls > propsDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "componentPropsInference",
      passed,
      reason: passed
        ? `Found ${propsDecls} props declarations (${genericPropsDecls} generic, ${constrainedPropsDecls} constrained)`
        : `Only ${propsDecls} props declaration(s) found with weak typing`,
      score,
    });
  },
  name: "componentPropsInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Event handler typing
// ---------------------------------------------------------------------------

const eventHandlerTyping: ScenarioTest = {
  description:
    "Event handlers have specific types, not generic Function — onX and handler declarations should use precise callback types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let eventHandlerCount = 0;
    let wellTypedCount = 0;
    let genericHandlerCount = 0;

    for (const decl of surface.declarations) {
      const isHandler = /^on[A-Z]/.test(decl.name) || decl.name.toLowerCase().includes("handler");
      if (!isHandler) {
        continue;
      }
      eventHandlerCount++;

      // Check return type precision (not just Function or any)
      const hasSpecificType = decl.positions.some((pos) => {
        const typeText = pos.type.getText().toLowerCase();
        return typeText !== "function" && typeText !== "any" && typeText !== "unknown";
      });
      if (hasSpecificType) {
        wellTypedCount++;
      }

      if (decl.typeParameters.length > 0) {
        genericHandlerCount++;
      }
    }

    // Also check methods named onX or handler on interfaces
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const isHandler =
          /^on[A-Z]/.test(method.name) || method.name.toLowerCase().includes("handler");
        if (!isHandler) {
          continue;
        }
        eventHandlerCount++;
        // Methods with typed parameters are considered well-typed
        if (method.allParamsTyped) {
          wellTypedCount++;
        }
        if (method.typeParameters.length > 0) {
          genericHandlerCount++;
        }
      }
    }

    if (eventHandlerCount === 0) {
      return makeResult({
        name: "eventHandlerTyping",
        passed: false,
        reason: "No event handlers found",
        score: 0,
      });
    }

    const typedRatio = wellTypedCount / eventHandlerCount;

    // 40% compile-success: event handlers exist with specific types
    let compileScore = 0;
    if (typedRatio >= 0.7) {
      compileScore = 40;
    } else if (typedRatio >= 0.4) {
      compileScore = 25;
    } else if (wellTypedCount > 0) {
      compileScore = 15;
    }

    // 25% compile-failure: generic handlers reject wrong event shapes
    let failureScore = 0;
    if (genericHandlerCount > 0) {
      failureScore = 15;
    }
    if (typedRatio >= 0.8) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: high typed ratio
    let exactnessScore = 0;
    if (typedRatio >= 0.9) {
      exactnessScore = 25;
    } else if (typedRatio >= 0.6) {
      exactnessScore = 15;
    } else if (typedRatio >= 0.3) {
      exactnessScore = 8;
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (typedRatio >= 0.8) {
      wrongPathScore = 10;
    } else if (typedRatio >= 0.5) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "eventHandlerTyping",
      passed,
      reason: passed
        ? `${wellTypedCount}/${eventHandlerCount} event handlers well-typed`
        : `Only ${wellTypedCount}/${eventHandlerCount} event handlers have specific types`,
      score,
    });
  },
  name: "eventHandlerTyping",
};

// ---------------------------------------------------------------------------
// Scenario 3: Render return precision
// ---------------------------------------------------------------------------

const renderReturnPrecision: ScenarioTest = {
  description:
    "Render functions return precise element types — component factories and render helpers should not return `any`",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let renderDecls = 0;
    let preciseReturns = 0;
    let genericRenderDecls = 0;

    for (const decl of surface.declarations) {
      const isRender = /render|component|create.*element|jsx|createElement/i.test(decl.name);
      if (!isRender) {
        continue;
      }
      renderDecls++;

      // Check return type precision
      const hasReturnPos = decl.positions.some((pos) => {
        if (pos.role !== "return") {
          return false;
        }
        const typeText = pos.type.getText().toLowerCase();
        return typeText !== "any" && typeText !== "unknown" && typeText !== "void";
      });
      if (hasReturnPos) {
        preciseReturns++;
      }

      if (decl.typeParameters.length > 0) {
        genericRenderDecls++;
      }
    }

    // Also check methods
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const isRender = /render|component|create.*element/i.test(method.name);
        if (!isRender) {
          continue;
        }
        renderDecls++;
        if (method.hasExplicitReturnType) {
          preciseReturns++;
        }
        if (method.typeParameters.length > 0) {
          genericRenderDecls++;
        }
      }
    }

    if (renderDecls === 0) {
      return makeResult({
        name: "renderReturnPrecision",
        passed: false,
        reason: "No render functions found",
        score: 0,
      });
    }

    // 40% compile-success: render declarations with precise returns
    let compileScore = 0;
    if (preciseReturns > 0) {
      compileScore = 40;
    } else if (renderDecls >= 2) {
      compileScore = 20;
    }

    // 25% compile-failure: generic render declarations reject wrong components
    let failureScore = 0;
    if (genericRenderDecls > 0) {
      failureScore = 15;
    }
    if (preciseReturns >= 2) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: precision ratio
    let exactnessScore = 0;
    const precisionRatio = renderDecls > 0 ? preciseReturns / renderDecls : 0;
    if (precisionRatio >= 0.8) {
      exactnessScore = 25;
    } else if (precisionRatio >= 0.5) {
      exactnessScore = 15;
    } else if (preciseReturns > 0) {
      exactnessScore = 8;
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (precisionRatio >= 0.9) {
      wrongPathScore = 10;
    } else if (precisionRatio >= 0.5) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "renderReturnPrecision",
      passed,
      reason: passed
        ? `${preciseReturns}/${renderDecls} render functions return precise types`
        : `${renderDecls} render declarations but weak return type precision`,
      score,
    });
  },
  name: "renderReturnPrecision",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const FRONTEND_PACK: ScenarioPack = {
  description:
    "Tests frontend/component libraries for props inference, event handler typing, and render return precision",
  domain: "frontend",
  isApplicable: (surface) => {
    const propsDecls = surface.declarations.filter((decl) =>
      decl.name.toLowerCase().includes("props"),
    ).length;
    const componentDecls = surface.declarations.filter((decl) =>
      /render|component|jsx|createElement/i.test(decl.name),
    ).length;
    const handlerDecls = surface.declarations.filter(
      (decl) => /^on[A-Z]/.test(decl.name) || decl.name.toLowerCase().includes("handler"),
    ).length;
    const totalEvidence = propsDecls + componentDecls + handlerDecls;
    return {
      applicable: totalEvidence >= 2,
      reason:
        totalEvidence >= 2
          ? `${totalEvidence} frontend declarations found (${propsDecls} props, ${componentDecls} component, ${handlerDecls} handler)`
          : "Insufficient frontend declarations",
    };
  },
  name: "frontend",
  scenarios: [componentPropsInference, eventHandlerTyping, renderReturnPrecision],
};
