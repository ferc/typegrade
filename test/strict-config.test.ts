import { Project } from "ts-morph";
import { analyzeConfigDiscipline } from "../src/analyzers/config-discipline.js";

function createProjectWithOptions(options: Record<string, unknown>) {
  return new Project({
    compilerOptions: options as any,
    useInMemoryFileSystem: true,
  });
}

describe(analyzeConfigDiscipline, () => {
  it("scores high for strict: true + extra flags", () => {
    const project = createProjectWithOptions({
      exactOptionalPropertyTypes: true,
      isolatedModules: true,
      noFallthroughCasesInSwitch: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noUncheckedIndexedAccess: true,
      strict: true,
      verbatimModuleSyntax: true,
    });
    const result = analyzeConfigDiscipline(project.getSourceFiles(), project);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it("scores low for empty config", () => {
    const project = createProjectWithOptions({});
    const result = analyzeConfigDiscipline(project.getSourceFiles(), project);
    expect(result.score).toBeLessThan(20);
  });

  it("scores medium for strict: true only", () => {
    const project = createProjectWithOptions({ strict: true });
    const result = analyzeConfigDiscipline(project.getSourceFiles(), project);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.score).toBeLessThanOrEqual(60);
  });

  it("returns correct dimension key and label", () => {
    const project = createProjectWithOptions({ strict: true });
    const result = analyzeConfigDiscipline(project.getSourceFiles(), project);
    expect(result.key).toBe("configDiscipline");
    expect(result.label).toBe("Config Discipline");
  });
});
