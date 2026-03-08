import { DIMENSION_CONFIGS } from "../constants.js";
import type { DimensionResult } from "../types.js";
import type { PublicSurface } from "../surface/index.js";
import type { SurfaceDeclaration } from "../surface/types.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "agentUsability")!;

/** Prefixes that signal well-named happy-path helper functions */
const HAPPY_PATH_PREFIXES = ["create", "make", "define", "build", "setup", "init", "configure"];

/** Levenshtein edit distance (bounded to max for performance) */
function editDistance(lhs: string, rhs: string, max = 3): number {
  const la = lhs.length;
  const lb = rhs.length;
  if (Math.abs(la - lb) > max) {
    return max + 1;
  }

  const prev = Array.from({ length: lb + 1 }, (_unused, idx) => idx);
  for (let ri = 1; ri <= la; ri++) {
    let prevDiag = prev[0]!;
    prev[0] = ri;
    for (let ci = 1; ci <= lb; ci++) {
      const temp = prev[ci]!;
      prev[ci] =
        lhs[ri - 1] === rhs[ci - 1] ? prevDiag : 1 + Math.min(prevDiag, prev[ci - 1]!, prev[ci]!);
      prevDiag = temp;
    }
  }
  return prev[lb]!;
}

/** Extract a simplified param-type signature for a function declaration */
function paramSignature(decl: SurfaceDeclaration): string {
  return (decl.paramTypeNodes ?? [])
    .map((pt) => {
      const text = pt.typeNode?.getText() ?? "any";
      // Normalize generics away so we compare structural shape
      return text.replaceAll(/<[^>]+>/g, "<_>");
    })
    .join(",");
}

/** Build a generic-shape string like "2:C,C" (param count + constraint pattern) */
function genericShape(typeParams: { name: string; hasConstraint: boolean }[]): string {
  if (typeParams.length === 0) {
    return "";
  }
  const constraints = typeParams.map((tp) => (tp.hasConstraint ? "C" : "U")).join(",");
  return `${typeParams.length}:${constraints}`;
}

/** Count how many unique uppercase identifiers appear in a type text (rough alias ref count) */
function countAliasReferences(bodyText: string): number {
  const matches = bodyText.match(/\b[A-Z][a-zA-Z0-9]+\b/g);
  if (!matches) {
    return 0;
  }
  // Exclude well-known built-in type names
  const BUILTINS = new Set([
    "Array",
    "Promise",
    "Record",
    "Partial",
    "Required",
    "Readonly",
    "Pick",
    "Omit",
    "Extract",
    "Exclude",
    "ReturnType",
    "Parameters",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Awaited",
    "NonNullable",
    "ConstructorParameters",
    "InstanceType",
    "ThisParameterType",
    "OmitThisParameter",
    "String",
    "Number",
    "Boolean",
    "Object",
    "Function",
    "Symbol",
    "BigInt",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
  ]);
  const unique = new Set(matches.filter((match) => !BUILTINS.has(match)));
  return unique.size;
}

/**
 * Consumer-guidance analyzer (downstream guidance model): measures how well
 * the API guides AI agents and human consumers toward correct usage.
 *
 * Signals:
 * - Inference stability (constrained generics, predictable return types)
 * - Ambiguity of overload resolution (overlapping parameter types)
 * - Parameter-to-result predictability
 * - Discoverability of the correct export/symbol
 * - Wrong-path count (similar names, shared signatures, method shadows)
 * - Equally plausible confusable APIs (similar generic shapes)
 * - Discriminant-rich error/result workflows
 * - Readability of type aliases after instantiation
 * - Happy-path helper presence (create*, make*, define*, build*)
 * - Number of plausible wrong paths
 */
export function analyzeAgentUsability(surface: PublicSurface): DimensionResult {
  const positives: string[] = [];
  const negatives: string[] = [];

  // Start at midpoint
  let score = 50;

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
    if (decl.kind !== "function") {
      continue;
    }
    totalFunctions++;
    if (decl.hasJSDoc && hasFunctionExample(decl)) {
      functionsWithExample++;
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
  // Improved: instead of just counting >6 overloads, detect truly ambiguous
  // Overloads whose parameter types overlap (agents cannot distinguish them).
  let clearOverloads = 0;
  let ambiguousOverloads = 0;
  let overlappingOverloads = 0;
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
      // Check for overlapping parameter types across overloads:
      // If multiple overloads share the same param count, look at first-param type text
      // To see if they could be confused.
      if (overloads > 1 && decl.paramTypeNodes) {
        const firstParamText = decl.paramTypeNodes[0]?.typeNode?.getText() ?? "";
        // Wide first-param types like string | number make overloads ambiguous
        if (
          firstParamText.includes("|") ||
          firstParamText === "any" ||
          firstParamText === "unknown"
        ) {
          overlappingOverloads++;
        }
      }
    }
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (method.overloadCount <= 1) {
        continue;
      }
      _totalOverloadedFunctions++;
      if (method.overloadCount <= 4) {
        clearOverloads++;
      } else if (method.overloadCount > 6) {
        ambiguousOverloads++;
      }
      // Check overlapping param types on methods too
      if (method.paramTypeNodes.length > 0) {
        const firstParamText = method.paramTypeNodes[0]?.typeNode?.getText() ?? "";
        if (
          firstParamText.includes("|") ||
          firstParamText === "any" ||
          firstParamText === "unknown"
        ) {
          overlappingOverloads++;
        }
      }
    }
  }

  if (clearOverloads > 0 && ambiguousOverloads === 0 && overlappingOverloads === 0) {
    score += 5;
    positives.push(`${clearOverloads} function(s) with clear overload patterns (+5)`);
  } else if (ambiguousOverloads > 0) {
    const penalty = Math.min(10, ambiguousOverloads * 3);
    score -= penalty;
    negatives.push(`${ambiguousOverloads} function(s) with excessive overloads (>6, -${penalty})`);
  }
  if (overlappingOverloads > 0) {
    const penalty = Math.min(6, overlappingOverloads * 2);
    score -= penalty;
    negatives.push(
      `${overlappingOverloads} overloaded function(s) with overlapping parameter types (-${penalty})`,
    );
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
        .map((pt) => pt.typeNode?.getText() ?? "")
        .join(" ");
      const returnText = decl.returnTypeNode?.getText() ?? "";

      const hasCorrelation = typeParamNames.some(
        (name) => paramTexts.includes(name) && returnText.includes(name),
      );
      if (hasCorrelation) {
        correlatedGenericFunctions++;
      }
    }
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (method.typeParameters.length === 0) {
        continue;
      }
      functionsWithGenerics++;
      const typeParamNames = method.typeParameters.map((tp) => tp.name);
      const paramTexts = method.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "").join(" ");
      const returnText = method.returnTypeNode?.getText() ?? "";

      const hasCorrelation = typeParamNames.some(
        (name) => paramTexts.includes(name) && returnText.includes(name),
      );
      if (hasCorrelation) {
        correlatedGenericFunctions++;
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
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (!method.hasExplicitReturnType) {
        continue;
      }
      totalReturnTypeFunctions++;
      const returnText = method.returnTypeNode?.getText() ?? "";
      if (!WIDE_RETURN_TYPES.has(returnText)) {
        specificReturnTypes++;
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
    if (decl.kind !== "function") {
      continue;
    }
    optionBagPenalties += countOptionBagPenalties(decl, DISCRIMINANT_PROPS);
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

  if (totalTypeAliases >= 3) {
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

  // (a) Functions with same name but different param counts (ambiguous overloads)
  const fnNameCounts = new Map<string, number>();
  const fnNames: string[] = [];
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      fnNameCounts.set(decl.name, (fnNameCounts.get(decl.name) ?? 0) + 1);
      fnNames.push(decl.name);
    }
  }
  for (const count of fnNameCounts.values()) {
    if (count > 1) {
      wrongPathCount += count - 1;
    }
  }

  // (b) Optional params without clear documentation increase wrong paths
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      const optionalParams = decl.positions.filter(
        (pos) => pos.role === "param" && pos.type.getText().includes("undefined"),
      );
      if (optionalParams.length > 3) {
        wrongPathCount++;
      }
    }
  }

  // (c) Functions with similar names (edit distance <= 2) — easily confused
  let similarNamePairs = 0;
  const uniqueFnNames = [...new Set(fnNames)];
  for (let idx = 0; idx < uniqueFnNames.length; idx++) {
    for (let jdx = idx + 1; jdx < uniqueFnNames.length; jdx++) {
      if (editDistance(uniqueFnNames[idx]!, uniqueFnNames[jdx]!, 2) <= 2) {
        similarNamePairs++;
      }
    }
  }
  wrongPathCount += similarNamePairs;

  // (d) Methods on classes/interfaces that shadow top-level export names
  let methodShadowCount = 0;
  const topLevelNames = new Set(
    surface.declarations
      .filter((decl) => decl.kind === "function" || decl.kind === "variable")
      .map((decl) => decl.name),
  );
  for (const decl of surface.declarations) {
    if (!(decl.kind === "class" || decl.kind === "interface") || !decl.methods) {
      continue;
    }
    for (const method of decl.methods) {
      if (topLevelNames.has(method.name)) {
        methodShadowCount++;
      }
    }
  }
  wrongPathCount += methodShadowCount;

  // (e) Functions with identical param-type signatures but different names
  // (agent could pick the wrong one)
  let sameSignaturePairs = 0;
  const fnSignatures = new Map<string, string[]>();
  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    const sig = paramSignature(decl);
    // Skip zero-param functions
    if (sig.length === 0) {
      continue;
    }
    const existing = fnSignatures.get(sig);
    if (existing) {
      existing.push(decl.name);
    } else {
      fnSignatures.set(sig, [decl.name]);
    }
  }
  for (const names of fnSignatures.values()) {
    if (names.length > 1) {
      // Each extra function with the same sig is one wrong path
      sameSignaturePairs += names.length - 1;
    }
  }
  wrongPathCount += sameSignaturePairs;

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
  let constrainedReturnGenerics = 0;
  let totalReturnGenerics = 0;
  for (const decl of surface.declarations) {
    for (const tp of decl.typeParameters) {
      if (tp.hasConstraint) {
        constrainedGenerics++;
      } else {
        unconstrainedGenerics++;
      }
    }
    // Check if generic return types use constrained generics (predictable inference)
    if (decl.kind === "function" && decl.typeParameters.length > 0 && decl.returnTypeNode) {
      const returnText = decl.returnTypeNode.getText();
      for (const tp of decl.typeParameters) {
        if (!returnText.includes(tp.name)) {
          continue;
        }
        totalReturnGenerics++;
        if (tp.hasConstraint) {
          constrainedReturnGenerics++;
        }
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

  // Bonus for constrained return generics (predictable inference after consumer usage)
  if (totalReturnGenerics >= 3) {
    const constrainedReturnRatio = constrainedReturnGenerics / totalReturnGenerics;
    if (constrainedReturnRatio > 0.6) {
      score += 3;
      positives.push(
        `${Math.round(constrainedReturnRatio * 100)}% of return-position generics are constrained (predictable inference, +3)`,
      );
    }
  }

  // --- Equally plausible but incorrect APIs: similar generic signatures ---
  let confusableApiCount = 0;
  const genericShapes = new Map<string, string[]>();
  for (const decl of surface.declarations) {
    if (decl.kind !== "function" || decl.typeParameters.length === 0) {
      continue;
    }
    const shape = genericShape(decl.typeParameters);
    if (!shape) {
      continue;
    }
    const existing = genericShapes.get(shape);
    if (existing) {
      existing.push(decl.name);
    } else {
      genericShapes.set(shape, [decl.name]);
    }
  }
  for (const names of genericShapes.values()) {
    if (names.length > 1) {
      confusableApiCount += names.length - 1;
    }
  }

  if (confusableApiCount > 3) {
    const penalty = Math.min(6, confusableApiCount);
    score -= penalty;
    negatives.push(
      `${confusableApiCount} export(s) with confusable generic signatures (-${penalty})`,
    );
  }

  // --- Readability of aliases after instantiation ---
  // Type aliases whose bodies reference >3 other type aliases produce
  // Hard-to-read instantiated results for agents.
  let deepAliasCount = 0;
  for (const decl of surface.declarations) {
    if (decl.kind !== "type-alias" || !decl.bodyTypeNode) {
      continue;
    }
    const bodyText = decl.bodyTypeNode.getText();
    const aliasRefs = countAliasReferences(bodyText);
    if (aliasRefs > 3) {
      deepAliasCount++;
    }
  }

  if (deepAliasCount > 0) {
    const penalty = Math.min(5, deepAliasCount);
    score -= penalty;
    negatives.push(
      `${deepAliasCount} type alias(es) reference >3 other aliases (hard to read after instantiation, -${penalty})`,
    );
  }

  // --- Discoverability of the correct entrypoint ---
  // Bonus: clear primary entrypoint with well-known main exports.
  // Penalty: exports scattered across many small namespaces.
  const fileSet = new Set<string>();
  let hasIndexExport = false;
  for (const decl of surface.declarations) {
    fileSet.add(decl.filePath);
    const fileLower = decl.filePath.toLowerCase();
    if (fileLower.includes("index.") || fileLower.includes("main.") || fileLower.includes("mod.")) {
      hasIndexExport = true;
    }
  }

  if (hasIndexExport && totalExports >= 3) {
    score += 3;
    positives.push("Exports discoverable through main/index entrypoint (+3)");
  }

  const fileCount = fileSet.size;
  if (fileCount > 8 && totalExports > 0) {
    const exportsPerFile = totalExports / fileCount;
    if (exportsPerFile < 2) {
      const penalty = Math.min(4, Math.round(fileCount / 4));
      score -= penalty;
      negatives.push(
        `Exports scattered across ${fileCount} files (avg ${exportsPerFile.toFixed(1)}/file, -${penalty})`,
      );
    }
  }

  // --- Quality of error/result discrimination ---
  // Look for Result/Either/Effect types with discriminant fields
  // And bonus for exhaustive matching patterns (narrow union branches).
  let resultTypeCount = 0;
  let discriminatedResultCount = 0;
  const RESULT_NAMES = /result|either|effect|outcome|response|output/i;
  const DISCRIMINANT_FIELDS = new Set([
    "kind",
    "type",
    "tag",
    "_tag",
    "status",
    "success",
    "ok",
    "error",
  ]);

  for (const decl of surface.declarations) {
    if (decl.kind !== "type-alias") {
      continue;
    }
    if (!RESULT_NAMES.test(decl.name)) {
      continue;
    }
    resultTypeCount++;
    const bodyText = decl.bodyTypeNode?.getText() ?? "";
    if (bodyText.includes("|")) {
      const hasDiscriminant = [...DISCRIMINANT_FIELDS].some((field) => bodyText.includes(field));
      if (hasDiscriminant) {
        discriminatedResultCount++;
      }
    }
  }

  if (discriminatedResultCount > 0) {
    const bonus = Math.min(5, discriminatedResultCount * 2);
    score += bonus;
    positives.push(
      `${discriminatedResultCount} result/either type(s) with discriminant fields (exhaustive matching, +${bonus})`,
    );
  } else if (resultTypeCount > 0 && discriminatedResultCount === 0) {
    score -= 2;
    negatives.push(`${resultTypeCount} result-like type(s) without discriminant fields (-2)`);
  }

  // --- Happy-path helpers (create*, make*, define*, build*) ---
  let happyPathHelperCount = 0;
  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }
    const nameLower = decl.name.toLowerCase();
    if (HAPPY_PATH_PREFIXES.some((prefix) => nameLower.startsWith(prefix))) {
      happyPathHelperCount++;
    }
  }

  if (happyPathHelperCount > 0 && totalFunctions > 0) {
    const helperRatio = happyPathHelperCount / totalFunctions;
    if (helperRatio >= 0.15 || happyPathHelperCount >= 3) {
      score += 4;
      positives.push(
        `${happyPathHelperCount} happy-path helper(s) (create*/make*/define*/build*, +4)`,
      );
    } else if (happyPathHelperCount >= 1) {
      score += 2;
      positives.push(
        `${happyPathHelperCount} happy-path helper(s) (create*/make*/define*/build*, +2)`,
      );
    }
  }

  score = Math.max(0, Math.min(100, score));

  // Applicability: need sufficient callable surface for usability assessment
  const callableCount = surface.declarations.filter(
    (decl) => decl.kind === "function" || decl.kind === "class" || (decl.methods ?? []).length > 0,
  ).length;
  const applicability =
    callableCount < 3 ? ("insufficient_evidence" as const) : ("applicable" as const);
  const applicabilityReasons =
    callableCount < 3
      ? [`Only ${callableCount} callable declaration(s) — limited usability evidence`]
      : [];

  return {
    applicability,
    applicabilityReasons,
    enabled: true,
    issues: [],
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      ambiguousOverloads,
      clearOverloads,
      confusableApiCount,
      constrainedGenerics,
      constrainedReturnGenerics,
      correlatedGenericFunctions,
      deepAliasCount,
      defaultExports,
      discriminatedResultCount,
      functionsWithExample,
      functionsWithGenerics,
      happyPathHelperCount,
      methodShadowCount,
      namedExports,
      opaqueGenericCount,
      optionBagPenalties,
      overlappingOverloads,
      readableGenericNames,
      sameSignaturePairs,
      similarNamePairs,
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

/**
 * Check whether a function declaration's JSDoc contains an @example tag.
 */
function hasFunctionExample(decl: SurfaceDeclaration): boolean {
  const fn = decl.node as { getJsDocs?: () => { getTags(): { getTagName(): string }[] }[] };
  if (!fn.getJsDocs) {
    return false;
  }
  for (const doc of fn.getJsDocs()) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() === "example") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Count how many param-position option bags lack a discriminant property
 * (type, kind, mode, variant, action).
 */
function countOptionBagPenalties(decl: SurfaceDeclaration, discriminants: Set<string>): number {
  let penalties = 0;
  for (const pos of decl.positions) {
    if (pos.role !== "param") {
      continue;
    }
    const typeText = pos.type.getText();
    // Only penalize object-like param types with 4+ properties
    if (!typeText.includes("{") || typeText.length < 30) {
      continue;
    }
    const hasDiscriminant = [...discriminants].some((prop) => typeText.includes(prop));
    if (!hasDiscriminant) {
      penalties++;
    }
  }
  return penalties;
}
