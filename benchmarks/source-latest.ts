import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeProject } from "../src/analyzer.js";
import { buildAgentReport } from "../src/agent/index.js";
import { ANALYSIS_SCHEMA_VERSION } from "../src/types.js";
import type { AnalysisProfile } from "../src/types.js";
import type { RedactedSourceSummary } from "./types.js";
import { SOURCE_ASSERTIONS } from "./types.js";

interface SourceBenchmarkCase {
  name: string;
  path: string;
  profile: AnalysisProfile;
}

const projectRoot = join(import.meta.dirname, "..");
const outputPath = join(projectRoot, "benchmarks-output", "source-summary.json");

const CASES: SourceBenchmarkCase[] = [
  { name: "self", path: projectRoot, profile: "library" },
  { name: "healthy-precision", path: join(projectRoot, "test/fixtures/high-precision"), profile: "library" },
  { name: "validation-style", path: join(projectRoot, "test/fixtures/validation-style"), profile: "library" },
  { name: "application-light", path: join(projectRoot, "test/fixtures/no-boundaries"), profile: "application" },
];

function pct(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ensureOutputDir(): void {
  const dir = join(projectRoot, "benchmarks-output");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function runSourceLatest(): Promise<RedactedSourceSummary> {
  ensureOutputDir();

  let degraded = 0;
  let comparable = 0;
  let decisionGrade = 0;
  let strong = 0;
  let coherentAutofix = 0;
  let totalIssues = 0;
  let ownedIssues = 0;
  let casesWithActionables = 0;
  let casesWithFixBatches = 0;
  let selfSummary: RedactedSourceSummary["selfAnalysis"] = {
    decisionGrade: null,
    scoreValidity: null,
    status: null,
    withFixBatches: false,
  };

  for (const benchmarkCase of CASES) {
    const result = analyzeProject(resolve(benchmarkCase.path), {
      agent: true,
      profile: benchmarkCase.profile,
    });
    const report = buildAgentReport(result);

    if (result.status === "degraded") {
      degraded++;
    }
    if (result.scoreValidity !== "not-comparable") {
      comparable++;
    }
    if (result.decisionGrade !== "abstain") {
      decisionGrade++;
    }
    if (result.decisionGrade === "strong") {
      strong++;
    }

    const coherent =
      report.fixBatches.length > 0 ||
      Boolean(report.abstentionReason) ||
      report.stopConditions.length > 0;
    if (coherent) {
      coherentAutofix++;
    }

    const ownedTopIssues = result.topIssues.filter(
      (issue) => issue.ownership === "source-owned" || issue.ownership === "workspace-owned",
    ).length;
    totalIssues += result.topIssues.length;
    ownedIssues += ownedTopIssues;

    if (report.actionableIssues.length > 0) {
      casesWithActionables++;
    }
    if (report.fixBatches.length > 0) {
      casesWithFixBatches++;
    }

    if (benchmarkCase.name === "self") {
      selfSummary = {
        decisionGrade: result.decisionGrade ?? null,
        scoreValidity: result.scoreValidity ?? null,
        status: result.status ?? null,
        withFixBatches: report.fixBatches.length > 0,
      };
    }
  }

  const totalCases = CASES.length;
  const metrics = {
    autofixCoherenceRate: totalCases > 0 ? coherentAutofix / totalCases : 0,
    comparableRate: totalCases > 0 ? comparable / totalCases : 0,
    decisionGradeRate: totalCases > 0 ? decisionGrade / totalCases : 0,
    degradedRate: totalCases > 0 ? degraded / totalCases : 0,
    directFixBatchRate: casesWithActionables > 0 ? casesWithFixBatches / casesWithActionables : 1,
    sourceOwnedIssueRate: totalIssues > 0 ? ownedIssues / totalIssues : 1,
    strongDecisionRate: totalCases > 0 ? strong / totalCases : 0,
  };

  const gates = [
    {
      detail:
        selfSummary.status === "degraded"
          ? `self degraded with scoreValidity=${selfSummary.scoreValidity}`
          : `self status=${selfSummary.status}, decisionGrade=${selfSummary.decisionGrade}`,
      gate: "source-self-analysis-decision-grade",
      passed:
        selfSummary.status !== "invalid-input" &&
        selfSummary.status !== "unsupported-package" &&
        !(
          selfSummary.status === "degraded" &&
          selfSummary.scoreValidity !== "not-comparable"
        ),
    },
    ...SOURCE_ASSERTIONS.map((assertion) => ({
      detail: assertion.check(metrics).detail,
      gate: `agg:${assertion.name}`,
      passed: assertion.check(metrics).passed,
    })),
    {
      detail: `${(metrics.directFixBatchRate * 100).toFixed(1)}% of actionable cases produced fix batches`,
      gate: "source-direct-fix-batch-rate>25%",
      passed: metrics.directFixBatchRate >= 0.25,
    },
    {
      detail: `${(metrics.sourceOwnedIssueRate * 100).toFixed(1)}% of top issues were source/workspace-owned`,
      gate: "source-owned-issue-rate>50%",
      passed: metrics.sourceOwnedIssueRate >= 0.5,
    },
  ];

  const summary: RedactedSourceSummary = {
    allGatesPassed: gates.every((gate) => gate.passed),
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    autofixCoherenceRate: pct(metrics.autofixCoherenceRate),
    comparableRate: pct(metrics.comparableRate),
    decisionGradeRate: pct(metrics.decisionGradeRate),
    degradedRate: pct(metrics.degradedRate),
    directFixBatchRate: pct(metrics.directFixBatchRate),
    gates,
    selfAnalysis: selfSummary,
    sourceOwnedIssueRate: pct(metrics.sourceOwnedIssueRate),
    strongDecisionRate: pct(metrics.strongDecisionRate),
    timestamp: new Date().toISOString(),
    totalCases,
  };

  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSourceLatest();
  console.log(JSON.stringify(summary, null, 2));
}
