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

interface MakeResultOpts {
  name: string;
  passed: boolean;
  score: number;
  reason: string;
}

function makeResult(opts: MakeResultOpts): ScenarioResult {
  return { name: opts.name, passed: opts.passed, reason: opts.reason, score: opts.score };
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
      return makeResult({ name: "pathParamInference", passed: false, reason: "No route-related declarations found", score: 0 });
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
    return makeResult({ name: "pathParamInference", passed: passed, reason: passed
        ? `${templateLiteralRoutes} template literal routes, ${constrainedRouteParams} constrained params`
        : "Limited path parameter type inference", score: score });
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
      return makeResult({ name: "searchParamInference", passed: false, reason: "No search parameter declarations found", score: 20 });
    }

    if (typedSearchParams > 0) {
      score += 50;
    }
    if (searchParamDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "searchParamInference", passed: passed, reason: passed
        ? `${typedSearchParams}/${searchParamDecls} search params are typed`
        : "Search params lack type inference", score: score });
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
        if (decl.typeParameters.length > 0 && hasGenericReturnPropagation(decl)) {
          typedLoaders++;
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
      return makeResult({ name: "loaderResultPropagation", passed: false, reason: "No loader/action/handler declarations found", score: 30 });
    }

    const ratio = typedLoaders / loaderDecls;
    score = Math.round(ratio * 80) + (loaderDecls >= 3 ? 20 : 0);
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "loaderResultPropagation", passed: passed, reason: passed
        ? `${typedLoaders}/${loaderDecls} loaders/actions have typed results`
        : "Loader/action results lack type propagation", score: score });
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
        const hasConstrainedParam = decl.positions.some((pos) => {
          if (pos.role !== "param") {
            return false;
          }
          const typeText = pos.type.getText();
          return typeText.includes("|") || typeText.includes("`") || typeText.includes("extends");
        });
        if (hasConstrainedParam) {
          constrainedNavigation++;
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
      return makeResult({ name: "routeNarrowing", passed: false, reason: "No navigation helper declarations found", score: 20 });
    }

    if (constrainedNavigation > 0) {
      score += 60;
    }
    if (navigationDecls >= 2) {
      score += 20;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "routeNarrowing", passed: passed, reason: passed
        ? `${constrainedNavigation}/${navigationDecls} navigation helpers constrain routes`
        : "Navigation helpers accept unconstrained routes", score: score });
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
          if ((typeText.includes("children") || typeText.includes("outlet")) && decl.typeParameters.length > 0) {
            genericContexts++;
          }
        }
      }
    }

    if (contextDecls === 0) {
      return makeResult({ name: "nestedRouteContext", passed: false, reason: "No context/outlet declarations found", score: 25 });
    }

    if (genericContexts > 0) {
      score += 50;
    }
    if (contextDecls >= 2) {
      score += 25;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "nestedRouteContext", passed: passed, reason: passed
        ? `${genericContexts} generic context propagation patterns`
        : "Limited context propagation for nested routes", score: score });
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
          const posName = pos.name?.toLowerCase();
          // Type-safe link: constrained string type, not just string
          if ((posName === "to" || posName === "href") && typeText !== "string" && typeText !== "string | undefined") {
            typeSafeLinks++;
          }
        }

        // Check interface properties
        if (decl.kind === "interface") {
          typeSafeLinks += countTypeSafeInterfaceLinks(decl);
        }
      }
    }

    if (linkDecls === 0) {
      return makeResult({ name: "linkTargetCorrectness", passed: false, reason: "No link declarations found", score: 30 });
    }

    if (typeSafeLinks > 0) {
      score += 70;
    }
    if (linkDecls >= 1) {
      score += 15;
    }
    score = Math.min(100, score);

    const passed = score >= 40;
    return makeResult({ name: "linkTargetCorrectness", passed: passed, reason: passed
        ? `${typeSafeLinks}/${linkDecls} link declarations have type-safe targets`
        : "Link targets accept any string", score: score });
  },
  name: "linkTargetCorrectness",
};

function countTypeSafeInterfaceLinks(decl: { positions: { role: string; name?: string; type: { getText(): string } }[] }): number {
  let count = 0;
  for (const pos of decl.positions) {
    if (pos.role === "property" && (pos.name === "to" || pos.name === "href") && pos.type.getText() !== "string") {
      count++;
    }
  }
  return count;
}

function hasGenericReturnPropagation(decl: { typeParameters: { name: string }[]; positions: { role: string; type: { getText(): string } }[] }): boolean {
  const returnPositions = decl.positions.filter((pos) => pos.role === "return");
  for (const pos of returnPositions) {
    const typeText = pos.type.getText();
    if (decl.typeParameters.some((tp) => typeText.includes(tp.name))) {
      return true;
    }
  }
  return false;
}

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
