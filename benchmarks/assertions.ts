// Pairwise ranking assertions for consumerApiScore
// These encode known ground-truth: libraries with richer type systems
// should score higher than those with loose/broad types.

export interface PairwiseAssertion {
  higher: string;
  lower: string;
  composite: "consumerApi" | "agentReadiness";
}

export const PAIRWISE_ASSERTIONS: PairwiseAssertion[] = [
  // Original assertions (tier boundary: elite/solid > loose)
  { composite: "consumerApi", higher: "zod", lower: "express" },
  { composite: "consumerApi", higher: "zod", lower: "lodash" },
  { composite: "consumerApi", higher: "valibot", lower: "express" },
  { composite: "consumerApi", higher: "valibot", lower: "lodash" },
  { composite: "consumerApi", higher: "ts-pattern", lower: "express" },
  { composite: "consumerApi", higher: "date-fns", lower: "lodash" },

  // Intra-tier and cross-tier (all observed delta >= 13)
  { composite: "consumerApi", higher: "valibot", lower: "zod" },
  { composite: "consumerApi", higher: "valibot", lower: "date-fns" },
  { composite: "consumerApi", higher: "valibot", lower: "remeda" },
  { composite: "consumerApi", higher: "remeda", lower: "lodash" },
  { composite: "consumerApi", higher: "date-fns", lower: "axios" },
  { composite: "consumerApi", higher: "zod", lower: "axios" },
  { composite: "consumerApi", higher: "ts-pattern", lower: "lodash" },
  { composite: "consumerApi", higher: "neverthrow", lower: "axios" },

  // Elite tier internal (arktype & effect vs loose)
  { composite: "consumerApi", higher: "arktype", lower: "express" },
  { composite: "consumerApi", higher: "arktype", lower: "lodash" },
  { composite: "consumerApi", higher: "arktype", lower: "axios" },
  { composite: "consumerApi", higher: "effect", lower: "express" },
  { composite: "consumerApi", higher: "effect", lower: "lodash" },
  { composite: "consumerApi", higher: "effect", lower: "axios" },

  // Elite vs solid
  { composite: "consumerApi", higher: "valibot", lower: "type-fest" },
  { composite: "consumerApi", higher: "valibot", lower: "drizzle-orm" },
  { composite: "consumerApi", higher: "ts-pattern", lower: "type-fest" },

  // Solid tier
  { composite: "consumerApi", higher: "type-fest", lower: "lodash" },
  { composite: "consumerApi", higher: "type-fest", lower: "axios" },
  { composite: "consumerApi", higher: "drizzle-orm", lower: "axios" },
  { composite: "consumerApi", higher: "remeda", lower: "axios" },
  // Loose tier differentiation (moment has more complete types than express;
  // uuid is small but clean, outscoring lodash/axios which have any leaks)
  { composite: "consumerApi", higher: "moment", lower: "express" },
  { composite: "consumerApi", higher: "uuid", lower: "axios" },
  { composite: "consumerApi", higher: "lodash", lower: "express" },

  // Cross-tier
  { composite: "consumerApi", higher: "arktype", lower: "neverthrow" },
  { composite: "consumerApi", higher: "effect", lower: "remeda" },
  { composite: "consumerApi", higher: "date-fns", lower: "express" },
  { composite: "consumerApi", higher: "date-fns", lower: "uuid" },
  { composite: "consumerApi", higher: "zod", lower: "moment" },
  { composite: "consumerApi", higher: "ts-pattern", lower: "axios" },
  { composite: "consumerApi", higher: "remeda", lower: "express" },
  { composite: "consumerApi", higher: "remeda", lower: "moment" },
];
