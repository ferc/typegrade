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
];
