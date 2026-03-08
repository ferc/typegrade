import type { CompositeKey } from "./types.js";

export interface DimensionWeightConfig {
  key: string;
  label: string;
  weights: Partial<Record<CompositeKey, number>>;
  sourceOnly: boolean;
}

/**
 * Global weight model.
 *
 * Each dimension declares weights for each composite it contributes to.
 * globalConsumerApi weights follow the plan's fixed global weights:
 *   apiSpecificity 0.28, apiSafety 0.18, semanticLift 0.12,
 *   publishQuality 0.10, surfaceConsistency 0.07, surfaceComplexity 0.05,
 *   agentUsability 0.20
 *
 * agentReadiness emphasizes agentUsability (0.35) with a different mix.
 * typeSafety emphasizes apiSafety (0.50) and apiSpecificity (0.25).
 *
 * Rule: domain inference must never directly increase a global score.
 */
export const DIMENSION_CONFIGS: DimensionWeightConfig[] = [
  {
    key: "apiSpecificity",
    label: "API Specificity",
    sourceOnly: false,
    weights: { agentReadiness: 0.18, consumerApi: 0.28, typeSafety: 0.25 },
  },
  {
    key: "apiSafety",
    label: "API Safety",
    sourceOnly: false,
    weights: { agentReadiness: 0.12, consumerApi: 0.18, typeSafety: 0.5 },
  },
  {
    key: "semanticLift",
    label: "Semantic Lift",
    sourceOnly: false,
    weights: { agentReadiness: 0.1, consumerApi: 0.12, typeSafety: 0.1 },
  },
  {
    key: "publishQuality",
    label: "Publish Quality",
    sourceOnly: false,
    weights: { agentReadiness: 0.05, consumerApi: 0.1, typeSafety: 0.05 },
  },
  {
    key: "surfaceConsistency",
    label: "Surface Consistency",
    sourceOnly: false,
    weights: { agentReadiness: 0.05, consumerApi: 0.07 },
  },
  {
    key: "surfaceComplexity",
    label: "Surface Complexity",
    sourceOnly: false,
    weights: { agentReadiness: 0.05, consumerApi: 0.05 },
  },
  {
    key: "agentUsability",
    label: "Agent Usability",
    sourceOnly: false,
    weights: { agentReadiness: 0.35, consumerApi: 0.2 },
  },
  {
    key: "declarationFidelity",
    label: "Declaration Fidelity",
    sourceOnly: true,
    weights: { agentReadiness: 0.05, consumerApi: 0.1, typeSafety: 0.1 },
  },
  {
    key: "implementationSoundness",
    label: "Soundness",
    sourceOnly: true,
    weights: { implementationQuality: 0.45, typeSafety: 0.2 },
  },
  {
    key: "boundaryDiscipline",
    label: "Boundary Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.25, typeSafety: 0.1 },
  },
  {
    key: "configDiscipline",
    label: "Config Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.2, typeSafety: 0.05 },
  },
];

export const STRICT_FLAGS: Record<string, number> = {
  exactOptionalPropertyTypes: 10,
  isolatedModules: 3,
  noFallthroughCasesInSwitch: 5,
  noImplicitAny: 10,
  noImplicitOverride: 5,
  noImplicitReturns: 8,
  noUncheckedIndexedAccess: 12,
  strict: 10,
  strictBindCallApply: 5,
  strictFunctionTypes: 10,
  strictNullChecks: 15,
  strictPropertyInitialization: 5,
  verbatimModuleSyntax: 2,
};

export const VALIDATION_LIBRARIES = [
  "zod",
  "valibot",
  "arktype",
  "io-ts",
  "yup",
  "joi",
  "superstruct",
  "runtypes",
  "typia",
  "@effect/schema",
];

export const DOMAIN_PATTERNS = {
  frontend: ["react", "preact", "vue", "svelte", "solid-js", "@angular/core"],
  orm: ["drizzle-orm", "prisma", "typeorm", "sequelize", "knex", "mikro-orm", "kysely"],
  result: ["neverthrow", "effect", "fp-ts", "purify-ts", "oxide.ts"],
  router: [
    "express",
    "fastify",
    "hono",
    "koa",
    "hapi",
    "restify",
    "react-router",
    "@trpc/server",
    "@tanstack/react-router",
  ],
  schema: ["type-fest", "ts-toolbelt", "utility-types", "type-zoo"],
  stream: ["rxjs", "xstate", "most", "callbag", "@most/core"],
  validation: [
    "zod",
    "valibot",
    "arktype",
    "io-ts",
    "yup",
    "joi",
    "superstruct",
    "runtypes",
    "typia",
    "@effect/schema",
  ],
} as const;

/**
 * Domain-fit weight adjustments.
 * These modify the domain-adjusted score, never the global score.
 */
export const DOMAIN_FIT_ADJUSTMENTS: Record<
  string,
  { dimension: string; weight: number; reason: string }[]
> = {
  orm: [
    {
      dimension: "apiSpecificity",
      reason: "Schema-to-query inference is the core ORM value",
      weight: 1.3,
    },
    {
      dimension: "semanticLift",
      reason: "Column/join type propagation matters for ORMs",
      weight: 1.2,
    },
  ],
  result: [
    { dimension: "semanticLift", reason: "Error channel propagation is core value", weight: 1.4 },
    {
      dimension: "agentUsability",
      reason: "map/flatMap/match predictability matters",
      weight: 1.2,
    },
  ],
  router: [
    {
      dimension: "apiSpecificity",
      reason: "Path-param/search-param inference is the core router value",
      weight: 1.4,
    },
    {
      dimension: "semanticLift",
      reason: "Route narrowing and loader result propagation matter",
      weight: 1.3,
    },
    {
      dimension: "surfaceComplexity",
      reason: "Router type complexity is expected and not harmful",
      weight: 0.7,
    },
  ],
  schema: [
    {
      dimension: "semanticLift",
      reason: "Type transforms are the core schema utility value",
      weight: 1.3,
    },
    {
      dimension: "surfaceComplexity",
      reason: "Generic-heavy surfaces are expected for type utilities",
      weight: 0.6,
    },
  ],
  stream: [
    {
      dimension: "semanticLift",
      reason: "Pipe/operator inference matters for streams",
      weight: 1.2,
    },
    {
      dimension: "surfaceComplexity",
      reason: "Complex generics are expected in reactive libraries",
      weight: 0.7,
    },
  ],
  validation: [
    {
      dimension: "apiSpecificity",
      reason: "Unknown-to-validated output is the core value",
      weight: 1.2,
    },
    {
      dimension: "semanticLift",
      reason: "Refinement pipelines add real semantic lift",
      weight: 1.2,
    },
  ],
};
