import type { PublicSurface, SurfaceDeclaration } from "../surface/types.js";
import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Validation scenario pack.
 *
 * Tests how well a validation library transforms unknown input into
 * strongly-typed output, preserves types through pipelines, supports
 * discriminated unions, and provides ergonomic validation patterns.
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

function isValidationRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("parse") ||
    lower.includes("validate") ||
    lower.includes("safeparse") ||
    lower.includes("check") ||
    lower.includes("assert") ||
    lower.includes("guard") ||
    lower.includes("decode") ||
    lower.includes("create") ||
    lower.includes("schema") ||
    lower.includes("type") ||
    lower.includes("coerce")
  );
}

function isPipelineRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("pipe") ||
    lower.includes("transform") ||
    lower.includes("refine") ||
    lower.includes("chain") ||
    lower.includes("and") ||
    lower.includes("then") ||
    lower.includes("superrefine") ||
    lower.includes("preprocess") ||
    lower.includes("postprocess") ||
    lower.includes("coerce")
  );
}

/** Check for type predicate / type guard return (x is T) */
function hasTypeGuardReturn(decl: SurfaceDeclaration): boolean {
  if (!decl.returnTypeNode) {
    return false;
  }
  const text = decl.returnTypeNode.getText();
  return /\bis\s+\w/.test(text);
}

/** Check for assertion function (asserts x is T) */
function hasAssertionReturn(decl: SurfaceDeclaration): boolean {
  if (!decl.returnTypeNode) {
    return false;
  }
  const text = decl.returnTypeNode.getText();
  return /\basserts\s+\w/.test(text);
}

/** Check for branded output types (__brand, unique symbol, Branded) */
function hasBrandedOutput(decl: SurfaceDeclaration): boolean {
  for (const pos of decl.positions) {
    if (pos.role !== "return") {
      continue;
    }
    const typeText = pos.type.getText();
    if (
      typeText.includes("__brand") ||
      typeText.includes("unique symbol") ||
      typeText.includes("Branded") ||
      typeText.includes("Brand")
    ) {
      return true;
    }
  }
  // Check type alias body
  if (decl.kind === "type-alias" && decl.bodyTypeNode) {
    const bodyText = decl.bodyTypeNode.getText();
    if (
      bodyText.includes("__brand") ||
      bodyText.includes("unique symbol") ||
      bodyText.includes("Branded")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario 1: unknown input to validated output
// ---------------------------------------------------------------------------

/** Check method-level type guard and assertion return types */
function checkMethodReturnTypes(
  method: { returnTypeNode?: { getText(): string } },
  counts: { typeGuardFns: number; assertionFns: number },
): void {
  if (!method.returnTypeNode) {
    return;
  }
  const text = method.returnTypeNode.getText();
  if (/\bis\s+\w/.test(text)) {
    counts.typeGuardFns++;
  }
  if (/\basserts\s+\w/.test(text)) {
    counts.assertionFns++;
  }
}

const unknownToValidated: ScenarioTest = {
  description:
    "Validation functions should accept unknown input and return strongly-typed output, using type guards (x is T) or assertion functions (asserts x is T)",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let validationFns = 0;
    let unknownInputFns = 0;
    let typedOutputFns = 0;
    let typeGuardFns = 0;
    let assertionFns = 0;
    let anyInputFns = 0;
    let genericValidationFns = 0;

    for (const decl of surface.declarations) {
      if (decl.kind !== "function" && decl.kind !== "variable") {
        continue;
      }
      if (!isValidationRelated(decl.name)) {
        continue;
      }
      validationFns++;

      // Check for unknown input
      const hasUnknownInput = decl.positions.some(
        (pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0,
      );
      if (hasUnknownInput) {
        unknownInputFns++;
      }

      // Check for any input (negative signal)
      const hasAnyInput = decl.positions.some(
        (pos) => pos.role === "param" && pos.type.getText() === "any",
      );
      if (hasAnyInput) {
        anyInputFns++;
      }

      // Check for typed output
      const hasTypedOutput = decl.positions.some((pos) => {
        if (pos.role !== "return") {
          return false;
        }
        const typeText = pos.type.getText();
        return (
          typeText !== "any" &&
          typeText !== "unknown" &&
          typeText !== "void" &&
          typeText !== "never"
        );
      });
      if (hasTypedOutput) {
        typedOutputFns++;
      }

      // Check for type guard returns (x is T)
      if (hasTypeGuardReturn(decl)) {
        typeGuardFns++;
      }

      // Check for assertion function (asserts x is T)
      if (hasAssertionReturn(decl)) {
        assertionFns++;
      }

      // Check for generics
      if (decl.typeParameters.length > 0) {
        genericValidationFns++;
      }
    }

    // Also check methods on validation interfaces/classes
    const counts = { assertionFns, typeGuardFns };
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const mName = method.name.toLowerCase();
        if (
          mName.includes("parse") ||
          mName.includes("validate") ||
          mName.includes("guard") ||
          mName.includes("assert") ||
          mName.includes("decode") ||
          mName.includes("safeparse")
        ) {
          validationFns++;
          if (method.typeParameters.length > 0) {
            genericValidationFns++;
          }
          // Check return type for type guard
          checkMethodReturnTypes(method, counts);
        }
      }
    }
    ({ assertionFns, typeGuardFns } = counts);

    if (validationFns === 0) {
      return makeResult({
        name: "unknownToValidated",
        passed: false,
        reason: "No validation functions found",
        score: 20,
      });
    }

    // 40% compile-success: validation functions exist with unknown input + typed output
    let compileScore = 0;
    if (unknownInputFns > 0 && typedOutputFns > 0) {
      compileScore = 40;
    } else if (typedOutputFns > 0) {
      compileScore = 25;
    } else if (validationFns >= 3) {
      compileScore = 15;
    }

    // 25% compile-failure: type guards and assertion functions reject wrong usage at compile time
    let failureScore = 0;
    if (typeGuardFns > 0) {
      failureScore += 12;
    }
    if (assertionFns > 0) {
      failureScore += 13;
    } else if (genericValidationFns > 0) {
      failureScore += 8;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: generic validation fns + type guards
    let exactnessScore = 0;
    if (genericValidationFns > 0) {
      exactnessScore += 12;
    }
    if (typeGuardFns > 0 || assertionFns > 0) {
      exactnessScore += 8;
    }
    if (unknownInputFns > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: any-input functions are wrong paths
    let wrongPathScore = 0;
    if (anyInputFns === 0 && validationFns > 0) {
      wrongPathScore = 10;
    } else if (anyInputFns < validationFns / 3) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    const parts: string[] = [`${unknownInputFns} accept unknown`, `${typedOutputFns} return typed`];
    if (typeGuardFns > 0) {
      parts.push(`${typeGuardFns} type guards`);
    }
    if (assertionFns > 0) {
      parts.push(`${assertionFns} assertion fns`);
    }

    return makeResult({
      name: "unknownToValidated",
      passed,
      reason: passed ? parts.join(", ") : "Validation pipeline lacks unknown-to-typed flow",
      score,
    });
  },
  name: "unknownToValidated",
};

// ---------------------------------------------------------------------------
// Scenario 2: Refinement/transform pipelines
// ---------------------------------------------------------------------------

const refinementPipeline: ScenarioTest = {
  description:
    "Schema composition should preserve type information through pipe/chain patterns that accumulate type information",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let pipelineFns = 0;
    let genericPipelines = 0;
    // Multiple generic params = accumulating type info
    let chainedGenerics = 0;
    let constrainedPipelines = 0;
    let overloadedPipelines = 0;

    for (const decl of surface.declarations) {
      if (!isPipelineRelated(decl.name)) {
        continue;
      }
      pipelineFns++;

      if (decl.typeParameters.length > 0) {
        genericPipelines++;
        // Multiple type params = pipe is accumulating/transforming type info
        if (decl.typeParameters.length >= 2) {
          chainedGenerics++;
        }
        // Constrained type params = pipe preserves shape
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedPipelines++;
        }
      }

      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedPipelines++;
      }
    }

    // Also check methods on schema/validation interfaces
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (!isPipelineRelated(method.name)) {
          continue;
        }
        pipelineFns++;
        if (method.typeParameters.length > 0) {
          genericPipelines++;
          if (method.typeParameters.length >= 2) {
            chainedGenerics++;
          }
          if (method.typeParameters.some((tp) => tp.hasConstraint)) {
            constrainedPipelines++;
          }
        }
        if (method.overloadCount > 1) {
          overloadedPipelines++;
        }
      }
    }

    if (pipelineFns === 0) {
      return makeResult({
        name: "refinementPipeline",
        passed: false,
        reason: "No pipeline/transform functions found",
        score: 25,
      });
    }

    // 40% compile-success: pipeline declarations with generics
    let compileScore = 0;
    if (genericPipelines > 0) {
      compileScore = 40;
    } else if (pipelineFns >= 2) {
      compileScore = 20;
    }

    // 25% compile-failure: constrained pipelines reject wrong shape
    let failureScore = 0;
    if (constrainedPipelines > 0) {
      failureScore += 15;
    }
    if (chainedGenerics > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: chained generics + overloads
    let exactnessScore = 0;
    if (chainedGenerics > 0) {
      exactnessScore += 12;
    }
    if (overloadedPipelines > 0) {
      exactnessScore += 8;
    }
    if (genericPipelines >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: few non-generic pipelines
    let wrongPathScore = 0;
    const nonGenericPipelines = pipelineFns - genericPipelines;
    if (nonGenericPipelines === 0 && pipelineFns > 0) {
      wrongPathScore = 10;
    } else if (nonGenericPipelines < pipelineFns / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "refinementPipeline",
      passed,
      reason: passed
        ? `${genericPipelines}/${pipelineFns} generic pipelines, ${chainedGenerics} chained, ${constrainedPipelines} constrained`
        : "Pipeline functions lack generic type preservation",
      score,
    });
  },
  name: "refinementPipeline",
};

// ---------------------------------------------------------------------------
// Scenario 3: Discriminated schema composition
// ---------------------------------------------------------------------------

/** Check if a method matches exhaustive match patterns and update counts */
function checkExhaustiveMethod(
  method: { name: string; typeParameters: { length: number }[] },
  counts: { exhaustiveMatchPatterns: number; genericUnionConstructors: number },
): void {
  const mName = method.name.toLowerCase();
  if (mName === "match" || mName === "fold" || mName === "cata" || mName === "exhaustive") {
    counts.exhaustiveMatchPatterns++;
    if (method.typeParameters.length > 0) {
      counts.genericUnionConstructors++;
    }
  }
}

const discriminatedComposition: ScenarioTest = {
  description:
    "Union schemas should produce discriminated unions for exhaustive matching, with discriminated union helpers",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let unionDecls = 0;
    let discriminatedUnions = 0;
    let exhaustiveMatchPatterns = 0;
    let genericUnionConstructors = 0;
    let discriminantFields = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();

      // Union/variant constructors
      if (
        lowerName.includes("union") ||
        lowerName.includes("discriminat") ||
        lowerName.includes("variant") ||
        lowerName.includes("oneof")
      ) {
        unionDecls++;
        if (decl.typeParameters.length > 0) {
          genericUnionConstructors++;
        }
      }

      // Exhaustive match patterns
      if (
        lowerName.includes("match") ||
        lowerName.includes("fold") ||
        lowerName.includes("exhaustive") ||
        lowerName.includes("cata")
      ) {
        exhaustiveMatchPatterns++;
      }

      // Check for discriminated union types in type aliases
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (bodyText.includes("|")) {
          // Check for discriminant field patterns
          if (/["']?(type|kind|tag|_tag|status|variant|discriminant)["']?\s*:/.test(bodyText)) {
            discriminatedUnions++;
          }
          // Count discriminant fields
          const discriminantMatches = bodyText.match(
            /["']?(type|kind|tag|_tag|status|variant)["']?\s*:/g,
          );
          if (discriminantMatches) {
            discriminantFields += discriminantMatches.length;
          }
        }
      }

      // Check methods for exhaustive match support
      if (decl.methods) {
        const methodCounts = { exhaustiveMatchPatterns, genericUnionConstructors };
        for (const method of decl.methods) {
          checkExhaustiveMethod(method, methodCounts);
        }
        ({ exhaustiveMatchPatterns, genericUnionConstructors } = methodCounts);
      }
    }

    // 40% compile-success: union/variant declarations exist
    let compileScore = 0;
    if (unionDecls > 0 || discriminatedUnions > 0) {
      compileScore = 40;
    } else if (exhaustiveMatchPatterns > 0) {
      compileScore = 20;
    }

    // 25% compile-failure: discriminant fields reject wrong variants
    let failureScore = 0;
    if (discriminatedUnions > 0) {
      failureScore += 15;
    }
    if (discriminantFields >= 2) {
      failureScore += 10;
    } else if (genericUnionConstructors > 0) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: exhaustive match + generic constructors
    let exactnessScore = 0;
    if (exhaustiveMatchPatterns > 0) {
      exactnessScore += 12;
    }
    if (genericUnionConstructors > 0) {
      exactnessScore += 8;
    }
    if (discriminatedUnions >= 2) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (discriminatedUnions > 0 && exhaustiveMatchPatterns > 0) {
      wrongPathScore = 10;
    } else if (discriminatedUnions > 0 || exhaustiveMatchPatterns > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "discriminatedComposition",
      passed,
      reason: passed
        ? `${discriminatedUnions} discriminated unions, ${unionDecls} union constructors, ${exhaustiveMatchPatterns} match patterns`
        : "Limited discriminated union support",
      score,
    });
  },
  name: "discriminatedComposition",
};

// ---------------------------------------------------------------------------
// Scenario 4: Parse/assert/guard ergonomics
// ---------------------------------------------------------------------------

const parseGuardErgonomics: ScenarioTest = {
  description:
    "Library should provide multiple ergonomic validation paths (parse, assert, guard) with branded output types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    const patterns = new Set<string>();
    let brandedOutputDecls = 0;
    let genericPatterns = 0;
    let _totalValidationDecls = 0;

    for (const decl of surface.declarations) {
      const lowerName = decl.name.toLowerCase();

      // Detect validation patterns
      if (lowerName.includes("parse") && !lowerName.includes("safeparse")) {
        patterns.add("parse");
        _totalValidationDecls++;
      }
      if (
        lowerName.includes("safeparse") ||
        lowerName.includes("safe_parse") ||
        lowerName.includes("trypars")
      ) {
        patterns.add("safeParse");
        _totalValidationDecls++;
      }
      if (lowerName.includes("assert") && !lowerName.includes("assertequal")) {
        patterns.add("assert");
        _totalValidationDecls++;
      }
      if (
        lowerName.includes("guard") ||
        (lowerName.includes("is") && decl.kind === "function" && hasTypeGuardReturn(decl))
      ) {
        patterns.add("guard");
        _totalValidationDecls++;
      }
      if (lowerName.includes("validate")) {
        patterns.add("validate");
        _totalValidationDecls++;
      }
      if (lowerName.includes("decode")) {
        patterns.add("decode");
        _totalValidationDecls++;
      }
      if (lowerName.includes("coerce")) {
        patterns.add("coerce");
        _totalValidationDecls++;
      }
      if (lowerName.includes("cast")) {
        patterns.add("cast");
        _totalValidationDecls++;
      }

      // Check for branded output types
      if (hasBrandedOutput(decl)) {
        brandedOutputDecls++;
      }

      // Check for generic validation patterns
      if (isValidationRelated(lowerName) && decl.typeParameters.length > 0) {
        genericPatterns++;
      }
    }

    // Also check methods
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const mName = method.name.toLowerCase();
        if (mName === "parse") {
          patterns.add("parse");
        }
        if (mName === "safeparse" || mName === "safe_parse" || mName === "tryparse") {
          patterns.add("safeParse");
        }
        if (mName === "assert") {
          patterns.add("assert");
        }
        if (mName === "guard" || mName === "is") {
          patterns.add("guard");
        }
        if (mName === "validate") {
          patterns.add("validate");
        }
        if (mName === "decode") {
          patterns.add("decode");
        }
        if (mName === "coerce") {
          patterns.add("coerce");
        }
        if (mName === "cast") {
          patterns.add("cast");
        }
      }
    }

    // 40% compile-success: multiple validation patterns exist
    let compileScore = 0;
    if (patterns.size >= 3) {
      compileScore = 40;
    } else if (patterns.size >= 2) {
      compileScore = 30;
    } else if (patterns.size > 0) {
      compileScore = 15;
    }

    // 25% compile-failure: branded outputs prevent misuse
    let failureScore = 0;
    if (brandedOutputDecls > 0) {
      failureScore += 15;
    }
    if (patterns.has("assert") || patterns.has("guard")) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: generic patterns
    let exactnessScore = 0;
    if (genericPatterns > 0) {
      exactnessScore += 12;
    }
    if (patterns.size >= 4) {
      exactnessScore += 8;
    }
    if (brandedOutputDecls > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: many patterns = fewer wrong paths
    let wrongPathScore = 0;
    if (patterns.size >= 3) {
      wrongPathScore = 10;
    } else if (patterns.size >= 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "parseGuardErgonomics",
      passed,
      reason: passed
        ? `${patterns.size} validation patterns (${[...patterns].join(", ")}), ${brandedOutputDecls} branded outputs`
        : `Only ${patterns.size} validation pattern(s) found`,
      score,
    });
  },
  name: "parseGuardErgonomics",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const VALIDATION_PACK: ScenarioPack = {
  description:
    "Tests validation libraries for unknown-to-typed flow, pipelines, discriminated unions, and ergonomics",
  domain: "validation",
  isApplicable: (surface) => {
    const hasParseOrValidate = surface.declarations.some(
      (decl) =>
        decl.kind === "function" && /^(parse|validate|safeParse|check|coerce)$/i.test(decl.name),
    );
    const hasUnknownParams = surface.declarations.some(
      (decl) =>
        decl.kind === "function" &&
        decl.positions.some((pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0),
    );
    return {
      applicable: hasParseOrValidate || hasUnknownParams,
      reason:
        hasParseOrValidate || hasUnknownParams
          ? "Validation patterns detected"
          : "No parse/validate functions or unknown-accepting params found",
    };
  },
  name: "validation",
  scenarios: [
    unknownToValidated,
    refinementPipeline,
    discriminatedComposition,
    parseGuardErgonomics,
  ],
};
