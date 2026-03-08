import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * Schema/utility scenario pack.
 *
 * Tests how well a schema/utility library preserves keys through
 * transforms, supports deep recursive transforms, and maintains
 * readable type aliases.
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

/** Check for Pick, Omit, Partial, Required patterns with generics */
function hasPickOmitPatterns(bodyText: string): boolean {
  return (
    bodyText.includes("Pick<") ||
    bodyText.includes("Omit<") ||
    bodyText.includes("Partial<") ||
    bodyText.includes("Required<") ||
    bodyText.includes("Readonly<") ||
    bodyText.includes("Record<")
  );
}

/** Check for mapped type patterns [K in keyof T] */
function hasMappedType(bodyText: string): boolean {
  return /\[\s*\w+\s+in\s+(keyof\s+)?\w+/.test(bodyText);
}

/** Check for conditional type patterns */
function hasConditionalType(bodyText: string): boolean {
  return /\bextends\s+/.test(bodyText) && bodyText.includes("?");
}

/** Check if a name is a short/cryptic single-letter name */
function isShortCrypticName(name: string): boolean {
  return name.length <= 2 || /^[A-Z]$/.test(name) || /^[A-Z][0-9]$/.test(name);
}

/** Check if a name is descriptive (PascalCase, > 4 chars, starts with uppercase) */
function isDescriptiveName(name: string): boolean {
  return name.length > 4 && /^[A-Z]/.test(name) && /[a-z]/.test(name);
}

/** Check keyof constraints in type parameters */
function countKeyofConstraints(
  typeParameters: readonly { constraintNode?: { getText(): string } | undefined }[],
): number {
  let count = 0;
  for (const tp of typeParameters) {
    const constraintText = tp.constraintNode?.getText() ?? "";
    if (constraintText.includes("keyof")) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Scenario 1: Key-preserving transforms
// ---------------------------------------------------------------------------

const keyPreservingTransforms: ScenarioTest = {
  description:
    "Type utilities should preserve object keys through transformations using Pick, Omit, Partial, Required patterns with generics",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let mappedTypes = 0;
    let keyofUsage = 0;
    let pickOmitPatterns = 0;
    let genericTransformFns = 0;
    let constrainedKeyParams = 0;
    let _totalTransformDecls = 0;

    for (const decl of surface.declarations) {
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();

        // Keyof usage
        if (bodyText.includes("keyof")) {
          keyofUsage++;
        }

        // Mapped types: [K in keyof T]
        if (hasMappedType(bodyText)) {
          mappedTypes++;
        }

        // Pick/Omit/Partial/Required patterns
        if (hasPickOmitPatterns(bodyText)) {
          pickOmitPatterns++;
          _totalTransformDecls++;
        }

        // Check for generic type alias with key-preserving transforms
        if (
          decl.typeParameters.length > 0 &&
          (bodyText.includes("keyof") || hasMappedType(bodyText))
        ) {
          genericTransformFns++;
        }
      }

      // Check functions that take objects and return transformed objects
      if (decl.kind === "function" && decl.typeParameters.length > 0) {
        const lowerName = decl.name.toLowerCase();
        if (
          lowerName.includes("pick") ||
          lowerName.includes("omit") ||
          lowerName.includes("partial") ||
          lowerName.includes("required") ||
          lowerName.includes("readonly") ||
          lowerName.includes("merge") ||
          lowerName.includes("extend") ||
          lowerName.includes("transform")
        ) {
          genericTransformFns++;
          _totalTransformDecls++;
          // Check for keyof constraints on type params
          constrainedKeyParams += countKeyofConstraints(decl.typeParameters);
        }
      }

      // Check methods
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        const mName = method.name.toLowerCase();
        if (
          mName.includes("pick") ||
          mName.includes("omit") ||
          mName.includes("partial") ||
          mName.includes("required") ||
          mName.includes("extend") ||
          mName.includes("merge")
        ) {
          _totalTransformDecls++;
          if (method.typeParameters.length > 0) {
            genericTransformFns++;
          }
          constrainedKeyParams += countKeyofConstraints(method.typeParameters);
        }
      }
    }

    // 40% compile-success: key-preserving transform declarations exist
    let compileScore = 0;
    if (keyofUsage > 0 || pickOmitPatterns > 0 || mappedTypes > 0) {
      compileScore = 40;
    } else if (genericTransformFns > 0) {
      compileScore = 25;
    }

    // 25% compile-failure: keyof constraints prevent invalid key access
    let failureScore = 0;
    if (constrainedKeyParams > 0) {
      failureScore += 15;
    }
    if (mappedTypes > 0 && keyofUsage > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: many patterns + generics
    let exactnessScore = 0;
    if (genericTransformFns > 0) {
      exactnessScore += 10;
    }
    if (pickOmitPatterns >= 2) {
      exactnessScore += 8;
    }
    if (keyofUsage >= 3) {
      exactnessScore += 7;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    if (constrainedKeyParams > 0 || (mappedTypes > 0 && keyofUsage > 0)) {
      wrongPathScore = 10;
    } else if (keyofUsage > 0 || mappedTypes > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "keyPreservingTransforms",
      passed,
      reason: passed
        ? `${keyofUsage} keyof usages, ${mappedTypes} mapped types, ${pickOmitPatterns} Pick/Omit patterns, ${constrainedKeyParams} keyof constraints`
        : "Limited key-preserving transforms",
      score,
    });
  },
  name: "keyPreservingTransforms",
};

// ---------------------------------------------------------------------------
// Scenario 2: Deep transforms
// ---------------------------------------------------------------------------

const deepTransforms: ScenarioTest = {
  description:
    "Deep utility types (DeepPartial, DeepRequired) should recurse properly via recursive type aliases that transform nested structures",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let deepTypes = 0;
    let recursiveTypes = 0;
    let conditionalRecursion = 0;
    let inferredRecursion = 0;
    let _totalTypeAliases = 0;

    for (const decl of surface.declarations) {
      if (decl.kind !== "type-alias") {
        continue;
      }
      _totalTypeAliases++;
      const lowerName = decl.name.toLowerCase();

      // Named deep types
      if (
        lowerName.includes("deep") ||
        lowerName.includes("recursive") ||
        lowerName.includes("nested") ||
        lowerName.includes("flatten") ||
        lowerName.includes("unwrap")
      ) {
        deepTypes++;
      }

      if (!decl.bodyTypeNode) {
        continue;
      }
      const bodyText = decl.bodyTypeNode.getText();

      // Self-referencing = recursive type alias
      if (bodyText.includes(decl.name)) {
        recursiveTypes++;

        // Conditional recursion (T extends object ? ... : ...)
        if (hasConditionalType(bodyText)) {
          conditionalRecursion++;
        }

        // Infer in recursive context
        if (/\binfer\s+\w/.test(bodyText)) {
          inferredRecursion++;
        }
      }

      // Check for deep transforms even if not named "deep" — e.g., type that uses itself in mapped type
      if (hasMappedType(bodyText) && bodyText.includes(decl.name) && hasConditionalType(bodyText)) {
        conditionalRecursion++;
      }
    }

    // 40% compile-success: deep/recursive type declarations exist
    let compileScore = 0;
    if (recursiveTypes > 0 || deepTypes > 0) {
      compileScore = 40;
    }

    // 25% compile-failure: conditional recursion = proper base case
    let failureScore = 0;
    if (conditionalRecursion > 0) {
      failureScore += 15;
    }
    if (inferredRecursion > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: many recursive types, named deep types
    let exactnessScore = 0;
    if (deepTypes > 0 && recursiveTypes > 0) {
      exactnessScore += 15;
    } else if (deepTypes > 0 || recursiveTypes > 0) {
      exactnessScore += 8;
    }
    if (deepTypes >= 3) {
      exactnessScore += 5;
    }
    if (recursiveTypes >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: recursive types should be conditional (not infinite)
    let wrongPathScore = 0;
    if (recursiveTypes > 0 && conditionalRecursion >= recursiveTypes) {
      wrongPathScore = 10;
    } else if (conditionalRecursion > 0) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "deepTransforms",
      passed,
      reason: passed
        ? `${deepTypes} deep types, ${recursiveTypes} recursive, ${conditionalRecursion} conditional, ${inferredRecursion} with infer`
        : "Limited deep/recursive type support",
      score,
    });
  },
  name: "deepTransforms",
};

// ---------------------------------------------------------------------------
// Scenario 3: Alias readability
// ---------------------------------------------------------------------------

const aliasReadability: ScenarioTest = {
  description:
    "Composed utility types should remain readable after application: meaningful names (>4 chars), domain terms, JSDoc presence",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let totalAliases = 0;
    let descriptiveAliases = 0;
    let crypticAliases = 0;
    let documentedAliases = 0;
    let genericWithConstraints = 0;

    for (const decl of surface.declarations) {
      if (decl.kind !== "type-alias") {
        continue;
      }
      totalAliases++;

      // Descriptive name: PascalCase, > 4 chars, contains lowercase
      if (isDescriptiveName(decl.name)) {
        descriptiveAliases++;
      }

      // Cryptic name: single letter, or <= 2 chars
      if (isShortCrypticName(decl.name)) {
        crypticAliases++;
      }

      // JSDoc presence
      if (decl.hasJSDoc) {
        documentedAliases++;
      }

      // Generic with constraints = more readable than unconstrained
      if (decl.typeParameters.length > 0 && decl.typeParameters.some((tp) => tp.hasConstraint)) {
        genericWithConstraints++;
      }
    }

    // Also check interfaces and functions for naming quality
    let totalNamedDecls = totalAliases;
    let _descriptiveNamedDecls = descriptiveAliases;
    for (const decl of surface.declarations) {
      if (decl.kind === "interface" || decl.kind === "class") {
        totalNamedDecls++;
        if (isDescriptiveName(decl.name)) {
          _descriptiveNamedDecls++;
        }
        if (decl.hasJSDoc) {
          documentedAliases++;
        }
      }
    }

    if (totalAliases === 0) {
      return makeResult({
        name: "aliasReadability",
        passed: false,
        reason: "No type aliases found",
        score: 30,
      });
    }

    const descriptiveRatio = descriptiveAliases / totalAliases;
    const docRatio = totalNamedDecls > 0 ? documentedAliases / totalNamedDecls : 0;

    // 40% compile-success: type aliases exist with descriptive names
    let compileScore = 0;
    if (descriptiveRatio >= 0.7) {
      compileScore = 40;
    } else if (descriptiveRatio >= 0.5) {
      compileScore = 30;
    } else if (totalAliases > 0) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained generics prevent misuse
    let failureScore = 0;
    if (genericWithConstraints > 0) {
      failureScore += 15;
    }
    if (crypticAliases === 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: documented + descriptive
    let exactnessScore = 0;
    if (docRatio >= 0.5) {
      exactnessScore += 12;
    } else if (docRatio >= 0.2) {
      exactnessScore += 6;
    }
    if (descriptiveRatio >= 0.8) {
      exactnessScore += 8;
    }
    if (totalAliases >= 5) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: few cryptic aliases
    let wrongPathScore = 0;
    if (crypticAliases === 0) {
      wrongPathScore = 10;
    } else if (crypticAliases < totalAliases / 4) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "aliasReadability",
      passed,
      reason: passed
        ? `${descriptiveAliases}/${totalAliases} descriptive aliases, ${documentedAliases} documented, ${crypticAliases} cryptic, ${genericWithConstraints} constrained generics`
        : "Type aliases lack readability",
      score,
    });
  },
  name: "aliasReadability",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const SCHEMA_PACK: ScenarioPack = {
  description:
    "Tests schema/utility libraries for key preservation, deep transforms, and alias readability",
  domain: "schema",
  isApplicable: (surface) => {
    const genericTypeAliases = surface.declarations.filter(
      (decl) => decl.kind === "type-alias" && decl.typeParameters.length > 0,
    ).length;
    return {
      applicable: genericTypeAliases >= 3,
      reason:
        genericTypeAliases >= 3
          ? `${genericTypeAliases} generic type aliases found`
          : "Insufficient generic type aliases for schema assessment",
    };
  },
  name: "schema",
  scenarios: [keyPreservingTransforms, deepTransforms, aliasReadability],
};
