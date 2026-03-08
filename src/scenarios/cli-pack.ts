import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/**
 * CLI scenario pack.
 *
 * Tests how well a CLI library preserves types through option/argument schemas,
 * parsed argument inference, and subcommand handler contracts.
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

function isOptionRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("option") ||
    lower.includes("argument") ||
    lower.includes("flag") ||
    lower.includes("param") ||
    lower.includes("args")
  );
}

function isParseRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("parse") ||
    lower.includes("action") ||
    lower.includes("run") ||
    lower.includes("execute") ||
    lower.includes("invoke")
  );
}

function isCommandRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("command") ||
    lower.includes("subcommand") ||
    lower.includes("program") ||
    lower.includes("cli") ||
    lower.includes("app")
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: Option schema inference
// ---------------------------------------------------------------------------

const optionSchemaInference: ScenarioTest = {
  description:
    "Command options should have typed schema definitions, with generics that infer option types from declarations",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let optionDecls = 0;
    let genericOptions = 0;
    let constrainedOptions = 0;
    let overloadedOptions = 0;
    let optionMethodCount = 0;

    for (const decl of surface.declarations) {
      if (!isOptionRelated(decl.name)) {
        continue;
      }
      optionDecls++;

      if (decl.typeParameters.length > 0) {
        genericOptions++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedOptions++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedOptions++;
      }

      // Check methods for option-building patterns
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isOptionRelated);
        optionMethodCount += ms.matchCount;
        genericOptions += ms.genericCount;
        constrainedOptions += ms.constrainedCount;
        overloadedOptions += ms.overloadedCount;
      }
    }

    // 40% compile-success: option declarations with generics
    let compileScore = 0;
    if (genericOptions > 0) {
      compileScore = 40;
    } else if (optionDecls >= 2 || optionMethodCount >= 2) {
      compileScore = 20;
    } else if (optionDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained options reject wrong types
    let failureScore = 0;
    if (constrainedOptions > 0) {
      failureScore += 12;
    }
    if (overloadedOptions > 0) {
      failureScore += 8;
    }
    if (optionMethodCount >= 2) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: multiple generic options
    let exactnessScore = 0;
    if (genericOptions >= 2) {
      exactnessScore += 12;
    }
    if (constrainedOptions >= 2) {
      exactnessScore += 8;
    }
    if (overloadedOptions > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedOptions = optionDecls - genericOptions;
    if (untypedOptions <= 0 && optionDecls > 0) {
      wrongPathScore = 10;
    } else if (optionDecls > 0 && untypedOptions < optionDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "optionSchemaInference",
      passed,
      reason: passed
        ? `${genericOptions} generic options, ${constrainedOptions} constrained, ${overloadedOptions} overloaded`
        : "Limited option schema inference",
      score,
    });
  },
  name: "optionSchemaInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Parsed argument inference
// ---------------------------------------------------------------------------

const parsedArgumentInference: ScenarioTest = {
  description:
    "Parsed arguments should infer types from option schema, providing typed access to CLI arguments",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let parseDecls = 0;
    let genericParses = 0;
    let constrainedParses = 0;
    let overloadedParses = 0;
    let parseMethodCount = 0;

    for (const decl of surface.declarations) {
      if (!isParseRelated(decl.name)) {
        continue;
      }
      parseDecls++;

      if (decl.typeParameters.length > 0) {
        genericParses++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedParses++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedParses++;
      }

      // Check methods
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isParseRelated);
        parseMethodCount += ms.matchCount;
        genericParses += ms.genericCount;
        constrainedParses += ms.constrainedCount;
        overloadedParses += ms.overloadedCount;
      }
    }

    if (parseDecls === 0 && parseMethodCount === 0) {
      return makeResult({
        name: "parsedArgumentInference",
        passed: false,
        reason: "No parse/action declarations found",
        score: 25,
      });
    }

    // 40% compile-success: parse declarations with generics
    let compileScore = 0;
    if (genericParses > 0) {
      compileScore = 40;
    } else if (parseDecls >= 2 || parseMethodCount >= 2) {
      compileScore = 20;
    } else if (parseDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained parses reject wrong types
    let failureScore = 0;
    if (constrainedParses > 0) {
      failureScore += 15;
    }
    if (overloadedParses > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness
    let exactnessScore = 0;
    if (genericParses >= 2) {
      exactnessScore += 15;
    }
    if (constrainedParses > 0) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedParses = parseDecls - genericParses;
    if (untypedParses <= 0 && parseDecls > 0) {
      wrongPathScore = 10;
    } else if (parseDecls > 0 && untypedParses < parseDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "parsedArgumentInference",
      passed,
      reason: passed
        ? `${genericParses} generic parse decls, ${constrainedParses} constrained, ${overloadedParses} overloaded`
        : "Parsed arguments lack type inference",
      score,
    });
  },
  name: "parsedArgumentInference",
};

// ---------------------------------------------------------------------------
// Scenario 3: Subcommand contract
// ---------------------------------------------------------------------------

const subcommandContract: ScenarioTest = {
  description:
    "Subcommands should have distinct typed handler contracts, with command-specific option schemas",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let commandDecls = 0;
    let genericCommands = 0;
    let constrainedCommands = 0;
    let commandMethodCount = 0;
    let overloadedCommands = 0;

    for (const decl of surface.declarations) {
      if (!isCommandRelated(decl.name)) {
        continue;
      }
      commandDecls++;

      if (decl.typeParameters.length > 0) {
        genericCommands++;
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedCommands++;
        }
      }
      if (decl.overloadCount && decl.overloadCount > 1) {
        overloadedCommands++;
      }

      // Check methods for subcommand-building patterns
      if (decl.methods) {
        const ms = countMethodMatches(decl.methods, isCommandRelated);
        commandMethodCount += ms.matchCount;
        genericCommands += ms.genericCount;
        constrainedCommands += ms.constrainedCount;
        overloadedCommands += ms.overloadedCount;
      }
    }

    if (commandDecls === 0) {
      return makeResult({
        name: "subcommandContract",
        passed: false,
        reason: "No command/subcommand declarations found",
        score: 25,
      });
    }

    // 40% compile-success: command declarations with generics
    let compileScore = 0;
    if (genericCommands > 0) {
      compileScore = 40;
    } else if (commandDecls >= 2 || commandMethodCount >= 2) {
      compileScore = 20;
    } else if (commandDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained commands reject wrong handler types
    let failureScore = 0;
    if (constrainedCommands > 0) {
      failureScore += 12;
    }
    if (overloadedCommands > 0) {
      failureScore += 8;
    }
    if (commandMethodCount >= 2) {
      failureScore += 5;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness
    let exactnessScore = 0;
    if (genericCommands >= 2) {
      exactnessScore += 12;
    }
    if (constrainedCommands > 0) {
      exactnessScore += 8;
    }
    if (commandMethodCount >= 3) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedCommands = commandDecls - genericCommands;
    if (untypedCommands <= 0 && commandDecls > 0) {
      wrongPathScore = 10;
    } else if (commandDecls > 0 && untypedCommands < commandDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "subcommandContract",
      passed,
      reason: passed
        ? `${genericCommands} generic commands, ${constrainedCommands} constrained, ${commandMethodCount} command methods`
        : "Subcommands lack typed handler contracts",
      score,
    });
  },
  name: "subcommandContract",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const CLI_PACK: ScenarioPack = {
  description:
    "Tests CLI libraries for option schema inference, parsed argument typing, and subcommand contracts",
  domain: "cli",
  name: "cli",
  scenarios: [optionSchemaInference, parsedArgumentInference, subcommandContract],
};
