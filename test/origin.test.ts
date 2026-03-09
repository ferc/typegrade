import type { Issue } from "../src/types.js";
import { classifyFileOrigin } from "../src/origin/classifier.js";
import { filterIssues } from "../src/origin/filter.js";

function buildIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    column: 1,
    dimension: "apiSpecificity",
    file: "src/index.ts",
    line: 1,
    message: "test issue",
    severity: "warning",
    ...overrides,
  };
}

describe("file origin classifier", () => {
  it("classifies source files", () => {
    expect(classifyFileOrigin("src/index.ts")).toBe("source");
    expect(classifyFileOrigin("/project/src/utils/format.ts")).toBe("source");
    expect(classifyFileOrigin("lib/helpers.ts")).toBe("source");
  });

  it("classifies dist output", () => {
    expect(classifyFileOrigin("dist/index.d.ts")).toBe("dist");
    expect(classifyFileOrigin("/project/dist/types.d.ts")).toBe("dist");
    expect(classifyFileOrigin("/project/build/output.js")).toBe("dist");
    expect(classifyFileOrigin("out/bundle.js")).toBe("dist");
  });

  it("classifies generated files", () => {
    expect(classifyFileOrigin("src/schema.generated.ts")).toBe("generated");
    expect(classifyFileOrigin("src/api.gen.ts")).toBe("generated");
    expect(classifyFileOrigin("src/__generated__/types.ts")).toBe("generated");
    expect(classifyFileOrigin("src/message.pb.ts")).toBe("generated");
    expect(classifyFileOrigin("src/api.swagger.ts")).toBe("generated");
    expect(classifyFileOrigin("src/openapi-types.ts")).toBe("generated");
    expect(classifyFileOrigin("src/client.trpc.ts")).toBe("generated");
  });

  it("classifies vendor files", () => {
    expect(classifyFileOrigin("/project/vendor/lib.ts")).toBe("vendor");
    expect(classifyFileOrigin("/project/third-party/utils.ts")).toBe("vendor");
    expect(classifyFileOrigin("/project/third_party/lib.ts")).toBe("vendor");
  });

  it("classifies test files", () => {
    expect(classifyFileOrigin("src/index.test.ts")).toBe("test");
    expect(classifyFileOrigin("src/index.spec.ts")).toBe("test");
    expect(classifyFileOrigin("__tests__/unit.ts")).toBe("test");
    expect(classifyFileOrigin("__mocks__/mock.ts")).toBe("test");
    expect(classifyFileOrigin("test/helpers.ts")).toBe("test");
  });

  it("classifies config files", () => {
    expect(classifyFileOrigin("vitest.config.ts")).toBe("config");
    expect(classifyFileOrigin("tsconfig.json")).toBe("config");
    expect(classifyFileOrigin("eslint.config.ts")).toBe("config");
  });
});

describe("issue filter", () => {
  it("excludes generated-origin issues by default", () => {
    const issues = [
      buildIssue({ file: "src/index.ts" }),
      buildIssue({ file: "dist/types.d.ts" }),
      buildIssue({ file: "src/schema.generated.ts" }),
    ];
    const { actionable, noiseSummary } = filterIssues(issues);
    expect(actionable).toHaveLength(1);
    expect(actionable[0]!.file).toBe("src/index.ts");
    expect(noiseSummary.generatedIssueCount).toBe(2);
    expect(noiseSummary.suppressedGeneratedCount).toBe(2);
  });

  it("includes generated issues when requested", () => {
    const issues = [buildIssue({ file: "src/index.ts" }), buildIssue({ file: "dist/types.d.ts" })];
    const { actionable } = filterIssues(issues, { includeGenerated: true });
    expect(actionable).toHaveLength(2);
  });

  it("excludes suppressed issues", () => {
    const issues = [buildIssue(), buildIssue({ suppressionReason: "generated-artifact" })];
    const { actionable } = filterIssues(issues);
    expect(actionable).toHaveLength(1);
  });

  it("excludes dependency-owned issues", () => {
    const issues = [
      buildIssue({ ownership: "source-owned" }),
      buildIssue({ ownership: "dependency-owned" }),
    ];
    const { actionable } = filterIssues(issues);
    expect(actionable).toHaveLength(1);
  });

  it("applies confidence gate", () => {
    const issues = [buildIssue({ confidence: 0.9 }), buildIssue({ confidence: 0.3 })];
    const { actionable } = filterIssues(issues, { minConfidence: 0.7 });
    expect(actionable).toHaveLength(1);
  });

  it("applies budget limit", () => {
    const issues = Array.from({ length: 10 }, (_unused, idx) =>
      buildIssue({ agentPriority: idx * 10 }),
    );
    const { actionable } = filterIssues(issues, { budget: 3 });
    expect(actionable).toHaveLength(3);
    // Should get highest priority first
    expect(actionable[0]!.agentPriority).toBe(90);
  });

  it("computes actionability summary", () => {
    const issues = [
      buildIssue({ confidence: 0.9, fixability: "direct", ownership: "source-owned" }),
      buildIssue({ confidence: 0.5, fixability: "indirect", ownership: "workspace-owned" }),
      buildIssue({ file: "dist/out.d.ts" }),
    ];
    const { actionabilitySummary } = filterIssues(issues);
    expect(actionabilitySummary.actionableIssueCount).toBe(2);
    expect(actionabilitySummary.directlyFixableCount).toBe(1);
    expect(actionabilitySummary.highConfidenceActionableCount).toBe(1);
  });

  it("computes noise summary", () => {
    const issues = [
      buildIssue({ file: "src/index.ts" }),
      buildIssue({ file: "src/utils.ts" }),
      buildIssue({ file: "dist/index.d.ts" }),
      buildIssue({ file: "vendor/lib.ts" }),
    ];
    const { noiseSummary } = filterIssues(issues);
    expect(noiseSummary.generatedIssueCount).toBe(2);
    expect(noiseSummary.generatedIssueRatio).toBe(0.5);
    expect(noiseSummary.sourceOwnedIssueCount).toBe(2);
    expect(noiseSummary.excludedPaths).toHaveLength(2);
  });
});
