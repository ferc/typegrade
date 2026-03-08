import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/index.js";
import type { ScenarioResult } from "../types.js";

/**
 * Router scenario pack.
 *
 * Tests how well a router library preserves type information
 * through route definitions, path parameters, search parameters,
 * loader results, and navigation helpers.
 */

function makeResult(name: string, passed: boolean, score: number, reason: string): ScenarioResult {
  return { name, passed, reason, score };
}

/** Scenario: Route tree path-param inference */
const pathParamInference: ScenarioTest = {
  description:
    "Generic route definitions should preserve path parameter types through template literals or constrained generics",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;

    // Look for template literal types in route-related declarations
    let templateLiteralRoutes = 0;
    let constrainedRouteParams = 0;
    let routeDeclarations = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        !lowerName.includes("route") &&
        !lowerName.includes("path") &&
        !lowerName.includes("link")
      ) {
        continue;
      }
      routeDeclarations++;

      // Check type parameters for template literal or string constraints
      for (const tp of decl.typeParameters) {
        const constraintText = tp.constraint?.getText() ?? "";
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
      }
    }

    if (routeDeclarations === 0) {
      return makeResult("pathParamInference", false, 0, "No route-related declarations found");
    }

    if (templateLiteralRoutes > 0) {
      score += 40;
    }
    if (constrainedRouteParams > 0) {
      score += 30;
    }
    if (routeDeclarations >= 3) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "pathParamInference",
      passed,
      score,
      passed
        ? `${templateLiteralRoutes} template literal routes, ${constrainedRouteParams} constrained params`
        : "Limited path parameter type inference",
    );
  },
  name: "pathParamInference",
};

/** Scenario: Search param inference */
const searchParamInference: ScenarioTest = {
  description: "Search/query parameters should have typed definitions, not just string",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let searchParamDecls = 0;
    let typedSearchParams = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("search") ||
        lowerName.includes("query") ||
        lowerName.includes("params")
      ) {
        searchParamDecls++;
        // Check if the type is more specific than string or Record<string, string>
        for (const pos of decl.positions) {
          const typeText = pos.type.getText();
          if (
            !typeText.includes("string") ||
            typeText.includes("Record") ||
            typeText.includes("{")
          ) {
            typedSearchParams++;
          }
        }

        // Check type parameters (generic search params)
        if (decl.typeParameters.length > 0) {
          typedSearchParams++;
        }
      }
    }

    if (searchParamDecls === 0) {
      // Not every router needs search params; give partial credit if they have route params
      return makeResult(
        "searchParamInference",
        false,
        20,
        "No search parameter declarations found",
      );
    }

    if (typedSearchParams > 0) {
      score += 50;
    }
    if (searchParamDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "searchParamInference",
      passed,
      score,
      passed
        ? `${typedSearchParams}/${searchParamDecls} search params are typed`
        : "Search params lack type inference",
    );
  },
  name: "searchParamInference",
};

/** Scenario: Loader/action result propagation */
const loaderResultPropagation: ScenarioTest = {
  description:
    "Loader/action return types should propagate through to component props or page data",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let loaderDecls = 0;
    let typedLoaders = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("loader") ||
        lowerName.includes("action") ||
        lowerName.includes("handler") ||
        lowerName.includes("middleware")
      ) {
        loaderDecls++;

        // Check for generic return type propagation
        if (decl.typeParameters.length > 0) {
          const returnPositions = decl.positions.filter((p) => p.role === "return");
          for (const pos of returnPositions) {
            const typeText = pos.type.getText();
            // Return type references a generic = good propagation
            if (decl.typeParameters.some((tp) => typeText.includes(tp.name))) {
              typedLoaders++;
              break;
            }
          }
        }

        // Also check for explicit result types
        if (decl.hasExplicitReturnType && decl.returnTypeNode) {
          const returnText = decl.returnTypeNode.getText();
          if (
            returnText !== "void" &&
            returnText !== "any" &&
            returnText !== "Promise<void>" &&
            returnText !== "Promise<any>"
          ) {
            typedLoaders++;
          }
        }
      }
    }

    if (loaderDecls === 0) {
      return makeResult(
        "loaderResultPropagation",
        false,
        30,
        "No loader/action/handler declarations found",
      );
    }

    const ratio = typedLoaders / loaderDecls;
    score = Math.round(ratio * 80) + (loaderDecls >= 3 ? 20 : 0);
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "loaderResultPropagation",
      passed,
      score,
      passed
        ? `${typedLoaders}/${loaderDecls} loaders/actions have typed results`
        : "Loader/action results lack type propagation",
    );
  },
  name: "loaderResultPropagation",
};

/** Scenario: Route narrowing after navigation */
const routeNarrowing: ScenarioTest = {
  description: "Navigation helpers should narrow the available routes to valid targets",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let navigationDecls = 0;
    let constrainedNavigation = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("link") ||
        lowerName.includes("navigate") ||
        lowerName.includes("redirect") ||
        lowerName.includes("href")
      ) {
        navigationDecls++;

        // Check if route/path parameter is constrained (not just string)
        for (const pos of decl.positions) {
          if (pos.role === "param") {
            const typeText = pos.type.getText();
            // Good: literal unions, template literals, or constrained generics
            if (typeText.includes("|") || typeText.includes("`") || typeText.includes("extends")) {
              constrainedNavigation++;
              break;
            }
          }
        }

        // Check for generic constraints on navigation
        for (const tp of decl.typeParameters) {
          if (tp.constraint) {
            constrainedNavigation++;
            break;
          }
        }
      }
    }

    if (navigationDecls === 0) {
      return makeResult("routeNarrowing", false, 20, "No navigation helper declarations found");
    }

    if (constrainedNavigation > 0) {
      score += 60;
    }
    if (navigationDecls >= 2) {
      score += 20;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "routeNarrowing",
      passed,
      score,
      passed
        ? `${constrainedNavigation}/${navigationDecls} navigation helpers constrain routes`
        : "Navigation helpers accept unconstrained routes",
    );
  },
  name: "routeNarrowing",
};

/** Scenario: Nested route context propagation */
const nestedRouteContext: ScenarioTest = {
  description: "Nested routes should propagate parent context/params to children",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let contextDecls = 0;
    let genericContexts = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (
        lowerName.includes("context") ||
        lowerName.includes("outlet") ||
        lowerName.includes("children") ||
        lowerName.includes("layout")
      ) {
        contextDecls++;

        if (decl.typeParameters.length > 0) {
          genericContexts++;
        }

        // Check for nested generic structure
        for (const pos of decl.positions) {
          const typeText = pos.type.getText();
          if (typeText.includes("children") || typeText.includes("outlet")) {
            if (decl.typeParameters.length > 0) {
              genericContexts++;
            }
          }
        }
      }
    }

    if (contextDecls === 0) {
      return makeResult("nestedRouteContext", false, 25, "No context/outlet declarations found");
    }

    if (genericContexts > 0) {
      score += 50;
    }
    if (contextDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "nestedRouteContext",
      passed,
      score,
      passed
        ? `${genericContexts} generic context propagation patterns`
        : "Limited context propagation for nested routes",
    );
  },
  name: "nestedRouteContext",
};

/** Scenario: Link target correctness (type-safe links) */
const linkTargetCorrectness: ScenarioTest = {
  description: "Link components/functions should only accept valid route paths",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let score = 0;
    let linkDecls = 0;
    let typeSafeLinks = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();
      if (lowerName.includes("link") || lowerName === "a" || lowerName.includes("anchor")) {
        linkDecls++;

        // Check if the "to" or "href" property is constrained
        for (const pos of decl.positions) {
          const typeText = pos.type.getText();
          // Type-safe link: constrained string type, not just string
          if (pos.name?.toLowerCase() === "to" || pos.name?.toLowerCase() === "href") {
            if (typeText !== "string" && typeText !== "string | undefined") {
              typeSafeLinks++;
            }
          }
        }

        // Check interface properties
        if (decl.kind === "interface") {
          for (const pos of decl.positions) {
            if (pos.role === "property" && (pos.name === "to" || pos.name === "href")) {
              const typeText = pos.type.getText();
              if (typeText !== "string") {
                typeSafeLinks++;
              }
            }
          }
        }
      }
    }

    if (linkDecls === 0) {
      return makeResult("linkTargetCorrectness", false, 30, "No link declarations found");
    }

    if (typeSafeLinks > 0) {
      score += 70;
    }
    if (linkDecls >= 1) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult(
      "linkTargetCorrectness",
      passed,
      score,
      passed
        ? `${typeSafeLinks}/${linkDecls} link declarations have type-safe targets`
        : "Link targets accept any string",
    );
  },
  name: "linkTargetCorrectness",
};

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
