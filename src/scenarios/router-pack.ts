import type { PublicSurface, SurfaceDeclaration, SurfaceMethod } from "../surface/types.js";
import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Router scenario pack.
 *
 * Tests how well a router library preserves type information
 * through route definitions, path parameters, search parameters,
 * loader results, and navigation helpers.
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

/** Check if a type text contains Extract<> or infer patterns */
function hasExtractOrInfer(text: string): boolean {
  return /\bExtract\s*</.test(text) || /\binfer\s+\w/.test(text);
}

/** Check if a declaration or its methods have constrained type params */
function hasConstrainedTypeParams(decl: SurfaceDeclaration): boolean {
  return decl.typeParameters.some((tp) => tp.hasConstraint);
}

/** Check methods on an interface/class for a given name pattern */
function findMethods(decl: SurfaceDeclaration, pattern: RegExp): SurfaceMethod[] {
  if (!decl.methods) {
    return [];
  }
  return decl.methods.filter((mt) => pattern.test(mt.name.toLowerCase()));
}

/** Check whether a type text indicates a literal union (string literal constituents) */
function hasLiteralUnion(text: string): boolean {
  return /["'`][^"'`]+["'`]\s*\|/.test(text) || /\|\s*["'`]/.test(text);
}

/** Check whether type text references generic params from the declaration */
function referencesGenericParam(typeText: string, typeParams: { name: string }[]): boolean {
  return typeParams.some((tp) => {
    const re = new RegExp(`\\b${tp.name}\\b`);
    return re.test(typeText);
  });
}

/** Name match helpers */
function isRouteRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("route") ||
    lower.includes("path") ||
    lower.includes("link") ||
    lower.includes("router") ||
    lower.includes("navigate")
  );
}

function isLoaderRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("loader") ||
    lower.includes("action") ||
    lower.includes("handler") ||
    lower.includes("middleware") ||
    lower.includes("beforeload")
  );
}

function isNavigationRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("link") ||
    lower.includes("navigate") ||
    lower.includes("redirect") ||
    lower.includes("href") ||
    lower.includes("goto") ||
    lower.includes("push")
  );
}

function isContextRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("context") ||
    lower.includes("outlet") ||
    lower.includes("children") ||
    lower.includes("layout") ||
    lower.includes("route")
  );
}

/** Count handler params that reference generic type params (extracted to reduce nesting) */
function countParamFlowToHandler(decl: SurfaceDeclaration): number {
  let count = 0;
  if (!decl.methods) {
    return count;
  }
  const handlerNames = /handler|component|loader|page/i;
  for (const method of decl.methods) {
    if (!handlerNames.test(method.name)) {
      continue;
    }
    for (const pos of method.positions) {
      if (pos.role === "param" && referencesGenericParam(pos.type.getText(), decl.typeParameters)) {
        count++;
      }
    }
  }
  return count;
}

/** Count parent/child patterns in type param constraints (extracted to reduce nesting) */
function countParentChildConstraintRefs(decl: SurfaceDeclaration): number {
  let count = 0;
  for (let idx = 0; idx < decl.typeParameters.length; idx++) {
    const tp = decl.typeParameters[idx]!;
    if (!tp.hasConstraint) {
      continue;
    }
    const constraintText = tp.constraintNode?.getText() ?? "";
    for (let jdx = 0; jdx < decl.typeParameters.length; jdx++) {
      if (idx === jdx) {
        continue;
      }
      if (constraintText.includes(decl.typeParameters[jdx]!.name)) {
        count++;
      }
    }
  }
  return count;
}

/** Classify a link position as type-safe or bare-string (extracted to reduce nesting) */
function classifyLinkProperty(typeText: string): "typeSafe" | "bareString" | "other" {
  if (typeText === "string" || typeText === "string | undefined") {
    return "bareString";
  }
  return "typeSafe";
}

// ---------------------------------------------------------------------------
// Scenario 1: Route tree path-param inference
// ---------------------------------------------------------------------------

const pathParamInference: ScenarioTest = {
  description:
    "Generic route definitions should preserve path parameter types through template literals, Extract<>, or infer patterns",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    // --- 40% compile-success: route-related declarations exist with template literal or generic params ---
    let compileScore = 0;
    let templateLiteralRoutes = 0;
    let constrainedRouteParams = 0;
    let routeDeclarations = 0;
    let extractInferPatterns = 0;
    let paramFlowToHandler = 0;

    for (const decl of surface.declarations) {
      if (!isRouteRelated(decl.name)) {
        continue;
      }
      routeDeclarations++;

      // Check type parameters for template literal or string constraints
      for (const tp of decl.typeParameters) {
        const constraintText = tp.constraintNode?.getText() ?? "";
        if (constraintText.includes("`") || constraintText.includes("string")) {
          constrainedRouteParams++;
        }
      }

      // Check positions for template literal features
      for (const pos of decl.positions) {
        const typeText = pos.type.getText();
        if (typeText.includes("`") && typeText.includes("${")) {
          templateLiteralRoutes++;
        }
        // Check for Extract<>/infer patterns in route-related type positions
        if (hasExtractOrInfer(typeText)) {
          extractInferPatterns++;
        }
      }

      // Check body of type aliases for Extract/infer
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (hasExtractOrInfer(bodyText)) {
          extractInferPatterns++;
        }
      }

      // Check if path params flow through to handler params (methods with params referencing type params)
      paramFlowToHandler += countParamFlowToHandler(decl);
    }

    if (routeDeclarations === 0) {
      return makeResult({
        name: "pathParamInference",
        passed: false,
        reason: "No route-related declarations found",
        score: 0,
      });
    }

    // Compile-success (40%): route declarations + template literals or generics
    if (templateLiteralRoutes > 0 || constrainedRouteParams > 0) {
      compileScore = 40;
    } else if (routeDeclarations >= 3) {
      compileScore = 20;
    }

    // --- 25% compile-failure: constraints reject wrong usage ---
    let failureScore = 0;
    if (constrainedRouteParams > 0) {
      failureScore += 15;
    }
    if (extractInferPatterns > 0) {
      failureScore += 10;
    }

    // --- 25% inferred-type exactness: template literals + param flow to handlers ---
    let exactnessScore = 0;
    if (templateLiteralRoutes > 0) {
      exactnessScore += 12;
    }
    if (paramFlowToHandler > 0) {
      exactnessScore += 13;
    } else if (extractInferPatterns > 0) {
      exactnessScore += 8;
    }

    // --- 10% wrong-path prevention: fewer ambiguous route decls is better ---
    let wrongPathScore = 0;
    const anyStringRoutes = surface.declarations.filter((dl) => {
      if (!isRouteRelated(dl.name)) {
        return false;
      }
      return dl.positions.some((ps) => ps.role === "param" && ps.type.getText() === "string");
    }).length;
    if (anyStringRoutes === 0 && routeDeclarations > 0) {
      wrongPathScore = 10;
    } else if (anyStringRoutes < routeDeclarations / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    const parts: string[] = [];
    if (templateLiteralRoutes > 0) {
      parts.push(`${templateLiteralRoutes} template-literal routes`);
    }
    if (constrainedRouteParams > 0) {
      parts.push(`${constrainedRouteParams} constrained params`);
    }
    if (extractInferPatterns > 0) {
      parts.push(`${extractInferPatterns} Extract/infer patterns`);
    }
    if (paramFlowToHandler > 0) {
      parts.push(`params flow to ${paramFlowToHandler} handlers`);
    }

    return makeResult({
      name: "pathParamInference",
      passed,
      reason: passed
        ? parts.join(", ") || "Route param inference detected"
        : "Limited path parameter type inference",
      score,
    });
  },
  name: "pathParamInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Search param inference
// ---------------------------------------------------------------------------

const searchParamInference: ScenarioTest = {
  description:
    "Search/query parameters should have branded/validated types, not just generic string",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let searchParamDecls = 0;
    let genericSearchParams = 0;
    let brandedSearchParams = 0;
    let constrainedSearchParams = 0;
    let bareStringParams = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        !lowerName.includes("search") &&
        !lowerName.includes("query") &&
        !lowerName.includes("params") &&
        !lowerName.includes("searchparams") &&
        !lowerName.includes("searchschema")
      ) {
        continue;
      }
      searchParamDecls++;

      // Generic search params
      if (decl.typeParameters.length > 0) {
        genericSearchParams++;
        // Check for constraints on the type params
        if (hasConstrainedTypeParams(decl)) {
          constrainedSearchParams++;
        }
      }

      // Check for branded/validated types (not just Record<string, string>)
      for (const pos of decl.positions) {
        const typeText = pos.type.getText();
        // Branded types often have __brand or unique symbol
        if (
          typeText.includes("__brand") ||
          typeText.includes("unique symbol") ||
          typeText.includes("Branded")
        ) {
          brandedSearchParams++;
        }
        // Bare string is a negative signal
        if (typeText === "string" || typeText === "Record<string, string>") {
          bareStringParams++;
        }
      }

      // Check type-alias body for branded patterns
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (
          bodyText.includes("__brand") ||
          bodyText.includes("unique symbol") ||
          bodyText.includes("readonly")
        ) {
          brandedSearchParams++;
        }
      }
    }

    if (searchParamDecls === 0) {
      // Not every router needs search params; give partial credit if they have route params
      return makeResult({
        name: "searchParamInference",
        passed: false,
        reason: "No search parameter declarations found",
        score: 20,
      });
    }

    // 40% compile-success: search param declarations exist with generics
    let compileScore = 0;
    if (genericSearchParams > 0) {
      compileScore = 40;
    } else if (searchParamDecls >= 2) {
      compileScore = 20;
    }

    // 25% compile-failure: constrained generics reject wrong usage
    let failureScore = 0;
    if (constrainedSearchParams > 0) {
      failureScore = 25;
    } else if (genericSearchParams > 0) {
      failureScore = 10;
    }

    // 25% inferred-type exactness: branded/validated types, not just string
    let exactnessScore = 0;
    if (brandedSearchParams > 0) {
      exactnessScore = 25;
    } else if (genericSearchParams > 0 && bareStringParams === 0) {
      exactnessScore = 15;
    } else if (genericSearchParams > 0) {
      exactnessScore = 8;
    }

    // 10% wrong-path prevention: bare string params are wrong paths
    let wrongPathScore = 0;
    if (bareStringParams === 0 && searchParamDecls > 0) {
      wrongPathScore = 10;
    } else if (bareStringParams < searchParamDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "searchParamInference",
      passed,
      reason: passed
        ? `${genericSearchParams}/${searchParamDecls} generic search params, ${constrainedSearchParams} constrained, ${brandedSearchParams} branded`
        : "Search params lack type inference",
      score,
    });
  },
  name: "searchParamInference",
};

// ---------------------------------------------------------------------------
// Scenario 3: Loader/action result propagation
// ---------------------------------------------------------------------------

const loaderResultPropagation: ScenarioTest = {
  description:
    "Loader/action return types should propagate through to component props via generic result types that preserve the loaded data shape",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let loaderDecls = 0;
    let typedLoaders = 0;
    let genericResultTypes = 0;
    let voidOrAnyLoaders = 0;
    let loaderWithGenericReturn = 0;

    for (const decl of surface.declarations) {
      if (!isLoaderRelated(decl.name)) {
        continue;
      }
      loaderDecls++;

      // Check for generic return type propagation
      if (decl.typeParameters.length > 0) {
        const returnPositions = decl.positions.filter((pos) => pos.role === "return");
        for (const pos of returnPositions) {
          const typeText = pos.type.getText();
          if (referencesGenericParam(typeText, decl.typeParameters)) {
            loaderWithGenericReturn++;
          }
        }
      }

      // Check for explicit result types that are not void/any
      if (decl.hasExplicitReturnType && decl.returnTypeNode) {
        const returnText = decl.returnTypeNode.getText();
        if (
          returnText === "void" ||
          returnText === "any" ||
          returnText === "Promise<void>" ||
          returnText === "Promise<any>"
        ) {
          voidOrAnyLoaders++;
        } else {
          typedLoaders++;
        }
      }
    }

    // Also check for generic result/data types that loaders produce
    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        (lowerName.includes("loaderdata") ||
          lowerName.includes("loaderreturn") ||
          lowerName.includes("routedata") ||
          lowerName.includes("pagedata") ||
          lowerName.includes("loaderfn")) &&
        decl.typeParameters.length > 0
      ) {
        genericResultTypes++;
      }
    }

    if (loaderDecls === 0) {
      return makeResult({
        name: "loaderResultPropagation",
        passed: false,
        reason: "No loader/action/handler declarations found",
        score: 30,
      });
    }

    // 40% compile-success: loader declarations with typed returns
    let compileScore = 0;
    const typedRatio = (typedLoaders + loaderWithGenericReturn) / loaderDecls;
    compileScore = Math.round(typedRatio * 40);

    // 25% compile-failure: void/any loaders = bad; generic result types = good
    let failureScore = 0;
    if (voidOrAnyLoaders === 0) {
      failureScore += 15;
    }
    if (genericResultTypes > 0) {
      failureScore += 10;
    }

    // 25% inferred-type exactness: generic return propagation
    let exactnessScore = 0;
    if (loaderWithGenericReturn > 0) {
      exactnessScore = 25;
    } else if (typedLoaders > 0) {
      exactnessScore = 12;
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (voidOrAnyLoaders === 0 && loaderDecls > 0) {
      wrongPathScore = 10;
    } else if (voidOrAnyLoaders < loaderDecls / 3) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "loaderResultPropagation",
      passed,
      reason: passed
        ? `${typedLoaders} typed loaders, ${loaderWithGenericReturn} with generic return propagation, ${genericResultTypes} generic result types`
        : "Loader/action results lack type propagation",
      score,
    });
  },
  name: "loaderResultPropagation",
};

// ---------------------------------------------------------------------------
// Scenario 4: Route narrowing after navigation
// ---------------------------------------------------------------------------

const routeNarrowing: ScenarioTest = {
  description:
    "Navigation helpers should narrow available routes to valid targets via string literal unions",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let navigationDecls = 0;
    let constrainedNavigation = 0;
    let literalUnionTargets = 0;
    let bareStringTargets = 0;
    let overloadedNavigation = 0;

    for (const decl of surface.declarations) {
      if (!isNavigationRelated(decl.name)) {
        continue;
      }
      navigationDecls++;

      // Check if route/path parameter is constrained (not just string)
      for (const pos of decl.positions) {
        if (pos.role !== "param") {
          continue;
        }
        const typeText = pos.type.getText();
        if (typeText === "string") {
          bareStringTargets++;
        } else if (hasLiteralUnion(typeText)) {
          literalUnionTargets++;
        }
      }

      // Check for generic constraints on navigation
      if (hasConstrainedTypeParams(decl)) {
        constrainedNavigation++;
      }

      // Check for overloaded navigation (multiple signatures = better)
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedNavigation++;
      }

      // Check methods on interfaces
      const navMethods = findMethods(decl, /navigate|push|goto|redirect/);
      for (const method of navMethods) {
        if (
          method.typeParameters.length > 0 &&
          method.typeParameters.some((tp) => tp.hasConstraint)
        ) {
          constrainedNavigation++;
        }
        if (method.overloadCount > 1) {
          overloadedNavigation++;
        }
      }
    }

    // Also check for route ID / route path type aliases with literal unions
    for (const decl of surface.declarations) {
      if (decl.kind !== "type-alias") {
        continue;
      }
      const lowerName = decl.name.toLowerCase();
      if (
        (lowerName.includes("routeid") ||
          lowerName.includes("routepath") ||
          lowerName.includes("routename") ||
          lowerName.includes("href")) &&
        decl.bodyTypeNode
      ) {
        const bodyText = decl.bodyTypeNode.getText();
        if (hasLiteralUnion(bodyText) || bodyText.includes("|")) {
          literalUnionTargets++;
        }
      }
    }

    if (navigationDecls === 0) {
      return makeResult({
        name: "routeNarrowing",
        passed: false,
        reason: "No navigation helper declarations found",
        score: 20,
      });
    }

    // 40% compile-success: navigation declarations with constraints or literal unions
    let compileScore = 0;
    if (constrainedNavigation > 0 || literalUnionTargets > 0) {
      compileScore = 40;
    } else if (navigationDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained params reject arbitrary strings
    let failureScore = 0;
    if (constrainedNavigation > 0) {
      failureScore += 15;
    }
    if (literalUnionTargets > 0) {
      failureScore += 10;
    }

    // 25% inferred-type exactness: literal union targets, overloaded navigation
    let exactnessScore = 0;
    if (literalUnionTargets > 0) {
      exactnessScore += 15;
    }
    if (overloadedNavigation > 0) {
      exactnessScore += 10;
    }

    // 10% wrong-path prevention: bare string targets are wrong paths
    let wrongPathScore = 0;
    if (bareStringTargets === 0 && navigationDecls > 0) {
      wrongPathScore = 10;
    } else if (bareStringTargets < navigationDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "routeNarrowing",
      passed,
      reason: passed
        ? `${constrainedNavigation} constrained, ${literalUnionTargets} literal-union targets, ${bareStringTargets} bare-string targets`
        : "Navigation helpers accept unconstrained routes",
      score,
    });
  },
  name: "routeNarrowing",
};

// ---------------------------------------------------------------------------
// Scenario 5: Nested route context propagation
// ---------------------------------------------------------------------------

const nestedRouteContext: ScenarioTest = {
  description:
    "Nested routes should propagate parent context/params to children via generic context types with parent/child relationships",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let contextDecls = 0;
    let genericContexts = 0;
    let parentChildPatterns = 0;
    let contextMethodsWithGenerics = 0;

    for (const decl of surface.declarations) {
      if (!isContextRelated(decl.name)) {
        continue;
      }
      contextDecls++;

      if (decl.typeParameters.length > 0) {
        genericContexts++;

        // Check for parent/child relationship: type params with constraints that reference other params
        parentChildPatterns += countParentChildConstraintRefs(decl);
      }

      // Check for nested generic structure in positions
      for (const pos of decl.positions) {
        const typeText = pos.type.getText();
        // Nested context: generic type containing children/outlet/route
        if (
          (typeText.includes("children") ||
            typeText.includes("outlet") ||
            typeText.includes("route")) &&
          decl.typeParameters.length > 0 &&
          referencesGenericParam(typeText, decl.typeParameters)
        ) {
          parentChildPatterns++;
        }
      }

      // Check methods on context interfaces for generic propagation
      if (decl.methods) {
        for (const method of decl.methods) {
          if (method.typeParameters.length > 0) {
            contextMethodsWithGenerics++;
          }
          // Check for useRouteContext / useParams patterns
          const methodLower = method.name.toLowerCase();
          if (
            (methodLower.includes("context") ||
              methodLower.includes("params") ||
              methodLower.includes("data")) &&
            method.typeParameters.length > 0
          ) {
            contextMethodsWithGenerics++;
          }
        }
      }

      // Check body of type aliases for recursive/nested patterns
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (
          (bodyText.includes("children") || bodyText.includes("routes")) &&
          bodyText.includes(decl.name)
        ) {
          // Self-referencing = recursive route tree
          parentChildPatterns++;
        }
      }
    }

    // Also look for useRouteContext / useParams type hooks
    for (const decl of surface.declarations) {
      if (decl.kind !== "function") {
        continue;
      }
      const lowerName = decl.name.toLowerCase();
      if (
        (lowerName.includes("useroutecontext") ||
          lowerName.includes("useparams") ||
          lowerName.includes("useloaderdata") ||
          lowerName.includes("usematch")) &&
        decl.typeParameters.length > 0
      ) {
        contextMethodsWithGenerics++;
      }
    }

    if (contextDecls === 0) {
      return makeResult({
        name: "nestedRouteContext",
        passed: false,
        reason: "No context/outlet declarations found",
        score: 25,
      });
    }

    // 40% compile-success: context declarations exist with generics
    let compileScore = 0;
    if (genericContexts > 0) {
      compileScore = 40;
    } else if (contextDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: parent/child patterns constrain nesting
    let failureScore = 0;
    if (parentChildPatterns > 0) {
      failureScore = 25;
    } else if (genericContexts > 0) {
      failureScore = 10;
    }

    // 25% inferred-type exactness: context methods with generics
    let exactnessScore = 0;
    if (contextMethodsWithGenerics > 0) {
      exactnessScore = Math.min(25, contextMethodsWithGenerics * 8);
    } else if (parentChildPatterns > 0) {
      exactnessScore = 10;
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (genericContexts > 0 && parentChildPatterns > 0) {
      wrongPathScore = 10;
    } else if (genericContexts > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "nestedRouteContext",
      passed,
      reason: passed
        ? `${genericContexts} generic contexts, ${parentChildPatterns} parent/child patterns, ${contextMethodsWithGenerics} generic context methods`
        : "Limited context propagation for nested routes",
      score,
    });
  },
  name: "nestedRouteContext",
};

// ---------------------------------------------------------------------------
// Scenario 6: Link target correctness (type-safe links)
// ---------------------------------------------------------------------------

const linkTargetCorrectness: ScenarioTest = {
  description:
    "Link components/functions should only accept valid route paths via compile-time route validation patterns",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let linkDecls = 0;
    let typeSafeLinks = 0;
    let bareStringLinks = 0;
    let overloadedLinks = 0;
    let genericLinkDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        !lowerName.includes("link") &&
        lowerName !== "a" &&
        !lowerName.includes("anchor") &&
        !lowerName.includes("navlink")
      ) {
        continue;
      }
      linkDecls++;

      // Check if the "to" or "href" property is constrained
      for (const pos of decl.positions) {
        const typeText = pos.type.getText();
        const posName = pos.name?.toLowerCase();
        if (posName === "to" || posName === "href" || posName === "path") {
          if (typeText === "string" || typeText === "string | undefined") {
            bareStringLinks++;
          } else {
            typeSafeLinks++;
          }
        }
      }

      // Check interface properties for "to" / "href"
      if (decl.kind === "interface" && decl.positions) {
        for (const pos of decl.positions) {
          const isTargetProp =
            pos.role === "property" &&
            (pos.name === "to" || pos.name === "href" || pos.name === "path");
          if (!isTargetProp) {
            continue;
          }
          const classification = classifyLinkProperty(pos.type.getText());
          if (classification === "typeSafe") {
            typeSafeLinks++;
          } else {
            bareStringLinks++;
          }
        }
      }

      // Generic link declarations (Link<TRoute>)
      if (decl.typeParameters.length > 0) {
        genericLinkDecls++;
        if (hasConstrainedTypeParams(decl)) {
          typeSafeLinks++;
        }
      }

      // Overloaded link functions
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedLinks++;
      }
    }

    // Check for route validation type utilities
    let routeValidationTypes = 0;
    for (const decl of surface.declarations) {
      if (decl.kind !== "type-alias") {
        continue;
      }
      const lowerName = decl.name.toLowerCase();
      if (
        (lowerName.includes("validroute") ||
          lowerName.includes("registeredroute") ||
          lowerName.includes("routeids") ||
          lowerName.includes("strictpath") ||
          lowerName.includes("tofullpath")) &&
        decl.typeParameters.length > 0
      ) {
        routeValidationTypes++;
      }
    }

    if (linkDecls === 0) {
      return makeResult({
        name: "linkTargetCorrectness",
        passed: false,
        reason: "No link declarations found",
        score: 30,
      });
    }

    // 40% compile-success: link declarations with type-safe targets
    let compileScore = 0;
    if (typeSafeLinks > 0 || genericLinkDecls > 0) {
      compileScore = 40;
    } else if (linkDecls >= 1) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained generics or validation types
    let failureScore = 0;
    if (routeValidationTypes > 0) {
      failureScore += 15;
    }
    if (genericLinkDecls > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: no bare string, overloaded
    let exactnessScore = 0;
    if (typeSafeLinks > 0 && bareStringLinks === 0) {
      exactnessScore = 25;
    } else if (typeSafeLinks > 0) {
      exactnessScore = 15;
    }
    if (overloadedLinks > 0) {
      exactnessScore = Math.min(25, exactnessScore + 5);
    }

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (bareStringLinks === 0 && linkDecls > 0) {
      wrongPathScore = 10;
    } else if (bareStringLinks < linkDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "linkTargetCorrectness",
      passed,
      reason: passed
        ? `${typeSafeLinks} type-safe links, ${genericLinkDecls} generic, ${routeValidationTypes} validation types, ${bareStringLinks} bare-string`
        : "Link targets accept any string",
      score,
    });
  },
  name: "linkTargetCorrectness",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const ROUTER_PACK: ScenarioPack = {
  description:
    "Tests router libraries for type-safe path params, search params, loaders, navigation, and context propagation",
  domain: "router",
  name: "router",
  scenarios: [
    pathParamInference,
    searchParamInference,
    loaderResultPropagation,
    routeNarrowing,
    nestedRouteContext,
    linkTargetCorrectness,
  ],
};
