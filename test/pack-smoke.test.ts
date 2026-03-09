import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

describe("pack smoke test", () => {
  it("library entry exports only intended symbols", async () => {
    const indexExports = await import("../src/index.js");
    const exportedNames = Object.keys(indexExports).toSorted();
    expect(exportedNames).toStrictEqual([
      "ANALYSIS_SCHEMA_VERSION",
      "analyzeBoundariesOnly",
      "analyzeMonorepo",
      "analyzeProject",
      "applyFixes",
      "applySuppressions",
      "buildAgentReport",
      "buildBoundaryGraph",
      "buildBoundarySummary",
      "buildFixPlan",
      "buildTaintFlowChains",
      "classifyFileOrigin",
      "comparePackages",
      "computeBoundaryHotspots",
      "computeBoundaryQuality",
      "computeDiff",
      "detectProfile",
      "enrichFixBatches",
      "evaluateBoundaryPolicies",
      "filterIssues",
      "fitCompare",
      "gatherProfileSignals",
      "loadConfig",
      "normalizeResult",
      "renderAgentJson",
      "renderDiffReport",
      "renderDimensionTable",
      "renderExplainability",
      "renderJson",
      "renderReport",
      "resolveFileOwnership",
      "scorePackage",
    ]);
  });

  it("cli entry has shebang and library entry does not", () => {
    const binPath = join(ROOT, "dist", "bin.js");
    const indexPath = join(ROOT, "dist", "index.js");

    expect(existsSync(binPath)).toBeTruthy();
    expect(existsSync(indexPath)).toBeTruthy();

    const binContent = readFileSync(binPath, "utf8");
    const indexContent = readFileSync(indexPath, "utf8");

    expect(binContent.startsWith("#!/usr/bin/env node")).toBeTruthy();
    expect(indexContent.startsWith("#!/")).toBeFalsy();
  });

  it("dist contains expected files", () => {
    const files = ["dist/bin.js", "dist/index.js", "dist/index.d.ts"];
    for (const file of files) {
      expect(existsSync(join(ROOT, file))).toBeTruthy();
    }
  });

  it("package.json exports map is valid", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    expect(pkg.type).toBe("module");
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["."].import.types).toBe("./dist/index.d.ts");
    expect(pkg.exports["."].import.default).toBe("./dist/index.js");
    expect(pkg.bin.typegrade).toBe("./dist/bin.js");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.sideEffects).toBeFalsy();
  });
});
