import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { analyzeStrictConfig } from "../src/analyzers/strict-config.js";

function createProjectWithOptions(options: Record<string, unknown>) {
  return new Project({
    compilerOptions: options as any,
    useInMemoryFileSystem: true,
  });
}

describe("analyzeStrictConfig", () => {
  it("scores high for strict: true + extra flags", () => {
    const project = createProjectWithOptions({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
    });
    const result = analyzeStrictConfig(project);
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it("scores low for empty config", () => {
    const project = createProjectWithOptions({});
    const result = analyzeStrictConfig(project);
    expect(result.score).toBeLessThan(20);
  });

  it("scores medium for strict: true only", () => {
    const project = createProjectWithOptions({ strict: true });
    const result = analyzeStrictConfig(project);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.score).toBeLessThanOrEqual(60);
  });

  it("returns dimension name and weight", () => {
    const project = createProjectWithOptions({ strict: true });
    const result = analyzeStrictConfig(project);
    expect(result.name).toBe("Strict Config");
    expect(result.weight).toBe(0.15);
  });
});
