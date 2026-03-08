import {
  EXPECTED_DOMAINS,
  PAIRWISE_ASSERTIONS,
  SCENARIO_ASSERTIONS,
} from "../benchmarks/assertions.js";
import { Project } from "ts-morph";
import { detectDomain } from "../src/domain.js";
import { extractPublicSurface } from "../src/surface/index.js";

function getSurfaceFromCode(code: string) {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  project.createSourceFile("test.ts", code);
  return extractPublicSurface(project.getSourceFiles());
}

describe("generalization: domain inference", () => {
  it("does not misclassify validation libraries as orm", () => {
    // Zod-like surface: parse, safeParse, schema-ish type names
    const surface = getSurfaceFromCode(`
      export function parse(input: unknown): string { return ""; }
      export function safeParse(input: unknown): { success: boolean; data?: string } { return { success: true }; }
      export type ZodSchema<T> = { parse: (input: unknown) => T };
      export type ZodString = ZodSchema<string>;
      export type ZodNumber = ZodSchema<number>;
      export type ZodObject<T> = ZodSchema<T>;
    `);

    // Without package name
    const resultNoName = detectDomain(surface);
    expect(resultNoName.domain).not.toBe("orm");

    // With zod package name
    const result = detectDomain(surface, "zod");
    expect(result.domain).toBe("validation");
  });

  it("does not misclassify effect-like libraries as router", () => {
    // Effect-like surface: generic functional types
    const surface = getSurfaceFromCode(`
      export type Effect<A, E, R> = { _tag: "Effect"; _A: A; _E: E; _R: R };
      export type Either<E, A> = { _tag: "Left"; left: E } | { _tag: "Right"; right: A };
      export function succeed<A>(value: A): Effect<A, never, never> { return {} as any; }
      export function fail<E>(error: E): Effect<never, E, never> { return {} as any; }
      export function map<A, B>(f: (a: A) => B): (self: Effect<A, never, never>) => Effect<B, never, never> { return {} as any; }
    `);

    const result = detectDomain(surface, "effect");
    expect(result.domain).toBe("result");
    expect(result.domain).not.toBe("router");
  });

  it("does not misclassify remeda as stream", () => {
    // Remeda-like surface: functional utility with pipe
    const surface = getSurfaceFromCode(`
      export function pipe<A, B>(value: A, fn1: (a: A) => B): B { return fn1(value); }
      export function map<T, U>(fn: (item: T) => U): (arr: T[]) => U[] { return [] as any; }
      export function filter<T>(fn: (item: T) => boolean): (arr: T[]) => T[] { return [] as any; }
      export function reduce<T, U>(fn: (acc: U, item: T) => U, init: U): (arr: T[]) => U { return {} as any; }
    `);

    const result = detectDomain(surface);
    expect(result.domain).not.toBe("stream");
  });

  it("abstains to general when evidence is ambiguous and no package name", () => {
    // Surface with mixed signals
    const surface = getSurfaceFromCode(`
      export interface Config { host: string; port: number }
      export function create(config: Config): void {}
      export function connect(url: string): Promise<void> { return Promise.resolve(); }
      export type Options = { timeout: number };
    `);

    const result = detectDomain(surface);
    expect(result.domain).toBe("general");
  });

  it("package name prior dominates over declaration patterns", () => {
    // Surface that looks like it could be ORM (has "table", "column") but package is validation
    const surface = getSurfaceFromCode(`
      export function table<T>(schema: T): T { return schema; }
      export function column(name: string): { name: string } { return { name }; }
      export function validate(input: unknown): boolean { return true; }
      export function parse(input: unknown): string { return ""; }
    `);

    const result = detectDomain(surface, "valibot");
    expect(result.domain).toBe("validation");
  });
});

describe("generalization: perturbation stability", () => {
  it("produces deterministic scores for the same input", () => {
    const surface = getSurfaceFromCode(`
      export function parse<T>(schema: T, input: unknown): T { return {} as T; }
      export type Schema<T> = { _output: T; parse: (input: unknown) => T };
      export function string(): Schema<string> { return {} as any; }
      export function number(): Schema<number> { return {} as any; }
    `);

    const result1 = detectDomain(surface, "zod");
    const result2 = detectDomain(surface, "zod");

    expect(result1.domain).toBe(result2.domain);
    expect(result1.confidence).toBe(result2.confidence);
    expect(result1.ambiguityGap).toBe(result2.ambiguityGap);
  });
});

describe("generalization: naive baseline sanity", () => {
  it("domain inference varies with surface content", () => {
    // A validation-looking surface should detect differently from a generic surface
    const validationSurface = getSurfaceFromCode(`
      export function parse(input: unknown): string { return ""; }
      export function safeParse(input: unknown): { success: boolean } { return { success: true }; }
      export function validate(input: unknown): boolean { return true; }
      export function check(input: unknown): number { return 0; }
    `);

    const genericSurface = getSurfaceFromCode(`
      export function add(a: number, b: number): number { return a + b; }
    `);

    const validationResult = detectDomain(validationSurface);
    const genericResult = detectDomain(genericSurface);

    // The validation surface has scenario-trigger signals that the generic one lacks
    expect(validationResult.matchedRules.length).toBeGreaterThan(genericResult.matchedRules.length);
  });

  it("all expected domains in EXPECTED_DOMAINS have a corresponding pairwise or scenario assertion", () => {
    // Every package in EXPECTED_DOMAINS should appear in at least one assertion
    const assertionPackages = new Set<string>();
    for (const assertion of PAIRWISE_ASSERTIONS) {
      assertionPackages.add(assertion.higher);
      assertionPackages.add(assertion.lower);
    }
    // Also include scenario assertions
    for (const assertion of SCENARIO_ASSERTIONS) {
      assertionPackages.add(assertion.higher);
      assertionPackages.add(assertion.lower);
    }

    const missing: string[] = [];
    for (const pkg of Object.keys(EXPECTED_DOMAINS)) {
      if (!assertionPackages.has(pkg)) {
        missing.push(pkg);
      }
    }
    expect(missing).toStrictEqual([]);
  });
});
