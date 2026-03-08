import type { CompositeKey } from "./types.js";

export interface DimensionWeightConfig {
  key: string;
  label: string;
  weights: Partial<Record<CompositeKey, number>>;
  sourceOnly: boolean;
}

export const DIMENSION_CONFIGS: DimensionWeightConfig[] = [
  {
    key: "apiSpecificity",
    label: "API Specificity",
    sourceOnly: false,
    weights: { consumerApi: 0.35 },
  },
  {
    key: "apiSafety",
    label: "API Safety",
    sourceOnly: false,
    weights: { consumerApi: 0.2 },
  },
  {
    key: "semanticLift",
    label: "Semantic Lift",
    sourceOnly: false,
    weights: { consumerApi: 0.15 },
  },
  {
    key: "publishQuality",
    label: "Publish Quality",
    sourceOnly: false,
    weights: { consumerApi: 0.08 },
  },
  {
    key: "surfaceConsistency",
    label: "Surface Consistency",
    sourceOnly: false,
    weights: { consumerApi: 0.05 },
  },
  {
    key: "surfaceComplexity",
    label: "Surface Complexity",
    sourceOnly: false,
    weights: { consumerApi: 0.05 },
  },
  {
    key: "agentUsability",
    label: "Agent Usability",
    sourceOnly: false,
    weights: { consumerApi: 0.05 },
  },
  {
    key: "declarationFidelity",
    label: "Declaration Fidelity",
    sourceOnly: true,
    weights: { consumerApi: 0.07 },
  },
  {
    key: "implementationSoundness",
    label: "Soundness",
    sourceOnly: true,
    weights: { implementationQuality: 0.45 },
  },
  {
    key: "boundaryDiscipline",
    label: "Boundary Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.25 },
  },
  {
    key: "configDiscipline",
    label: "Config Discipline",
    sourceOnly: true,
    weights: { implementationQuality: 0.2 },
  },
];

export const AGENT_READINESS_WEIGHTS = {
  package: { consumerApi: 1 },
  source: { consumerApi: 0.65, implementationQuality: 0.35 },
} as const;

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
  router: ["express", "fastify", "hono", "koa", "hapi", "restify", "react-router", "@trpc/server"],
  schema: ["type-fest", "ts-toolbelt", "utility-types", "type-zoo"],
  stream: ["rxjs", "xstate", "most", "callbag", "@most/core"],
  validation: ["zod", "valibot", "arktype", "io-ts", "yup", "joi", "superstruct", "runtypes", "typia", "@effect/schema"],
} as const;
