import type { CompositeKey } from "./types.js";

export interface DimensionWeightConfig {
  key: string;
  label: string;
  weights: Partial<Record<CompositeKey, number>>;
  sourceOnly: boolean;
}

/**
 * Global weight model — three-layer scoring.
 *
 * Package-mode global weights (consumerApi):
 *   apiSpecificity 0.22, apiSafety 0.18, semanticLift 0.10,
 *   specializationPower 0.15, publishQuality 0.08, surfaceConsistency 0.06,
 *   surfaceComplexity 0.04, agentUsability 0.17
 *
 * Agent readiness:
 *   agentUsability 0.28, specializationPower 0.20, apiSpecificity 0.14,
 *   apiSafety 0.12, semanticLift 0.10, publishQuality 0.06,
 *   surfaceConsistency 0.05, surfaceComplexity 0.05
 *
 * Type safety:
 *   apiSafety 0.45, apiSpecificity 0.20, semanticLift 0.10,
 *   specializationPower 0.10, publishQuality 0.05,
 *   implementationSoundness 0.05, boundaryDiscipline 0.03, configDiscipline 0.02
 *
 * Rule: domain inference must never directly increase a global score.
 */
export const DIMENSION_CONFIGS: DimensionWeightConfig[] = [
  {
    key: "apiSpecificity",
    label: "API Specificity",
    sourceOnly: false,
    weights: { agentReadiness: 0.14, consumerApi: 0.22, typeSafety: 0.2 },
  },
  {
    key: "apiSafety",
    label: "API Safety",
    sourceOnly: false,
    weights: { agentReadiness: 0.12, consumerApi: 0.18, typeSafety: 0.45 },
  },
  {
    key: "semanticLift",
    label: "Semantic Lift",
    sourceOnly: false,
    weights: { agentReadiness: 0.1, consumerApi: 0.1, typeSafety: 0.1 },
  },
  {
    key: "specializationPower",
    label: "Specialization Power",
    sourceOnly: false,
    weights: { agentReadiness: 0.2, consumerApi: 0.15, typeSafety: 0.1 },
  },
  {
    key: "publishQuality",
    label: "Publish Quality",
    sourceOnly: false,
    weights: { agentReadiness: 0.06, consumerApi: 0.08, typeSafety: 0.05 },
  },
  {
    key: "surfaceConsistency",
    label: "Surface Consistency",
    sourceOnly: false,
    weights: { agentReadiness: 0.05, consumerApi: 0.06 },
  },
  {
    key: "surfaceComplexity",
    label: "Surface Complexity",
    sourceOnly: false,
    weights: { agentReadiness: 0.05, consumerApi: 0.04 },
  },
  {
    key: "agentUsability",
    label: "Agent Usability",
    sourceOnly: false,
    weights: { agentReadiness: 0.28, consumerApi: 0.17 },
  },
  {
    key: "declarationFidelity",
    label: "Declaration Fidelity",
    sourceOnly: true,
    weights: { consumerApi: 0.1, typeSafety: 0.1 },
  },
  {
    key: "implementationSoundness",
    label: "Soundness",
    sourceOnly: true,
    weights: { implementationQuality: 0.45, typeSafety: 0.05 },
  },
  {
    key: "boundaryDiscipline",
    label: "Boundary Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.25, typeSafety: 0.03 },
  },
  {
    key: "configDiscipline",
    label: "Config Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.2, typeSafety: 0.02 },
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
  cli: ["commander", "yargs", "cac", "meow", "oclif", "inquirer", "prompts", "citty", "cleye"],
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
  state: [
    "zustand",
    "jotai",
    "valtio",
    "recoil",
    "mobx",
    "redux",
    "@reduxjs/toolkit",
    "nanostores",
    "pinia",
  ],
  stream: ["rxjs", "xstate", "most", "callbag", "@most/core"],
  testing: [
    "vitest",
    "jest",
    "@testing-library",
    "playwright",
    "cypress",
    "supertest",
    "msw",
    "nock",
  ],
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
  cli: [
    {
      dimension: "apiSpecificity",
      reason: "Command option schema inference is core CLI value",
      weight: 1.3,
    },
    {
      dimension: "agentUsability",
      reason: "CLI builder discoverability matters for AI agents",
      weight: 1.2,
    },
    {
      dimension: "specializationPower",
      reason: "Parsed argument inference is key CLI specialization",
      weight: 1.2,
    },
  ],
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
    {
      dimension: "specializationPower",
      reason: "Query builder row-shape narrowing is key ORM specialization",
      weight: 1.3,
    },
  ],
  result: [
    { dimension: "semanticLift", reason: "Error channel propagation is core value", weight: 1.4 },
    {
      dimension: "agentUsability",
      reason: "map/flatMap/match predictability matters",
      weight: 1.2,
    },
    {
      dimension: "specializationPower",
      reason: "Result/effect channel propagation specialization",
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
    {
      dimension: "specializationPower",
      reason: "Route param extraction and loader result propagation are key specializations",
      weight: 1.4,
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
    {
      dimension: "specializationPower",
      reason: "Key-preserving transforms are the core schema specialization",
      weight: 1.3,
    },
  ],
  state: [
    {
      dimension: "apiSpecificity",
      reason: "Store/atom type inference is the core state value",
      weight: 1.3,
    },
    {
      dimension: "semanticLift",
      reason: "Derived/computed state propagation matters",
      weight: 1.2,
    },
    {
      dimension: "specializationPower",
      reason: "State slice narrowing is key specialization",
      weight: 1.2,
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
    {
      dimension: "specializationPower",
      reason: "Operator inference and typed channels are stream specializations",
      weight: 1.2,
    },
  ],
  testing: [
    {
      dimension: "apiSpecificity",
      reason: "Mock/fixture typing precision matters for test tools",
      weight: 1.2,
    },
    {
      dimension: "agentUsability",
      reason: "Test helper discoverability is key for testing tools",
      weight: 1.3,
    },
    {
      dimension: "specializationPower",
      reason: "Assertion/matcher narrowing is key specialization",
      weight: 1.2,
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
    {
      dimension: "specializationPower",
      reason: "Schema decode/parse output specialization",
      weight: 1.2,
    },
  ],
};
