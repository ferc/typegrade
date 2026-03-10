import { SmartUsageError, runSmart } from "../src/cli-smart.js";
import { classifyTarget, isLocalTarget, isPackageTarget } from "../src/cli-targets.js";

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

describe("target classification", () => {
  it("classifies '.' as workspace or repo", () => {
    const result = classifyTarget(".");
    // The current project has pnpm-workspace.yaml, so it's a workspace
    expect(["workspace", "repo"]).toContain(result.kind);
    expect(result.resolvedPath).toBeDefined();
  });

  it("classifies existing directory with tsconfig", () => {
    const result = classifyTarget(".");
    expect(["workspace", "repo"]).toContain(result.kind);
  });

  it("classifies npm package name as package-spec", () => {
    const result = classifyTarget("zod");
    expect(result.kind).toBe("package-spec");
    expect(result.resolvedPath).toBeUndefined();
  });

  it("classifies scoped package name as package-spec", () => {
    const result = classifyTarget("@tanstack/query-core");
    expect(result.kind).toBe("package-spec");
  });

  it("classifies non-existent path starting with dot as invalid", () => {
    const result = classifyTarget("./nonexistent-path-xyz-12345");
    expect(result.kind).toBe("invalid");
    expect(result.error).toBeDefined();
  });

  it("rejects clearly invalid names", () => {
    const result = classifyTarget("$$$invalid!!!");
    expect(result.kind).toBe("invalid");
  });
});

describe("local target check", () => {
  it("returns true for workspace targets", () => {
    expect(isLocalTarget({ kind: "workspace", raw: "." })).toBeTruthy();
  });

  it("returns true for repo targets", () => {
    expect(isLocalTarget({ kind: "repo", raw: "." })).toBeTruthy();
  });

  it("returns true for package-path targets", () => {
    expect(isLocalTarget({ kind: "package-path", raw: "./lib" })).toBeTruthy();
  });

  it("returns false for package-spec targets", () => {
    expect(isLocalTarget({ kind: "package-spec", raw: "zod" })).toBeFalsy();
  });

  it("returns false for invalid targets", () => {
    expect(isLocalTarget({ kind: "invalid", raw: "???" })).toBeFalsy();
  });
});

describe("package target check", () => {
  it("returns true for package-spec", () => {
    expect(isPackageTarget({ kind: "package-spec", raw: "zod" })).toBeTruthy();
  });

  it("returns true for package-path", () => {
    expect(isPackageTarget({ kind: "package-path", raw: "./lib" })).toBeTruthy();
  });

  it("returns false for repo", () => {
    expect(isPackageTarget({ kind: "repo", raw: "." })).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Smart dispatch routing
// ---------------------------------------------------------------------------

describe("runSmart routing", () => {
  it("routes zero args to repo audit on '.'", async () => {
    const { result } = await runSmart([], {});
    expect(result.resultKind).toBe("smart-cli");
    expect(result.mode).toBe("repo-audit");
    expect(result.targetKind).toBe("repo");
  });

  it("routes '.' to repo audit", async () => {
    const { result } = await runSmart(["."], {});
    expect(result.mode).toBe("repo-audit");
  });

  it("routes '.' with --improve to repo audit", async () => {
    const { result } = await runSmart(["."], { improve: true });
    expect(result.mode).toBe("repo-audit");
  });

  it("throws SmartUsageError for --improve on package spec", async () => {
    await expect(runSmart(["zod"], { improve: true })).rejects.toThrow(SmartUsageError);
  });

  it("throws SmartUsageError for --against with one target", async () => {
    await expect(runSmart(["zod"], { against: "." })).rejects.toThrow(SmartUsageError);
  });

  it("throws SmartUsageError for --improve with two targets", async () => {
    await expect(runSmart(["zod", "yup"], { improve: true })).rejects.toThrow(SmartUsageError);
  });

  it("throws SmartUsageError for too many arguments", async () => {
    await expect(runSmart(["a", "b", "c"], {})).rejects.toThrow(SmartUsageError);
  });

  it("throws SmartUsageError for invalid target", async () => {
    await expect(runSmart(["$$$invalid!!!"], {})).rejects.toThrow(SmartUsageError);
  });
});

// ---------------------------------------------------------------------------
// SmartCliResult shape
// ---------------------------------------------------------------------------

describe("smart cli result shape", () => {
  it("repo audit has all required top-level fields", async () => {
    const { result } = await runSmart([], {});

    expect(result.analysisSchemaVersion).toBeDefined();
    expect(result.resultKind).toBe("smart-cli");
    expect(result.mode).toBeDefined();
    expect(result.targetKind).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.trust).toBeDefined();
    expect(result.primary).toBeDefined();
    expect(result.supplements).toBeDefined();
    expect(result.nextAction).toBeDefined();
    expect(result.executionDiagnostics).toBeDefined();
  });

  it("summary has required fields", async () => {
    const { result } = await runSmart([], {});
    const { summary } = result;

    expect(summary.headline).toBeDefined();
    expect(summary.verdict).toBeDefined();
    expect(summary.scorecard).toBeDefined();
    expect(summary.topReasons).toBeDefined();
    expect(summary.topRisks).toBeDefined();
    expect(["good", "needs-work", "poor", "degraded", "abstained"]).toContain(summary.verdict);
  });

  it("trust has required fields", async () => {
    const { result } = await runSmart([], {});
    const { trust } = result;

    expect(trust.classification).toBeDefined();
    expect(trust.canCompare).toBeDefined();
    expect(trust.canGate).toBeDefined();
    expect(Array.isArray(trust.reasons)).toBeTruthy();
  });

  it("nextAction has required fields", async () => {
    const { result } = await runSmart([], {});
    const { nextAction } = result;

    expect(nextAction.kind).toBeDefined();
    expect(nextAction.title).toBeDefined();
    expect(nextAction.why).toBeDefined();
    expect(Array.isArray(nextAction.files)).toBeTruthy();
    expect(nextAction.verification).toBeDefined();
  });

  it("executionDiagnostics has required fields", async () => {
    const { result } = await runSmart([], {});
    const diag = result.executionDiagnostics;

    expect(diag.analysisPath).toBeDefined();
    expect(diag.phaseTimings).toBeDefined();
    expect(Array.isArray(diag.resourceWarnings)).toBeTruthy();
    expect(Array.isArray(diag.fallbacksApplied)).toBeTruthy();
  });
});
