// Pairwise ranking assertions for consumerApiScore
// These encode known ground-truth: libraries with richer type systems
// should score higher than those with loose/broad types.

export interface PairwiseAssertion {
  higher: string;
  lower: string;
  composite: "consumerApi" | "agentReadiness";
}

export const PAIRWISE_ASSERTIONS: PairwiseAssertion[] = [
  { composite: "consumerApi", higher: "zod", lower: "express" },
  { composite: "consumerApi", higher: "zod", lower: "lodash" },
  { composite: "consumerApi", higher: "valibot", lower: "express" },
  { composite: "consumerApi", higher: "valibot", lower: "lodash" },
  { composite: "consumerApi", higher: "ts-pattern", lower: "express" },
  { composite: "consumerApi", higher: "date-fns", lower: "lodash" },
];
