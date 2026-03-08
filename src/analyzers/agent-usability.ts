import type { DimensionResult } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "agentUsability")!;

export function analyzeAgentUsability(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 50; // Start at midpoint

  // --- Named exports vs default exports ---
  let namedExports = 0;
  let defaultExports = 0;
  for (const decl of surface.declarations) {
    if (decl.name === "default" || decl.name === "<anonymous>") {
      defaultExports++;
    } else {
      namedExports++;
    }
  }

  const totalExports = namedExports + defaultExports;
  if (totalExports > 0) {
    const namedRatio = namedExports / totalExports;
    if (namedRatio >= 0.9) {
      score += 15;
      positives.push("Predominantly named exports (AI-agent friendly)");
    } else if (namedRatio >= 0.7) {
      score += 8;
      positives.push("Mostly named exports");
    } else if (defaultExports > namedExports) {
      score -= 10;
      negatives.push("Heavy use of default exports (harder for AI agents)");
    }
  }

  // --- Discriminated error unions vs generic Error types ---
  let hasDiscriminatedErrors = false;
  let hasGenericErrors = false;
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      const name = decl.name.toLowerCase();
      if (name.includes("error") || name.includes("result")) {
        const bodyText = decl.bodyTypeNode?.getText() ?? "";
        if (bodyText.includes("|") && (bodyText.includes("kind") || bodyText.includes("type") || bodyText.includes("tag") || bodyText.includes("_tag"))) {
          hasDiscriminatedErrors = true;
        }
      }
    }
    // Check for generic Error in return types
    for (const pos of decl.positions) {
      if (pos.role === "return") {
        const typeText = pos.type.getText();
        if (typeText === "Error" || typeText === "Promise<Error>") {
          hasGenericErrors = true;
        }
      }
    }
  }

  if (hasDiscriminatedErrors) {
    score += 10;
    positives.push("Uses discriminated error unions (precise error handling)");
  }
  if (hasGenericErrors) {
    score -= 5;
    negatives.push("Returns generic Error types");
  }

  // --- @example JSDoc tag coverage ---
  let functionsWithExample = 0;
  let totalFunctions = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalFunctions++;
      if (decl.hasJSDoc) {
        const jsDocs = (decl.node as any).getJsDocs?.() ?? [];
        for (const doc of jsDocs) {
          const tags = doc.getTags?.() ?? [];
          if (tags.some((tag: any) => tag.getTagName?.() === "example")) {
            functionsWithExample++;
            break;
          }
        }
      }
    }
  }

  if (totalFunctions > 0) {
    const exampleRatio = functionsWithExample / totalFunctions;
    if (exampleRatio >= 0.5) {
      score += 10;
      positives.push(`${functionsWithExample}/${totalFunctions} exported functions have @example`);
    } else if (exampleRatio >= 0.2) {
      score += 5;
      positives.push(`${functionsWithExample}/${totalFunctions} exported functions have @example`);
    } else if (totalFunctions >= 5) {
      score -= 5;
      negatives.push("Few functions have @example JSDoc tags");
    }
  }

  // --- Overload clarity ---
  let effectiveOverloads = 0;
  let totalOverloads = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function" && (decl.overloadCount ?? 0) > 0) {
      totalOverloads += decl.overloadCount!;
      // Check if overloads narrow types effectively
      // (presence of overloads = type narrowing attempt)
      effectiveOverloads += decl.overloadCount!;
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        if (method.overloadCount > 0) {
          totalOverloads += method.overloadCount;
          effectiveOverloads += method.overloadCount;
        }
      }
    }
  }

  if (effectiveOverloads > 0) {
    score += 5;
    positives.push(`${effectiveOverloads} overload(s) for type narrowing`);
  }

  // --- Readable generic parameter naming ---
  let readableGenericNames = 0;
  let totalGenericParams = 0;
  const CONVENTIONAL = new Set(["T", "K", "V", "U", "P", "R", "S", "E", "A", "B", "C"]);
  const CONVENTIONAL_PREFIX = /^T[A-Z]/;

  for (const decl of surface.declarations) {
    for (const tp of decl.typeParameters) {
      totalGenericParams++;
      if (CONVENTIONAL.has(tp.name) || CONVENTIONAL_PREFIX.test(tp.name) || tp.name.length > 2) {
        readableGenericNames++;
      }
    }
  }

  if (totalGenericParams > 0) {
    const readableRatio = readableGenericNames / totalGenericParams;
    if (readableRatio >= 0.9) {
      score += 5;
      positives.push("Generic parameter names are readable");
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      defaultExports,
      effectiveOverloads,
      functionsWithExample,
      namedExports,
      readableGenericNames,
      totalFunctions,
      totalGenericParams,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
