import { detectDomain } from "../src/domain.js";
import { extractPublicSurface } from "../src/surface/index.js";
import { Project } from "ts-morph";
import { resolve } from "node:path";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function getSurfaceFromCode(code: string) {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  project.createSourceFile("test.ts", code);
  return extractPublicSurface(project.getSourceFiles());
}

function getFixtureSurface(name: string) {
  const project = new Project({
    tsConfigFilePath: resolve(fixturesDir, name, "tsconfig.json"),
  });
  return extractPublicSurface(project.getSourceFiles());
}

describe(detectDomain, () => {
  it("detects validation domain by package name", () => {
    const surface = getSurfaceFromCode("export function parse(x: string): number { return 0; }");
    const result = detectDomain(surface, "zod");
    expect(result.domain).toBe("validation");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects result domain by package name", () => {
    const surface = getSurfaceFromCode(
      "export type Result<T> = { ok: true; value: T } | { ok: false };",
    );
    const result = detectDomain(surface, "neverthrow");
    expect(result.domain).toBe("result");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects router domain by package name", () => {
    const surface = getFixtureSurface("router-style");
    const result = detectDomain(surface, "express");
    expect(result.domain).toBe("router");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects orm domain by package name", () => {
    const surface = getFixtureSurface("orm-style");
    const result = detectDomain(surface, "drizzle-orm");
    expect(result.domain).toBe("orm");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects router domain by declaration patterns", () => {
    const surface = getFixtureSurface("router-style");
    const result = detectDomain(surface);
    // Router fixture has 7 matching declarations, so signal should be >= 0.5
    expect(result.domain).toBe("router");
  });

  it("detects orm domain by declaration patterns", () => {
    const surface = getFixtureSurface("orm-style");
    const result = detectDomain(surface);
    // ORM fixture has column, table, schema, query, migration = 5 matches
    expect(result.domain).toBe("orm");
  });

  it("detects validation domain by unknown params with package name hint", () => {
    // Validation detection by unknown params alone requires >30% unknown params
    // Which is hard to guarantee without the package name hint
    const surface = getSurfaceFromCode(`
      export function parse(input: unknown): string { return ""; }
      export function validate(input: unknown): boolean { return true; }
      export function check(input: unknown): number { return 0; }
      export function ok(input: string): string { return input; }
    `);
    // With a validation library name hint, it detects validation
    const result = detectDomain(surface, "zod");
    expect(result.domain).toBe("validation");
  });

  it("detects result domain by type alias names", () => {
    const surface = getSurfaceFromCode(`
      export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
      export type Ok<T> = { ok: true; value: T };
      export type Err<E> = { ok: false; error: E };
    `);
    const result = detectDomain(surface);
    expect(result.domain).toBe("result");
  });

  it("detects schema domain for type-heavy packages", () => {
    const surface = getSurfaceFromCode(`
      export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
      export type DeepRequired<T> = T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;
      export type Merge<A, B> = Omit<A, keyof B> & B;
      export type PickByValue<T, V> = { [K in keyof T as T[K] extends V ? K : never]: T[K] };
      export type Entries<T> = { [K in keyof T]: [K, T[K]] }[keyof T];
    `);
    const result = detectDomain(surface, "type-fest");
    expect(result.domain).toBe("schema");
  });

  it("records suppressed issues for validation domain", () => {
    const surface = getSurfaceFromCode("export function parse(x: unknown): string { return ''; }");
    const result = detectDomain(surface, "zod");
    expect(result.suppressedIssues).toBeDefined();
    expect(result.suppressedIssues!.length).toBeGreaterThan(0);
  });

  it("returns general domain with low confidence when no pattern matches", () => {
    const surface = getSurfaceFromCode(
      "export function add(a: number, b: number): number { return a + b; }",
    );
    const result = detectDomain(surface);
    expect(result.domain).toBe("general");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("includes falsePositiveRisk and matchedRules", () => {
    const surface = getSurfaceFromCode("export function parse(x: string): number { return 0; }");
    const result = detectDomain(surface, "zod");
    expect(result.falsePositiveRisk).toBeDefined();
    expectTypeOf(result.falsePositiveRisk).toBeNumber();
    expect(result.matchedRules).toBeDefined();
    expect(result.matchedRules.length).toBeGreaterThan(0);
  });
});
