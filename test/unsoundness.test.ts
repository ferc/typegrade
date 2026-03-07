import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { analyzeUnsoundness } from "../src/analyzers/unsoundness.js";

function createProjectWithCode(code: string) {
  const project = new Project({
    compilerOptions: { strict: true, target: 2, module: 99 },
    useInMemoryFileSystem: true,
  });
  project.createSourceFile("test.ts", code);
  return project;
}

describe("analyzeUnsoundness", () => {
  it("detects as assertions", () => {
    const project = createProjectWithCode(
      'const x = {} as { name: string };',
    );
    const result = analyzeUnsoundness(project);
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("detects as any", () => {
    const project = createProjectWithCode("const x = {} as any;");
    const result = analyzeUnsoundness(project);
    const errors = result.issues.filter(
      (i) => i.severity === "error" && i.message.includes("as any"),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("detects double assertion", () => {
    const project = createProjectWithCode(
      "const x = {} as unknown as number;",
    );
    const result = analyzeUnsoundness(project);
    const errors = result.issues.filter(
      (i) => i.severity === "error" && i.message.includes("double"),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("detects non-null assertion", () => {
    const project = createProjectWithCode(
      "const x: string | null = null;\nconst y = x!;",
    );
    const result = analyzeUnsoundness(project);
    const warnings = result.issues.filter(
      (i) => i.message.includes("non-null"),
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @ts-ignore", () => {
    const project = createProjectWithCode(
      "// @ts-ignore\nconst x: number = 'string' as any;",
    );
    const result = analyzeUnsoundness(project);
    const ignores = result.issues.filter(
      (i) => i.message.includes("@ts-ignore"),
    );
    expect(ignores.length).toBeGreaterThanOrEqual(1);
    expect(ignores[0].severity).toBe("error");
  });

  it("treats @ts-expect-error as info", () => {
    const project = createProjectWithCode(
      "// @ts-expect-error\nconst x: number = 'string' as any;",
    );
    const result = analyzeUnsoundness(project);
    const expectErrors = result.issues.filter(
      (i) => i.message.includes("@ts-expect-error"),
    );
    expect(expectErrors.length).toBeGreaterThanOrEqual(1);
    expect(expectErrors[0].severity).toBe("info");
  });

  it("scores 100 for clean code", () => {
    const project = createProjectWithCode(
      "const x: number = 42;\nconst y: string = 'hello';",
    );
    const result = analyzeUnsoundness(project);
    expect(result.score).toBe(100);
  });
});
