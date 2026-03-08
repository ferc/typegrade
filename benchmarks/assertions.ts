// Pairwise ranking assertions for consumerApiScore
// These encode known ground-truth: libraries with richer type systems
// should score higher than those with loose/broad types.

export interface PairwiseAssertion {
  higher: string;
  lower: string;
  composite: "consumerApi" | "agentReadiness";
  class: "must-pass" | "diagnostic";
  minDelta?: number;
}

export const PAIRWISE_ASSERTIONS: PairwiseAssertion[] = [
  // Tier boundary assertions (must-pass): elite/solid > loose
  { class: "must-pass", composite: "consumerApi", higher: "zod", lower: "express" },
  { class: "must-pass", composite: "consumerApi", higher: "zod", lower: "lodash" },
  { class: "must-pass", composite: "consumerApi", higher: "valibot", lower: "express" },
  { class: "must-pass", composite: "consumerApi", higher: "valibot", lower: "lodash" },
  { class: "must-pass", composite: "consumerApi", higher: "ts-pattern", lower: "express" },
  { class: "must-pass", composite: "consumerApi", higher: "date-fns", lower: "lodash" },
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "express" },
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "lodash" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "express" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "lodash" },

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
  { class: "must-pass", composite: "consumerApi", higher: "arktype", lower: "axios" },
  { class: "must-pass", composite: "consumerApi", higher: "effect", lower: "axios" },

  // Elite vs solid (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "type-fest" },
  { class: "diagnostic", composite: "consumerApi", higher: "valibot", lower: "drizzle-orm" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "type-fest" },

  // Solid tier (diagnostic)
  { class: "diagnostic", composite: "consumerApi", higher: "type-fest", lower: "lodash" },
  { class: "diagnostic", composite: "consumerApi", higher: "type-fest", lower: "axios" },
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
  { class: "diagnostic", composite: "consumerApi", higher: "date-fns", lower: "uuid" },
  { class: "diagnostic", composite: "consumerApi", higher: "zod", lower: "moment" },
  { class: "diagnostic", composite: "consumerApi", higher: "ts-pattern", lower: "axios" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "express" },
  { class: "diagnostic", composite: "consumerApi", higher: "remeda", lower: "moment" },
];
