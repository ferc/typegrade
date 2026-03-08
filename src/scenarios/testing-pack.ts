import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Testing scenario pack.
 *
 * Tests how well a testing library preserves types through mock/spy definitions,
 * assertion/matcher patterns, and fixture/context lifecycle.
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

function isMockRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("mock") ||
    lower.includes("spy") ||
    lower.includes("stub") ||
    lower.includes("fake") ||
    lower.includes("fn")
  );
}

function isMatcherRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("expect") ||
    lower.includes("assert") ||
    lower.includes("matcher") ||
    lower.includes("tobe") ||
    lower.includes("toequal") ||
    lower.includes("tohave")
  );
}

function isFixtureRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("fixture") ||
    lower.includes("context") ||
    lower.includes("setup") ||
    lower.includes("beforeeach") ||
    lower.includes("beforeall") ||
    lower.includes("test")
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: Mock/spy precision
// ---------------------------------------------------------------------------

const mockPrecision: ScenarioTest = {
  description:
    "Mock/spy types should preserve the original function signature, ensuring typed return values and argument checking",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let mockDecls = 0;
    let genericMocks = 0;
    let constrainedMocks = 0;
    let multiParamMocks = 0;
    let overloadedMocks = 0;

    for (const decl of surface.declarations) {
      if (!isMockRelated(decl.name)) {
        continue;
      }
      mockDecls++;

      if (decl.typeParameters.length > 0) {
        genericMocks++;
        if (decl.typeParameters.length >= 2) {
          multiParamMocks++;
        }
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedMocks++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedMocks++;
      }

      // Check methods
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isMockRelated);
        mockDecls += ms.matchCount;
        genericMocks += ms.genericCount;
        constrainedMocks += ms.constrainedCount;
        overloadedMocks += ms.overloadedCount;
      }
    }

    // 40% compile-success: mock declarations exist with generics
    let compileScore = 0;
    if (genericMocks > 0) {
      compileScore = 40;
    } else if (mockDecls >= 2) {
      compileScore = 20;
    } else if (mockDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained mocks reject wrong function signatures
    let failureScore = 0;
    if (constrainedMocks > 0) {
      failureScore += 12;
    }
    if (multiParamMocks > 0) {
      failureScore += 8;
    }
    if (overloadedMocks > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic mocks
    let exactnessScore = 0;
    if (genericMocks >= 2) {
      exactnessScore += 12;
    }
    if (constrainedMocks >= 2) {
      exactnessScore += 8;
    }
    if (multiParamMocks > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedMocks = mockDecls - genericMocks;
    if (untypedMocks === 0 && mockDecls > 0) {
      wrongPathScore = 10;
    } else if (mockDecls > 0 && untypedMocks < mockDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "mockPrecision",
      passed,
      reason: passed
        ? `${genericMocks} generic mocks, ${constrainedMocks} constrained, ${overloadedMocks} overloaded`
        : "Limited mock/spy type precision",
      score,
    });
  },
  name: "mockPrecision",
};

// ---------------------------------------------------------------------------
// Scenario 2: Matcher/assertion specificity
// ---------------------------------------------------------------------------

const matcherSpecificity: ScenarioTest = {
  description:
    "Assertion/matcher types should narrow expected values, providing type-safe expect chains",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let matcherDecls = 0;
    let genericMatchers = 0;
    let constrainedMatchers = 0;
    let overloadedMatchers = 0;
    let matcherMethods = 0;

    for (const decl of surface.declarations) {
      if (!isMatcherRelated(decl.name)) {
        continue;
      }
      matcherDecls++;

      if (decl.typeParameters.length > 0) {
        genericMatchers++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedMatchers++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedMatchers++;
      }

      // Check methods for matcher chains (toBe, toEqual, toHaveProperty, etc.)
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isMatcherRelated);
        matcherMethods += ms.matchCount;
        genericMatchers += ms.genericCount;
        constrainedMatchers += ms.constrainedCount;
        overloadedMatchers += ms.overloadedCount;
      }
    }

    if (matcherDecls === 0 && matcherMethods === 0) {
      return makeResult({
        name: "matcherSpecificity",
        passed: false,
        reason: "No assertion/matcher declarations found",
        score: 25,
      });
    }

    const totalMatcherSurface = matcherDecls + matcherMethods;

    // 40% compile-success: matcher declarations with generics
    let compileScore = 0;
    if (genericMatchers > 0) {
      compileScore = 40;
    } else if (totalMatcherSurface >= 3) {
      compileScore = 20;
    } else if (totalMatcherSurface > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained matchers reject wrong types
    let failureScore = 0;
    if (constrainedMatchers > 0) {
      failureScore += 12;
    }
    if (overloadedMatchers > 0) {
      failureScore += 8;
    }
    if (matcherMethods >= 3) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: rich matcher chains
    let exactnessScore = 0;
    if (genericMatchers >= 2) {
      exactnessScore += 12;
    }
    if (matcherMethods >= 5) {
      exactnessScore += 8;
    }
    if (overloadedMatchers > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedMatchers = matcherDecls - genericMatchers;
    if (untypedMatchers <= 0 && matcherDecls > 0) {
      wrongPathScore = 10;
    } else if (matcherDecls > 0 && untypedMatchers < matcherDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "matcherSpecificity",
      passed,
      reason: passed
        ? `${genericMatchers} generic matchers, ${constrainedMatchers} constrained, ${matcherMethods} matcher methods`
        : "Matchers lack type specificity",
      score,
    });
  },
  name: "matcherSpecificity",
};

// ---------------------------------------------------------------------------
// Scenario 3: Fixture/context typing
// ---------------------------------------------------------------------------

const fixtureTyping: ScenarioTest = {
  description:
    "Fixture/context types should propagate through test lifecycle, ensuring typed setup and teardown",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let fixtureDecls = 0;
    let genericFixtures = 0;
    let constrainedFixtures = 0;
    let fixtureMethodCount = 0;

    for (const decl of surface.declarations) {
      if (!isFixtureRelated(decl.name)) {
        continue;
      }
      fixtureDecls++;

      if (decl.typeParameters.length > 0) {
        genericFixtures++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedFixtures++;
        }
      }

      // Check methods for lifecycle patterns
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isFixtureRelated);
        fixtureMethodCount += ms.matchCount;
        genericFixtures += ms.genericCount;
        constrainedFixtures += ms.constrainedCount;
      }
    }

    if (fixtureDecls === 0) {
      return makeResult({
        name: "fixtureTyping",
        passed: false,
        reason: "No fixture/context declarations found",
        score: 25,
      });
    }

    // 40% compile-success: fixture declarations with generics
    let compileScore = 0;
    if (genericFixtures > 0) {
      compileScore = 40;
    } else if (fixtureDecls >= 2) {
      compileScore = 20;
    } else if (fixtureDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained fixtures reject wrong context types
    let failureScore = 0;
    if (constrainedFixtures > 0) {
      failureScore += 15;
    }
    if (fixtureMethodCount >= 2) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic fixtures
    let exactnessScore = 0;
    if (genericFixtures >= 2) {
      exactnessScore += 15;
    }
    if (constrainedFixtures > 0) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedFixtures = fixtureDecls - genericFixtures;
    if (untypedFixtures === 0 && fixtureDecls > 0) {
      wrongPathScore = 10;
    } else if (fixtureDecls > 0 && untypedFixtures < fixtureDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "fixtureTyping",
      passed,
      reason: passed
        ? `${genericFixtures} generic fixtures, ${constrainedFixtures} constrained, ${fixtureMethodCount} lifecycle methods`
        : "Fixtures lack type propagation",
      score,
    });
  },
  name: "fixtureTyping",
};

// ---------------------------------------------------------------------------
// Scenario 4: Request/response helper typing
// ---------------------------------------------------------------------------

function isRequestRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("request") ||
    lower.includes("response") ||
    lower.includes("handler") ||
    lower.includes("intercept") ||
    lower.includes("supertest") ||
    lower.includes("fetch")
  );
}

interface PositionLike {
  role: string;
  type: { getText(): string };
}

function hasDiscriminatedType(positions: readonly PositionLike[]): boolean {
  for (const pos of positions) {
    const typeText = pos.type.getText();
    // Check for status code or body type discrimination patterns
    const isTyped = typeText !== "any" && typeText !== "unknown";
    const hasStructure = typeText.includes("|") || typeText.includes("&") || typeText.includes("<");
    if (isTyped && hasStructure) {
      return true;
    }
  }
  return false;
}

const requestResponseHelperTyping: ScenarioTest = {
  description:
    "Request/response helpers should preserve HTTP method and path inference, with typed status codes and body discrimination",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let requestDecls = 0;
    let genericRequests = 0;
    let constrainedRequests = 0;
    let overloadedRequests = 0;
    let discriminatedRequests = 0;
    let requestMethodCount = 0;

    for (const decl of surface.declarations) {
      if (!isRequestRelated(decl.name)) {
        continue;
      }
      requestDecls++;

      if (decl.typeParameters.length > 0) {
        genericRequests++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedRequests++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedRequests++;
      }

      // Check for discriminated response types
      if (hasDiscriminatedType(decl.positions)) {
        discriminatedRequests++;
      }

      // Check methods for request/response patterns
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isRequestRelated);
        requestMethodCount += ms.matchCount;
        genericRequests += ms.genericCount;
        constrainedRequests += ms.constrainedCount;
        overloadedRequests += ms.overloadedCount;

        // Check for discriminated types in methods
        for (const method of decl.methods) {
          if (isRequestRelated(method.name) && hasDiscriminatedType(method.positions)) {
            discriminatedRequests++;
          }
        }
      }
    }

    if (requestDecls === 0) {
      return makeResult({
        name: "requestResponseHelperTyping",
        passed: false,
        reason: "No request/response/handler declarations found",
        score: 25,
      });
    }

    // 40% compile-success: request declarations with generics
    let compileScore = 0;
    if (genericRequests > 0) {
      compileScore = 40;
    } else if (requestDecls >= 2 || requestMethodCount >= 2) {
      compileScore = 20;
    } else if (requestDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained requests reject wrong types
    let failureScore = 0;
    if (constrainedRequests > 0) {
      failureScore += 12;
    }
    if (overloadedRequests > 0) {
      failureScore += 8;
    }
    if (discriminatedRequests > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: rich request/response types
    let exactnessScore = 0;
    if (genericRequests >= 2) {
      exactnessScore += 12;
    }
    if (constrainedRequests >= 2) {
      exactnessScore += 8;
    }
    if (discriminatedRequests >= 2) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedRequests = requestDecls - genericRequests;
    if (untypedRequests <= 0 && requestDecls > 0) {
      wrongPathScore = 10;
    } else if (requestDecls > 0 && untypedRequests < requestDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "requestResponseHelperTyping",
      passed,
      reason: passed
        ? `${genericRequests} generic requests, ${constrainedRequests} constrained, ${discriminatedRequests} discriminated`
        : "Request/response helpers lack type precision",
      score,
    });
  },
  name: "requestResponseHelperTyping",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const TESTING_PACK: ScenarioPack = {
  description:
    "Tests testing libraries for mock precision, matcher specificity, fixture typing, and request/response helpers",
  domain: "testing",
  isApplicable: (surface) => {
    const testingNames = ["mock", "fixture", "stub", "spy", "assert", "matcher", "expect"];
    const matchCount = surface.declarations.filter((decl) =>
      testingNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 2,
      reason:
        matchCount >= 2
          ? `${matchCount} testing-related declarations found`
          : "Insufficient testing declarations",
    };
  },
  name: "testing",
  scenarios: [mockPrecision, matcherSpecificity, fixtureTyping, requestResponseHelperTyping],
};

// ---------------------------------------------------------------------------
// Testing-library variant (query, render, screen patterns)
// ---------------------------------------------------------------------------

function isQueryRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("getby") ||
    lower.includes("queryby") ||
    lower.includes("findby") ||
    lower.includes("getall") ||
    lower.includes("queryall") ||
    lower.includes("findall") ||
    lower.includes("within")
  );
}

function isRenderRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("render") ||
    lower.includes("screen") ||
    lower.includes("cleanup") ||
    lower.includes("act") ||
    lower.includes("fireevent") ||
    lower.includes("userevent")
  );
}

const queryUtilityTyping: ScenarioTest = {
  description: "Query utilities should return typed elements with proper generic constraints",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let queryDecls = 0;
    let genericQueries = 0;
    let constrainedQueries = 0;
    let overloadedQueries = 0;

    for (const decl of surface.declarations) {
      if (!isQueryRelated(decl.name)) {
        continue;
      }
      queryDecls++;
      if (decl.typeParameters.length > 0) {
        genericQueries++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedQueries++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedQueries++;
      }
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isQueryRelated);
        queryDecls += ms.matchCount;
        genericQueries += ms.genericCount;
        constrainedQueries += ms.constrainedCount;
        overloadedQueries += ms.overloadedCount;
      }
    }

    let compileScore = 0;
    if (genericQueries > 0) {
      compileScore = 40;
    } else if (queryDecls >= 2) {
      compileScore = 20;
    } else if (queryDecls > 0) {
      compileScore = 10;
    }
    const failureScore = Math.min(
      25,
      (constrainedQueries > 0 ? 12 : 0) + (overloadedQueries > 0 ? 8 : 0),
    );
    const exactnessScore = Math.min(
      25,
      (genericQueries >= 2 ? 12 : 0) +
        (constrainedQueries >= 2 ? 8 : 0) +
        (overloadedQueries > 0 ? 5 : 0),
    );
    let wrongPathScore = 0;
    if (queryDecls > 0 && queryDecls === genericQueries) {
      wrongPathScore = 10;
    } else if (queryDecls > 0) {
      wrongPathScore = 5;
    }
    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    return makeResult({
      name: "queryUtilityTyping",
      passed: score >= 40,
      reason:
        score >= 40
          ? `${genericQueries} generic queries, ${constrainedQueries} constrained, ${overloadedQueries} overloaded`
          : "Query utilities lack type precision",
      score,
    });
  },
  name: "queryUtilityTyping",
};

const renderHelperTyping: ScenarioTest = {
  description: "Render helpers should accept typed component props and return typed containers",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let renderDecls = 0;
    let genericRenders = 0;
    let constrainedRenders = 0;

    for (const decl of surface.declarations) {
      if (!isRenderRelated(decl.name)) {
        continue;
      }
      renderDecls++;
      if (decl.typeParameters.length > 0) {
        genericRenders++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedRenders++;
        }
      }
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isRenderRelated);
        renderDecls += ms.matchCount;
        genericRenders += ms.genericCount;
        constrainedRenders += ms.constrainedCount;
      }
    }

    let compileScore = 0;
    if (genericRenders > 0) {
      compileScore = 40;
    } else if (renderDecls >= 2) {
      compileScore = 20;
    } else if (renderDecls > 0) {
      compileScore = 10;
    }
    const failureScore = Math.min(
      25,
      (constrainedRenders > 0 ? 15 : 0) + (genericRenders >= 2 ? 10 : 0),
    );
    const exactnessScore = Math.min(
      25,
      (genericRenders >= 2 ? 15 : 0) + (constrainedRenders > 0 ? 10 : 0),
    );
    let wrongPathScore = 0;
    if (renderDecls > 0 && renderDecls <= genericRenders) {
      wrongPathScore = 10;
    } else if (renderDecls > 0) {
      wrongPathScore = 5;
    }
    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    return makeResult({
      name: "renderHelperTyping",
      passed: score >= 40,
      reason:
        score >= 40
          ? `${genericRenders} generic renders, ${constrainedRenders} constrained`
          : "Render helpers lack typed props",
      score,
    });
  },
  name: "renderHelperTyping",
};

export const TESTING_LIBRARY_PACK: ScenarioPack = {
  description:
    "Tests testing-library style packages for query utility typing, render helpers, and event helpers",
  domain: "testing",
  isApplicable: (surface) => {
    const tlNames = [
      "render",
      "screen",
      "getby",
      "queryby",
      "findby",
      "within",
      "cleanup",
      "fireevent",
    ];
    const matchCount = surface.declarations.filter((decl) =>
      tlNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 3,
      reason:
        matchCount >= 3
          ? `${matchCount} testing-library declarations found`
          : "Insufficient testing-library declarations",
    };
  },
  name: "testing-library",
  scenarios: [queryUtilityTyping, renderHelperTyping, matcherSpecificity],
  variant: "testing-library",
};

export const TESTING_HTTP_PACK: ScenarioPack = {
  description: "Tests HTTP testing libraries for request/response helper typing and mock precision",
  domain: "testing",
  isApplicable: (surface) => {
    const httpNames = ["request", "response", "intercept", "handler", "server", "listen", "fetch"];
    const matchCount = surface.declarations.filter((decl) =>
      httpNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 3,
      reason:
        matchCount >= 3
          ? `${matchCount} HTTP testing declarations found`
          : "Insufficient HTTP testing declarations",
    };
  },
  name: "testing-http",
  scenarios: [requestResponseHelperTyping, mockPrecision],
  variant: "testing-http",
};

export const TESTING_RUNNER_PACK: ScenarioPack = {
  description:
    "Tests test runner libraries for mock precision, matcher specificity, and fixture lifecycle",
  domain: "testing",
  isApplicable: (surface) => {
    const runnerNames = [
      "describe",
      "test",
      "it",
      "beforeeach",
      "aftereach",
      "expect",
      "mock",
      "vi",
    ];
    const matchCount = surface.declarations.filter((decl) =>
      runnerNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    return {
      applicable: matchCount >= 3,
      reason:
        matchCount >= 3
          ? `${matchCount} test-runner declarations found`
          : "Insufficient test-runner declarations",
    };
  },
  name: "testing-runner",
  scenarios: [mockPrecision, matcherSpecificity, fixtureTyping],
  variant: "testing-runner",
};
