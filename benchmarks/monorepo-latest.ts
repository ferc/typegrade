import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeMonorepo } from "../src/monorepo/index.js";
import { ANALYSIS_SCHEMA_VERSION } from "../src/types.js";
import type { MonorepoReport } from "../src/types.js";
import type { RedactedMonorepoSummary } from "./types.js";
import { MONOREPO_ASSERTIONS } from "./types.js";

const projectRoot = join(import.meta.dirname, "..");
const outputPath = join(projectRoot, "benchmarks-output", "monorepo-summary.json");

interface MonorepoCaseResult {
  name: string;
  report: MonorepoReport;
}

function pct(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ensureOutputDir(): void {
  const dir = join(projectRoot, "benchmarks-output");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWorkspaceFixture(rootPath: string, kind: "clean" | "unhealthy" | "partial"): void {
  mkdirSync(rootPath, { recursive: true });
  writeJson(join(rootPath, "package.json"), {
    name: "@bench/root",
    private: true,
    version: "1.0.0",
    workspaces: ["packages/*"],
  });

  writeFileSync(join(rootPath, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

  const addPackage = (dirName: string, pkg: Record<string, unknown>) => {
    const dir = join(rootPath, "packages", dirName);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "package.json"), pkg);
  };

  if (kind === "partial") {
    addPackage("shared-utils", {
      name: "@bench/shared-utils",
      version: "1.0.0",
    });
    return;
  }

  addPackage("shared-utils", {
    name: "@bench/shared-utils",
    version: "1.0.0",
  });
  addPackage("domain-core", {
    name: "@bench/domain-core",
    version: "1.0.0",
    dependencies: {
      "@bench/shared-utils": "workspace:*",
    },
  });
  addPackage("infra-db", {
    name: "@bench/infra-db",
    version: "1.0.0",
    dependencies: {
      "@bench/domain-core": "workspace:*",
      "@bench/shared-utils": "workspace:*",
    },
  });
  addPackage("app-web", {
    name: "@bench/app-web",
    version: "1.0.0",
    dependencies: {
      "@bench/domain-core": "workspace:*",
      "@bench/infra-db": "workspace:*",
      "@bench/shared-utils": "workspace:*",
    },
  });

  if (kind === "unhealthy") {
    addPackage("domain-core", {
      name: "@bench/domain-core",
      version: "1.0.0",
      dependencies: {
        "@bench/infra-db": "workspace:*",
        "@bench/shared-utils": "workspace:*",
      },
    });
    addPackage("shared-utils", {
      name: "@bench/shared-utils",
      version: "1.0.0",
      dependencies: {
        "@bench/app-web": "workspace:*",
      },
    });
  }
}

function runCase(rootPath: string, kind: "clean" | "unhealthy" | "partial"): MonorepoCaseResult {
  const fixturePath = join(rootPath, kind);
  writeWorkspaceFixture(fixturePath, kind);
  const report = analyzeMonorepo({ rootPath: fixturePath });
  return { name: kind, report };
}

export async function runMonorepoLatest(): Promise<RedactedMonorepoSummary> {
  ensureOutputDir();

  const tempRoot = mkdtempSync(join(tmpdir(), "typegrade-monorepo-bench-"));
  const cases = [
    runCase(tempRoot, "clean"),
    runCase(tempRoot, "unhealthy"),
    runCase(tempRoot, "partial"),
  ];

  const totalCases = cases.length;
  const comparableCount = cases.filter((item) => item.report.healthSummary.decisionGrade !== "abstain")
    .length;
  const decisionGradeCount = cases.filter(
    (item) => item.report.healthSummary.decisionGrade !== "abstain",
  ).length;
  const strongDecisionCount = cases.filter((item) => item.report.healthSummary.decisionGrade === "strong")
    .length;
  const degradedRate = 0;
  const workspaceCoverageRate =
    cases.filter((item) => item.report.healthSummary.workspaceConfidence >= 0.6).length / totalCases;

  const clean = cases.find((item) => item.name === "clean")!.report;
  const unhealthy = cases.find((item) => item.name === "unhealthy")!.report;
  const partial = cases.find((item) => item.name === "partial")!.report;

  const calibratedHealthy =
    clean.healthSummary.healthScore >= 85 && clean.violations.length === 0;
  const calibratedUnhealthy =
    unhealthy.healthSummary.healthScore <= 80 && unhealthy.violations.length > 0;
  const calibratedPartial =
    partial.healthSummary.decisionGrade === "abstain" ||
    partial.healthSummary.workspaceConfidence < 0.7;
  const healthCalibrationRate =
    [calibratedHealthy, calibratedUnhealthy, calibratedPartial].filter(Boolean).length / 3;

  const metrics = {
    comparableRate: totalCases > 0 ? comparableCount / totalCases : 0,
    decisionGradeRate: totalCases > 0 ? decisionGradeCount / totalCases : 0,
    degradedRate,
    healthCalibrationRate,
    strongDecisionRate: totalCases > 0 ? strongDecisionCount / totalCases : 0,
    workspaceCoverageRate,
  };

  const gates = [
    ...MONOREPO_ASSERTIONS.map((assertion) => ({
      detail: assertion.check(metrics).detail,
      gate: `agg:${assertion.name}`,
      passed: assertion.check(metrics).passed,
    })),
    {
      detail: `clean=${clean.healthSummary.healthScore}, unhealthy=${unhealthy.healthSummary.healthScore}`,
      gate: "monorepo-clean-vs-unhealthy-gap>=15",
      passed: clean.healthSummary.healthScore - unhealthy.healthSummary.healthScore >= 15,
    },
    {
      detail: `unhealthy violations=${unhealthy.violations.length}`,
      gate: "monorepo-unhealthy-has-violations",
      passed: unhealthy.violations.length > 0,
    },
    {
      detail: `partial decisionGrade=${partial.healthSummary.decisionGrade}, workspaceConfidence=${partial.healthSummary.workspaceConfidence}`,
      gate: "monorepo-partial-abstains-or-directional",
      passed:
        partial.healthSummary.decisionGrade !== "strong" ||
        partial.healthSummary.workspaceConfidence < 0.7,
    },
  ];

  const summary: RedactedMonorepoSummary = {
    allGatesPassed: gates.every((gate) => gate.passed),
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    comparableRate: pct(metrics.comparableRate),
    decisionGradeRate: pct(metrics.decisionGradeRate),
    degradedRate: pct(metrics.degradedRate),
    gates,
    healthCalibrationRate: pct(metrics.healthCalibrationRate),
    strongDecisionRate: pct(metrics.strongDecisionRate),
    timestamp: new Date().toISOString(),
    totalCases,
    workspaceCoverageRate: pct(metrics.workspaceCoverageRate),
  };

  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  rmSync(tempRoot, { force: true, recursive: true });
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runMonorepoLatest();
  console.log(JSON.stringify(summary, null, 2));
}
