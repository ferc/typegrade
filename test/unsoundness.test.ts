import { Project } from "ts-morph";
import { analyzeImplementationSoundness } from "../src/analyzers/implementation-soundness.js";

function createProjectWithCode(code: string) {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  project.createSourceFile("test.ts", code);
  return project;
}

describe(analyzeImplementationSoundness, () => {
  it("detects as assertions", () => {
    const project = createProjectWithCode("const x = {} as { name: string };");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const warnings = result.issues.filter((issue) => issue.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("detects as any", () => {
    const project = createProjectWithCode("const x = {} as any;");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const errors = result.issues.filter(
      (issue) => issue.severity === "error" && issue.message.includes("as any"),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("detects double assertion", () => {
    const project = createProjectWithCode("const x = {} as unknown as number;");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const errors = result.issues.filter(
      (issue) => issue.severity === "error" && issue.message.includes("double"),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("detects non-null assertion", () => {
    const project = createProjectWithCode("const x: string | null = null;\nconst y = x!;");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const warnings = result.issues.filter((issue) => issue.message.includes("non-null"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @ts-ignore", () => {
    const project = createProjectWithCode("// @ts-ignore\nconst x: number = 'string' as any;");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const ignores = result.issues.filter((issue) => issue.message.includes("@ts-ignore"));
    expect(ignores.length).toBeGreaterThanOrEqual(1);
    expect(ignores[0].severity).toBe("error");
  });

  it("treats @ts-expect-error as info", () => {
    const project = createProjectWithCode(
      "// @ts-expect-error\nconst x: number = 'string' as any;",
    );
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    const expectErrors = result.issues.filter((issue) =>
      issue.message.includes("@ts-expect-error"),
    );
    expect(expectErrors.length).toBeGreaterThanOrEqual(1);
    expect(expectErrors[0].severity).toBe("info");
  });

  it("scores 100 for clean code", () => {
    const project = createProjectWithCode("const x: number = 42;\nconst y: string = 'hello';");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    expect(result.score).toBe(100);
  });

  it("returns correct dimension key and label", () => {
    const project = createProjectWithCode("const x = 1;");
    const result = analyzeImplementationSoundness(project.getSourceFiles());
    expect(result.key).toBe("implementationSoundness");
    expect(result.label).toBe("Soundness");
  });
});
