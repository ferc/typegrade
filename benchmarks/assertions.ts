// Pairwise ranking assertions for consumerApiScore
// These encode known ground-truth: libraries with richer type systems
// should score higher than those with loose/broad types.

export interface PairwiseAssertion {
  higher: string;
  lower: string;
  composite: "consumerApi" | "agentReadiness";
  class: "must-pass" | "diagnostic";
  minDelta?: number;
  reason?: string;
  ambiguity?: "low" | "medium" | "high";
}

export const PAIRWISE_ASSERTIONS: PairwiseAssertion[] = [
  // Tier boundary assertions (must-pass): elite/solid > loose
  { class: "must-pass", composite: "consumerApi", higher: "zod", lower: "express", minDelta: 3, reason: "Validation library with rich branded types vs loosely-typed middleware framework" },
  { class: "must-pass", composite: "consumerApi", higher: "zod", lower: "lodash", minDelta: 3, reason: "Branded output types and discriminated unions vs utility with broad @types definitions" },
  { class: "must-pass", composite: "consumerApi", higher: "valibot", lower: "express", minDelta: 3, reason: "Tree-shakeable validation with narrow types vs loosely-typed middleware" },
  { class: "must-pass", composite: "consumerApi", higher: "valibot", lower: "lodash", minDelta: 3, reason: "Tree-shakeable validation with narrow types vs utility with broad @types definitions" },
  { class: "must-pass", composite: "consumerApi", higher: "ts-pattern", lower: "express", minDelta: 3, reason: "Exhaustive pattern matching with discriminated unions vs loosely-typed middleware" },
  { class: "must-pass", composite: "consumerApi", higher: "date-fns", lower: "lodash", minDelta: 3, reason: "Well-typed date utilities with overloaded signatures vs broad @types definitions" },
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "express", minDelta: 3, reason: "Elite validation with deep type inference vs loosely-typed middleware" },
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "lodash", minDelta: 3, reason: "Elite validation with branded/constrained types vs broad @types definitions" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "express", minDelta: 3, reason: "Effect system with branded/tagged types vs loosely-typed middleware" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "lodash", minDelta: 3, reason: "Effect system with branded/tagged types vs broad @types definitions" },

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
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "axios", minDelta: 5, reason: "Elite validation library vs loosely-typed HTTP client" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "axios", minDelta: 5, reason: "Elite effect system vs loosely-typed HTTP client" },

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
  { class: "diagnostic", composite: "consumerApi", higher: "moment", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "uuid", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "lodash", lower: "express" },

  // Cross-tier (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "arktype", lower: "neverthrow" },
  { class: "diagnostic", composite: "consumerApi", higher: "effect", lower: "remeda" },
  { class: "diagnostic", composite: "consumerApi", higher: "date-fns", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "zod", lower: "moment" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "moment" },

  // Coverage assertions: ensure every package appears in at least one must-pass
  { class: "must-pass", composite: "consumerApi", higher: "remeda", lower: "express", minDelta: 3, reason: "Typed functional utility vs loosely-typed middleware" },
  { class: "must-pass", composite: "consumerApi", higher: "neverthrow", lower: "moment", minDelta: 2, reason: "Result monad with discriminated types vs legacy date library" },
  { class: "must-pass", composite: "consumerApi", higher: "type-fest", lower: "axios", minDelta: 3, reason: "Advanced type utilities vs loosely-typed HTTP client" },
  { class: "must-pass", composite: "consumerApi", higher: "date-fns", lower: "uuid", minDelta: 3, reason: "Well-typed date utilities with overloaded signatures vs simple UUID generator" },

  // Stretch package diagnostic assertions
  { class: "diagnostic", composite: "consumerApi", higher: "fp-ts", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "io-ts", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "rxjs", lower: "moment" },
  { class: "diagnostic", composite: "consumerApi", higher: "hono", lower: "express" },
];
