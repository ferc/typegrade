import type { TypePrecisionLevel } from "./types.js";

export const DEFAULT_WEIGHTS = {
  typePrecision: 0.3,
  typeCoverage: 0.15,
  strictConfig: 0.15,
  unsoundness: 0.15,
  exportQuality: 0.15,
  runtimeValidation: 0.1,
} as const;

export const PRECISION_SCORES: Record<TypePrecisionLevel, number> = {
  any: 0,
  unknown: 20,
  "wide-primitive": 35,
  "primitive-union": 45,
  "generic-unbound": 40,
  interface: 55,
  enum: 65,
  "generic-bound": 70,
  literal: 80,
  "template-literal": 82,
  "literal-union": 85,
  branded: 95,
  "discriminated-union": 95,
  never: 90,
};

export const STRICT_FLAGS: Record<string, number> = {
  strict: 10,
  noImplicitAny: 10,
  strictNullChecks: 15,
  strictFunctionTypes: 10,
  strictBindCallApply: 5,
  strictPropertyInitialization: 5,
  noImplicitReturns: 8,
  noFallthroughCasesInSwitch: 5,
  noUncheckedIndexedAccess: 12,
  exactOptionalPropertyTypes: 10,
  noImplicitOverride: 5,
  isolatedModules: 3,
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
