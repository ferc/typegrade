import type { DimensionResult } from "../types.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "agentUsability")!;

/**
 * Consumer-guidance analyzer: measures how well the API guides
 * AI agents and human consumers toward correct usage.
 *
 * Signals:
 * - Inference stability
 * - Ambiguity of overload resolution
 * - Parameter-to-result predictability
 * - Discoverability of the correct export/symbol
 * - Discriminant-rich workflows
 * - Readability of emitted helper types
 * - Number of plausible wrong paths
 */
export function analyzeAgentUsability(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  let score = 50; // Start at midpoint

  // --- Named exports vs default exports (discoverability) ---
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
      score += 12;
      positives.push("Predominantly named exports (AI-agent friendly, +12)");
    } else if (namedRatio >= 0.7) {
      score += 6;
      positives.push("Mostly named exports (+6)");
    } else if (defaultExports > namedExports) {
      score -= 10;
      negatives.push("Heavy use of default exports (harder for AI agents, -10)");
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
        if (
          bodyText.includes("|") &&
          (bodyText.includes("kind") ||
            bodyText.includes("type") ||
            bodyText.includes("tag") ||
            bodyText.includes("_tag"))
        ) {
          hasDiscriminatedErrors = true;
        }
      }
    }
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
    positives.push("Uses discriminated error unions (precise error handling, +10)");
  }
  if (hasGenericErrors) {
    score -= 5;
    negatives.push("Returns generic Error types (-5)");
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
      score += 8;
      positives.push(
        `${functionsWithExample}/${totalFunctions} exported functions have @example (+8)`,
      );
    } else if (exampleRatio >= 0.2) {
      score += 4;
      positives.push(
        `${functionsWithExample}/${totalFunctions} exported functions have @example (+4)`,
      );
    } else if (totalFunctions >= 5) {
      score -= 5;
      negatives.push("Few functions have @example JSDoc tags (-5)");
    }
  }

  // --- Overload ambiguity detection (inference stability) ---
  let clearOverloads = 0;
  let ambiguousOverloads = 0;
  let _totalOverloadedFunctions = 0;

  for (const decl of surface.declarations) {
    if (decl.kind === "function" && (decl.overloadCount ?? 0) > 1) {
      _totalOverloadedFunctions++;
      const overloads = decl.overloadCount!;
      if (overloads <= 4) {
        clearOverloads++;
      } else if (overloads > 6) {
        ambiguousOverloads++;
      }
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        if (method.overloadCount > 1) {
          _totalOverloadedFunctions++;
          if (method.overloadCount <= 4) {
            clearOverloads++;
          } else if (method.overloadCount > 6) {
            ambiguousOverloads++;
          }
        }
      }
    }
  }

  if (clearOverloads > 0 && ambiguousOverloads === 0) {
    score += 5;
    positives.push(`${clearOverloads} function(s) with clear overload patterns (+5)`);
  } else if (ambiguousOverloads > 0) {
    const penalty = Math.min(10, ambiguousOverloads * 3);
    score -= penalty;
    negatives.push(`${ambiguousOverloads} function(s) with excessive overloads (>6, -${penalty})`);
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
      positives.push("Generic parameter names are readable (+5)");
    }
  }

  // --- Parameter-to-result predictability (correlated generics) ---
  let correlatedGenericFunctions = 0;
  let functionsWithGenerics = 0;

  for (const decl of surface.declarations) {
    if (decl.kind === "function" && decl.typeParameters.length > 0) {
      functionsWithGenerics++;
      const typeParamNames = decl.typeParameters.map((tp) => tp.name);
      const paramTexts = (decl.paramTypeNodes ?? [])
        .map((p) => p.typeNode?.getText() ?? "")
        .join(" ");
      const returnText = decl.returnTypeNode?.getText() ?? "";

      const hasCorrelation = typeParamNames.some(
        (name) => paramTexts.includes(name) && returnText.includes(name),
      );
      if (hasCorrelation) {
        correlatedGenericFunctions++;
      }
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        if (method.typeParameters.length > 0) {
          functionsWithGenerics++;
          const typeParamNames = method.typeParameters.map((tp) => tp.name);
          const paramTexts = method.paramTypeNodes
            .map((p) => p.typeNode?.getText() ?? "")
            .join(" ");
          const returnText = method.returnTypeNode?.getText() ?? "";

          const hasCorrelation = typeParamNames.some(
            (name) => paramTexts.includes(name) && returnText.includes(name),
          );
          if (hasCorrelation) {
            correlatedGenericFunctions++;
          }
        }
      }
    }
  }

  if (functionsWithGenerics > 0) {
    const correlatedRatio = correlatedGenericFunctions / functionsWithGenerics;
    if (correlatedRatio > 0.3) {
      score += 8;
      positives.push(
        `${Math.round(correlatedRatio * 100)}% of generic functions preserve input→output type relationships (+8)`,
      );
    }
  }

  // --- Narrow result type check ---
  let specificReturnTypes = 0;
  let totalReturnTypeFunctions = 0;
  const WIDE_RETURN_TYPES = new Set(["any", "void", "Promise<void>", "unknown"]);

  for (const decl of surface.declarations) {
    if (decl.kind === "function" && decl.hasExplicitReturnType) {
      totalReturnTypeFunctions++;
      const returnText = decl.returnTypeNode?.getText() ?? "";
      if (!WIDE_RETURN_TYPES.has(returnText)) {
        specificReturnTypes++;
      }
    }
    if ((decl.kind === "class" || decl.kind === "interface") && decl.methods) {
      for (const method of decl.methods) {
        if (method.hasExplicitReturnType) {
          totalReturnTypeFunctions++;
          const returnText = method.returnTypeNode?.getText() ?? "";
          if (!WIDE_RETURN_TYPES.has(returnText)) {
            specificReturnTypes++;
          }
        }
      }
    }
  }

  if (totalReturnTypeFunctions > 0) {
    const specificRatio = specificReturnTypes / totalReturnTypeFunctions;
    if (specificRatio > 0.7) {
      score += 5;
      positives.push(`${Math.round(specificRatio * 100)}% of functions return specific types (+5)`);
    }
  }

  // --- Predictable export structure check ---
  const kindCounts: Record<string, number> = {};
  for (const decl of surface.declarations) {
    kindCounts[decl.kind] = (kindCounts[decl.kind] ?? 0) + 1;
  }

  if (totalExports >= 3) {
    const dominantKindCount = Math.max(...Object.values(kindCounts));
    const dominantKindRatio = dominantKindCount / totalExports;
    if (dominantKindRatio > 0.6) {
      const dominantKind =
        Object.entries(kindCounts).find(([, count]) => count === dominantKindCount)?.[0] ??
        "unknown";
      score += 5;
      positives.push(`Predictable export structure (>60% ${dominantKind}s, +5)`);
    }
  }

  // --- Option bag discriminant check ---
  const DISCRIMINANT_PROPS = new Set(["type", "kind", "mode", "variant", "action"]);
  let optionBagPenalties = 0;

  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      for (const pos of decl.positions) {
        if (pos.role === "param") {
          const paramType = pos.type;
          if (paramType.isObject() && !paramType.isArray()) {
            const properties = paramType.getProperties();
            if (properties.length > 5) {
              const propNames = properties.map((p) => p.getName());
              const hasDiscriminant = propNames.some((n) => DISCRIMINANT_PROPS.has(n));
              if (!hasDiscriminant) {
                optionBagPenalties++;
              }
            }
          }
        }
      }
    }
  }

  if (optionBagPenalties > 0) {
    const penalty = Math.min(9, optionBagPenalties * 3);
    score -= penalty;
    negatives.push(
      `${optionBagPenalties} option bag(s) without discriminant property (-${penalty})`,
    );
  }

  // --- Stable alias quality ---
  let stableAliases = 0;
  let totalTypeAliases = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      totalTypeAliases++;
      if (decl.name.length > 4 && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (
          ![
            "string",
            "number",
            "boolean",
            "any",
            "unknown",
            "void",
            "never",
            "null",
            "undefined",
          ].includes(bodyText.trim())
        ) {
          stableAliases++;
        }
      }
    }
  }

  if (totalTypeAliases >= 3 && totalTypeAliases > 0) {
    const stableRatio = stableAliases / totalTypeAliases;
    if (stableRatio > 0.7) {
      score += 5;
      positives.push(
        `${Math.round(stableRatio * 100)}% of type aliases are descriptive and non-trivial (+5)`,
      );
    }
  }

  // --- Generic opacity penalty ---
  let opaqueGenericCount = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function" && decl.typeParameters.length > 3) {
      opaqueGenericCount++;
    }
  }
  if (opaqueGenericCount > 2) {
    const penalty = Math.min(8, opaqueGenericCount * 2);
    score -= penalty;
    negatives.push(
      `${opaqueGenericCount} function(s) with >3 generic type parameters (opaque for agents, -${penalty})`,
    );
  }

  // --- Wrong-path count: how many plausible wrong ways can an agent call the API ---
  let wrongPathCount = 0;

  // Functions with same name but different param counts (ambiguous overloads)
  const fnNameCounts = new Map<string, number>();
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      fnNameCounts.set(decl.name, (fnNameCounts.get(decl.name) ?? 0) + 1);
    }
  }
  for (const count of fnNameCounts.values()) {
    if (count > 1) {
      wrongPathCount += count - 1;
    }
  }

  // Optional params without clear documentation increase wrong paths
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      const optionalParams = decl.positions.filter(
        (p) => p.role === "param" && p.type.getText().includes("undefined"),
      );
      if (optionalParams.length > 3) {
        wrongPathCount++;
      }
    }
  }

  if (wrongPathCount > 5) {
    const penalty = Math.min(8, Math.round(wrongPathCount / 2));
    score -= penalty;
    negatives.push(`${wrongPathCount} plausible wrong paths for agents (-${penalty})`);
  } else if (wrongPathCount <= 1 && totalExports >= 5) {
    score += 3;
    positives.push("Low ambiguity: few wrong paths for agents (+3)");
  }

  // --- Inference stability: constrained generics vs unconstrained ---
  let constrainedGenerics = 0;
  let unconstrainedGenerics = 0;
  for (const decl of surface.declarations) {
    for (const tp of decl.typeParameters) {
      if (tp.constraint) {
        constrainedGenerics++;
      } else {
        unconstrainedGenerics++;
      }
    }
  }

  if (constrainedGenerics + unconstrainedGenerics > 3) {
    const constrainedRatio = constrainedGenerics / (constrainedGenerics + unconstrainedGenerics);
    if (constrainedRatio > 0.7) {
      score += 4;
      positives.push(
        `${Math.round(constrainedRatio * 100)}% of generics are constrained (stable inference, +4)`,
      );
    } else if (constrainedRatio < 0.3 && unconstrainedGenerics > 5) {
      score -= 3;
      negatives.push(`${unconstrainedGenerics} unconstrained generics (unstable inference, -3)`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      ambiguousOverloads,
      clearOverloads,
      constrainedGenerics,
      correlatedGenericFunctions,
      defaultExports,
      functionsWithExample,
      functionsWithGenerics,
      namedExports,
      opaqueGenericCount,
      optionBagPenalties,
      readableGenericNames,
      specificReturnTypes,
      stableAliases,
      totalFunctions,
      totalGenericParams,
      totalReturnTypeFunctions,
      totalTypeAliases,
      unconstrainedGenerics,
      wrongPathCount,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}
