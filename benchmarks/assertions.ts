// Pairwise ranking assertions for composite scores
// These encode known ground-truth: libraries with richer type systems
// Should score higher than those with loose/broad types.

export interface PairwiseAssertion {
  higher: string;
  lower: string;
  composite: "consumerApi" | "agentReadiness" | "typeSafety";
  class: "must-pass" | "diagnostic" | "hard-diagnostic" | "ambiguous" | "regression-watch";
  minDelta?: number;
  reason?: string;
  ambiguity?: "low" | "medium" | "high";
  introducedAt?: string;
  owner?: string;
  expectedFailureUntil?: string;
}

export interface ScenarioAssertion {
  higher: string;
  lower: string;
  domain: string;
  scoreType: "scenarioScore" | "domainFitScore" | "agentReadiness";
  class: "must-pass" | "diagnostic" | "hard-diagnostic" | "ambiguous" | "regression-watch";
  reason?: string;
  introducedAt?: string;
  owner?: string;
  minDelta?: number;
}

export const PAIRWISE_ASSERTIONS: PairwiseAssertion[] = [
  // Tier boundary assertions (must-pass): elite/solid > loose
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "zod",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Validation library with rich branded types vs loosely-typed middleware framework",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "zod",
    introducedAt: "v0.4.0",
    lower: "lodash",
    minDelta: 3,
    reason:
      "Branded output types and discriminated unions vs utility with broad @types definitions",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "valibot",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Tree-shakeable validation with narrow types vs loosely-typed middleware",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "valibot",
    introducedAt: "v0.4.0",
    lower: "lodash",
    minDelta: 3,
    reason: "Tree-shakeable validation with narrow types vs utility with broad @types definitions",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "ts-pattern",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Exhaustive pattern matching with discriminated unions vs loosely-typed middleware",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "date-fns",
    introducedAt: "v0.4.0",
    lower: "lodash",
    minDelta: 3,
    reason: "Well-typed date utilities with overloaded signatures vs broad @types definitions",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "arktype",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Elite validation with deep type inference vs loosely-typed middleware",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "arktype",
    introducedAt: "v0.4.0",
    lower: "lodash",
    minDelta: 3,
    reason: "Elite validation with branded/constrained types vs broad @types definitions",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "effect",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Effect system with branded/tagged types vs loosely-typed middleware",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "effect",
    introducedAt: "v0.4.0",
    lower: "lodash",
    minDelta: 3,
    reason: "Effect system with branded/tagged types vs broad @types definitions",
  },

  // Intra-tier and cross-tier (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "zod" },
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "date-fns" },
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "remeda" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "lodash" },
  { class: "diagnostic", composite: "consumerApi", higher: "date-fns", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "zod", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "lodash" },
  { class: "diagnostic", composite: "consumerApi", higher: "neverthrow", lower: "axios" },

  // Elite tier vs loose (must-pass)
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "arktype",
    introducedAt: "v0.4.0",
    lower: "axios",
    minDelta: 5,
    reason: "Elite validation library vs loosely-typed HTTP client",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "effect",
    introducedAt: "v0.4.0",
    lower: "axios",
    minDelta: 5,
    reason: "Elite effect system vs loosely-typed HTTP client",
  },

  // Elite vs solid (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "type-fest" },
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "drizzle-orm" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "type-fest" },

  // Solid tier (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "type-fest", lower: "lodash" },
  { class: "diagnostic", composite: "consumerApi", higher: "type-fest", lower: "uuid" },
  { class: "diagnostic", composite: "consumerApi", higher: "drizzle-orm", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "axios" },

  // Loose tier differentiation (diagnostic)
  {
    ambiguity: "high",
    class: "ambiguous",
    composite: "consumerApi",
    higher: "moment",
    lower: "express",
  },
  { class: "diagnostic", composite: "consumerApi", higher: "uuid", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "lodash", lower: "express" },

  // Cross-tier (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "arktype", lower: "neverthrow" },
  {
    ambiguity: "medium",
    class: "ambiguous",
    composite: "consumerApi",
    higher: "effect",
    lower: "remeda",
  },
  { class: "diagnostic", composite: "consumerApi", higher: "date-fns", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "zod", lower: "moment" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "moment" },

  // Coverage assertions: ensure every package appears in at least one must-pass
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "remeda",
    introducedAt: "v0.4.0",
    lower: "express",
    minDelta: 3,
    reason: "Typed functional utility vs loosely-typed middleware",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "neverthrow",
    introducedAt: "v0.4.0",
    lower: "moment",
    minDelta: 2,
    reason: "Result monad with discriminated types vs legacy date library",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "type-fest",
    introducedAt: "v0.4.0",
    lower: "axios",
    minDelta: 3,
    reason: "Advanced type utilities vs loosely-typed HTTP client",
  },
  {
    class: "must-pass",
    composite: "consumerApi",
    higher: "date-fns",
    introducedAt: "v0.4.0",
    lower: "uuid",
    minDelta: 3,
    reason: "Well-typed date utilities with overloaded signatures vs simple UUID generator",
  },

  // Stretch package diagnostic assertions
  { class: "diagnostic", composite: "consumerApi", higher: "fp-ts", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "io-ts", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "rxjs", lower: "moment" },
  { class: "diagnostic", composite: "consumerApi", higher: "hono", lower: "express" },

  // --- Agent readiness assertions ---
  // Fp-ts and io-ts: high sophistication but moderated agentReadiness
  {
    class: "hard-diagnostic",
    composite: "agentReadiness",
    higher: "zod",
    introducedAt: "v0.5.0",
    lower: "fp-ts",
    reason: "Zod is more agent-friendly than fp-ts despite lower sophistication",
  },
  {
    class: "hard-diagnostic",
    composite: "agentReadiness",
    higher: "valibot",
    introducedAt: "v0.5.0",
    lower: "io-ts",
    reason: "Valibot is more agent-friendly than io-ts",
  },
  {
    class: "diagnostic",
    composite: "agentReadiness",
    higher: "date-fns",
    lower: "fp-ts",
    reason: "date-fns is easier for AI agents than fp-ts",
  },
  {
    ambiguity: "medium",
    class: "ambiguous",
    composite: "agentReadiness",
    higher: "remeda",
    lower: "io-ts",
    reason: "remeda has simpler API for AI agents but io-ts has rich typed codec system",
  },

  // --- Type safety assertions ---
  {
    class: "hard-diagnostic",
    composite: "typeSafety",
    higher: "zod",
    introducedAt: "v0.5.0",
    lower: "express",
    reason: "Validation library must score higher on type safety",
  },
  {
    class: "hard-diagnostic",
    composite: "typeSafety",
    higher: "valibot",
    introducedAt: "v0.5.0",
    lower: "lodash",
    reason: "Validation library vs broad @types",
  },
  { class: "diagnostic", composite: "typeSafety", higher: "arktype", lower: "axios" },
  { class: "diagnostic", composite: "typeSafety", higher: "effect", lower: "moment" },
  // fp-ts typeSafety high but agentReadiness lower than zod
  {
    class: "diagnostic",
    composite: "typeSafety",
    higher: "fp-ts",
    lower: "express",
    reason: "fp-ts has strong type safety",
  },

  // --- Stretch corpus expansion assertions ---
  { class: "diagnostic", composite: "consumerApi", higher: "superstruct", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "runtypes", lower: "lodash" },
  { class: "diagnostic", composite: "consumerApi", higher: "kysely", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "xstate", lower: "moment" },

  // --- Regression watch ---
  {
    class: "regression-watch",
    composite: "consumerApi",
    higher: "drizzle-orm",
    introducedAt: "v0.5.0",
    lower: "express",
    reason: "drizzle-orm should not cluster with loose-tier",
  },
];

/**
 * Expected domain ground truth for each benchmark package.
 * Used to measure domain inference accuracy.
 */
export const EXPECTED_DOMAINS: Record<string, string> = {
  "@tanstack/react-router": "router",
  arktype: "validation",
  axios: "general",
  "date-fns": "general",
  "drizzle-orm": "orm",
  effect: "result",
  express: "router",
  "fp-ts": "result",
  hono: "router",
  "io-ts": "validation",
  kysely: "orm",
  lodash: "general",
  moment: "general",
  neverthrow: "result",
  remeda: "general",
  runtypes: "validation",
  rxjs: "stream",
  superstruct: "validation",
  "ts-pattern": "general",
  "type-fest": "schema",
  uuid: "general",
  valibot: "validation",
  xstate: "stream",
  zod: "validation",
};

/**
 * Packages that are structurally undersampled (few reachable files, few positions/declarations)
 * but have been manually verified to produce stable, meaningful scores.
 * These are excluded from the undersampled-anchor gate check.
 *
 * NOTE: With the samplingClass distinction (complete/compact/undersampled),
 * compact packages (few files but sufficient surface) are no longer flagged
 * as undersampled and should not need waivers. This set should stay empty.
 */
export const UNDERSAMPLED_ANCHOR_WAIVERS: Set<string> = new Set([]);

export const SCENARIO_ASSERTIONS: ScenarioAssertion[] = [
  // Router scenario assertions (both detected as router domain)
  {
    class: "diagnostic",
    domain: "router",
    higher: "@tanstack/react-router",
    introducedAt: "v0.6.0",
    lower: "hono",
    reason: "TanStack Router has more complete route typing coverage",
    scoreType: "scenarioScore",
  },

  // ORM scenario assertions (both detected as orm domain)
  {
    class: "diagnostic",
    domain: "orm",
    higher: "drizzle-orm",
    introducedAt: "v0.6.0",
    lower: "kysely",
    reason: "Drizzle ORM has stronger scenario coverage for schema inference",
    scoreType: "scenarioScore",
  },

  // Validation scenario assertions (runtypes detected as validation)
  {
    class: "diagnostic",
    domain: "validation",
    higher: "runtypes",
    introducedAt: "v0.6.0",
    lower: "type-fest",
    reason: "Runtypes has validation-specific scenario coverage",
    scoreType: "domainFitScore",
    minDelta: 0,
  },
];
