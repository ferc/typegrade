import type {
  AnalysisProfile,
  AnalysisResult,
  FixApplicationResult,
  FixMode,
  FixPlan,
} from "./types.js";
import { buildAgentReport as buildAgentReportFromResult, renderAgentJson } from "./agent/index.js";
import { computeDiff, renderDiffReport } from "./diff.js";
import {
  renderDimensionTable,
  renderExplainability,
  renderJson,
  renderReport,
} from "./utils/format.js";
import type { AgentReport } from "./agent/types.js";
import { Command } from "commander";
import type { DomainType } from "./domain.js";
import { analyzeProject } from "./analyzer.js";
import { applyFixes } from "./fix/applier.js";
import { buildFixPlan } from "./fix/planner.js";
import pc from "picocolors";
import { scorePackage } from "./package-scorer.js";

function getAgentReadinessScore(result: AnalysisResult): number {
  const ar = result.composites.find((comp) => comp.key === "agentReadiness");
  return ar?.score ?? 0;
}

interface OutputOptions {
  json?: boolean;
  verbose?: boolean;
  explain?: boolean;
  minScore?: number;
  color?: boolean;
  domain?: string;
  profile?: string;
  agent?: boolean;
}

function toOutputOptions(opts: Record<string, unknown>): OutputOptions {
  return {
    agent: Boolean(opts.agent),
    color: typeof opts.color === "boolean" ? opts.color : undefined,
    domain: typeof opts.domain === "string" ? opts.domain : undefined,
    explain: Boolean(opts.explain),
    json: Boolean(opts.json),
    minScore: typeof opts.minScore === "number" ? opts.minScore : undefined,
    profile: typeof opts.profile === "string" ? opts.profile : undefined,
    verbose: Boolean(opts.verbose),
  };
}

function outputResult(result: AnalysisResult, opts: OutputOptions) {
  if (opts.color === false) {
    pc.isColorSupported = false;
  }

  // Agent mode: emit agent-specific JSON
  if (opts.agent && result.autofixSummary) {
    console.log(renderAgentJson(buildAgentReportFromResult(result)));
    return;
  }

  if (opts.json) {
    console.log(renderJson(result));
  } else {
    console.log(renderReport(result));
    if (opts.verbose) {
      console.log(renderDimensionTable(result.dimensions));
    }
    if (opts.explain) {
      console.log(renderExplainability(result));
    }
  }

  const score = getAgentReadinessScore(result);
  if (typeof opts.minScore === "number" && score < opts.minScore) {
    console.error(`Score ${score} is below minimum ${opts.minScore}`);
    process.exit(1);
  }
}

const VALID_DOMAINS = [
  "auto",
  "off",
  "validation",
  "router",
  "orm",
  "result",
  "schema",
  "stream",
  "state",
  "testing",
  "cli",
  "frontend",
  "utility",
  "general",
] as const;

const VALID_PROFILES = ["library", "package", "application", "autofix-agent"] as const;

export function runCli() {
  const program = new Command();

  program
    .name("typegrade")
    .description("TypeScript type-safety and precision analyzer")
    .version(__TYPEGRADE_VERSION__)
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--no-color", "Disable colors")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .option("--profile <profile>", `Analysis profile: ${VALID_PROFILES.join("|")}`)
    .option("--agent", "Agent-optimized output (precision-first, fix batches)");

  program
    .command("analyze [path]", { isDefault: true })
    .description("Analyze a local TypeScript project (default: .)")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .option("--profile <profile>", `Analysis profile: ${VALID_PROFILES.join("|")}`)
    .option("--agent", "Agent-optimized output (precision-first, fix batches)")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const profile = opts.profile ? parseProfileOption(String(opts.profile)) : undefined;
      const agent = Boolean(opts.agent);
      const result = analyzeProject(projectPath, {
        agent,
        domain,
        explain: Boolean(opts.explain),
        profile,
      });
      outputResult(result, toOutputOptions(opts));
    });

  program
    .command("score <package>")
    .description("Score an npm package or local package path")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .option("--no-cache", "Disable package cache (always install fresh)")
    .action((pkg: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const noCache = opts.cache === false;
      const result = scorePackage(pkg, { domain, noCache });
      outputResult(result, toOutputOptions(opts));
    });

  program
    .command("self-analyze [path]")
    .description("Analyze and suggest improvements (closed-loop self-improvement)")
    .option("--json", "Output as JSON")
    .option("--apply", "Apply safe fixes automatically (dry-run by default)")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const result = analyzeProject(projectPath, {
        agent: true,
        explain: true,
        profile: "autofix-agent",
      });
      const agentReport = buildAgentReportFromResult(result);

      if (opts.json) {
        console.log(renderAgentJson(agentReport));
      } else {
        console.log(renderSelfAnalysis(result, agentReport, Boolean(opts.apply)));
      }
    });

  program
    .command("compare <pkgA> <pkgB>")
    .description("Compare two packages side-by-side")
    .option("--json", "Output as JSON")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .option("--no-cache", "Disable package cache (always install fresh)")
    .action((pkgA: string, pkgB: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const noCache = opts.cache === false;

      const resultA = scorePackage(pkgA, { domain, noCache });
      const resultB = scorePackage(pkgB, { domain, noCache });

      if (opts.json) {
        console.log(JSON.stringify({ comparison: { first: resultA, second: resultB } }, null, 2));
      } else {
        console.log(renderComparison({ nameA: pkgA, nameB: pkgB, resultA, resultB }));
      }
    });

  program
    .command("boundaries [path]")
    .description("Analyze boundary trust and validation coverage")
    .option("--json", "Output as JSON")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const result = analyzeProject(projectPath, {
        agent: false,
        explain: false,
        profile: "application",
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              boundaryQuality: result.boundaryQuality,
              boundarySummary: result.boundarySummary,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(renderBoundaryReport(result));
      }
    });

  program
    .command("fix-plan [path]")
    .description("Generate a fix plan for improving type quality")
    .option("--json", "Output as JSON")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const result = analyzeProject(projectPath, {
        agent: true,
        explain: true,
        profile: "autofix-agent",
      });
      const plan = buildFixPlan(result);
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(renderFixPlanReport(plan));
      }
    });

  program
    .command("apply-fixes [path]")
    .description("Apply safe fixes from a fix plan")
    .option("--mode <mode>", "Fix mode: safe|review", "safe")
    .option("--json", "Output as JSON")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const mode = (opts.mode === "review" ? "review" : "safe") as FixMode;
      const result = analyzeProject(projectPath, {
        agent: true,
        explain: true,
        profile: "autofix-agent",
      });
      const plan = buildFixPlan(result);
      const applicationResult = applyFixes({ mode, plan, projectPath });
      if (opts.json) {
        console.log(JSON.stringify(applicationResult, null, 2));
      } else {
        console.log(renderApplyFixesReport(applicationResult));
      }
    });

  program
    .command("diff <baseline> <target>")
    .description("Compare two analysis snapshots or packages")
    .option("--json", "Output as JSON")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .option("--no-cache", "Disable package cache")
    .action((baseline: string, target: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const noCache = opts.cache === false;
      const baselineResult = scorePackage(baseline, { domain, noCache });
      const targetResult = scorePackage(target, { domain, noCache });
      const diff = computeDiff({ baseline: baselineResult, target: targetResult });
      if (opts.json) {
        console.log(JSON.stringify(diff, null, 2));
      } else {
        console.log(renderDiffReport(diff));
      }
    });

  program.parse();
}

function parseDomainOption(value: string): "auto" | "off" | DomainType {
  if (VALID_DOMAINS.includes(value as (typeof VALID_DOMAINS)[number])) {
    return value as "auto" | "off" | DomainType;
  }
  console.error(`Invalid domain: ${value}. Valid options: ${VALID_DOMAINS.join(", ")}`);
  process.exit(1);
}

function parseProfileOption(value: string): AnalysisProfile {
  if (VALID_PROFILES.includes(value as (typeof VALID_PROFILES)[number])) {
    return value as AnalysisProfile;
  }
  console.error(`Invalid profile: ${value}. Valid options: ${VALID_PROFILES.join(", ")}`);
  process.exit(1);
}

interface ComparisonOpts {
  nameA: string;
  resultA: AnalysisResult;
  nameB: string;
  resultB: AnalysisResult;
}

function renderComparison(opts: ComparisonOpts): string {
  const { nameA, resultA, nameB, resultB } = opts;
  const lines: string[] = [
    "",
    pc.bold("  typegrade comparison"),
    "",
    `  ${"".padEnd(22)}${nameA.padEnd(16)}${nameB.padEnd(16)}${"Delta"}`,
    `  ${"─".repeat(60)}`,
  ];

  const compositeKeys = ["consumerApi", "agentReadiness", "typeSafety"] as const;
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    consumerApi: "Consumer API",
    typeSafety: "Type Safety",
  };

  for (const key of compositeKeys) {
    const scoreA = resultA.composites.find((comp) => comp.key === key)?.score ?? 0;
    const scoreB = resultB.composites.find((comp) => comp.key === key)?.score ?? 0;
    const delta = scoreA - scoreB;
    let deltaStr = "0";
    if (delta > 0) {
      deltaStr = pc.green(`+${delta}`);
    } else if (delta < 0) {
      deltaStr = pc.red(`${delta}`);
    }
    const label = (labels[key] ?? key).padEnd(22);
    lines.push(`  ${label}${String(scoreA).padEnd(16)}${String(scoreB).padEnd(16)}${deltaStr}`);
  }

  // Domain scores if available
  if (resultA.domainScore || resultB.domainScore) {
    lines.push("");
    const domA = resultA.domainScore?.score ?? "n/a";
    const domB = resultB.domainScore?.score ?? "n/a";
    const domainLabel =
      `Domain Fit (${resultA.domainScore?.domain ?? resultB.domainScore?.domain ?? "?"})`.padEnd(
        22,
      );
    lines.push(`  ${domainLabel}${String(domA).padEnd(16)}${String(domB).padEnd(16)}`);
  }

  lines.push("");
  return lines.join("\n");
}

function scoreToColor(score: number): (str: string) => string {
  if (score >= 80) {
    return pc.green;
  }
  if (score >= 60) {
    return pc.yellow;
  }
  return pc.red;
}

function riskToColorFn(risk: string): (str: string) => string {
  if (risk === "low") {
    return pc.green;
  }
  if (risk === "medium") {
    return pc.yellow;
  }
  return pc.red;
}

function renderSelfAnalysis(
  result: AnalysisResult,
  report: AgentReport,
  applyMode: boolean,
): string {
  const lines: string[] = [
    "",
    pc.bold("  typegrade self-analyze"),
    "",
    pc.bold("  Current Scores:"),
  ];
  for (const comp of result.composites) {
    if (comp.score === null) {
      continue;
    }
    const gc = scoreToColor(comp.score);
    lines.push(`    ${comp.key.padEnd(24)}${gc(`${comp.score}/100 (${comp.grade})`)}`);
  }
  lines.push("");

  // Actionable findings
  lines.push(pc.bold("  Actionable Findings:"));
  lines.push(`    Total issues: ${report.actionableIssues.length}`);
  lines.push(`    Suppressed: ${report.suppressedCount}`);
  lines.push(`    Expected improvement: +${report.expectedScoreImprovement} points`);
  lines.push("");

  // Fix batches
  if (report.fixBatches.length > 0) {
    lines.push(pc.bold("  Fix Batches (ordered by impact):"));
    for (const batch of report.fixBatches.slice(0, 8)) {
      const riskColor = riskToColorFn(batch.risk);
      const reviewTag = batch.requiresHumanReview ? pc.dim(" [needs review]") : "";
      lines.push(
        `    ${riskColor(`[${batch.risk}]`)} ${batch.title} (impact: ${batch.expectedImpact})${reviewTag}`,
      );
    }
    lines.push("");
  }

  // Suppression breakdown
  if (report.suppressionReasons.length > 0) {
    lines.push(pc.bold("  Suppression Breakdown:"));
    for (const reason of report.suppressionReasons) {
      lines.push(`    ${reason.category}: ${reason.count}`);
    }
    lines.push("");
  }

  // Apply mode status
  if (applyMode) {
    lines.push(pc.yellow("  --apply is not yet implemented. Use fix batches for manual fixes."));
  } else {
    lines.push(pc.dim("  Run with --apply to auto-fix safe issues (not yet implemented)."));
  }
  lines.push("");

  return lines.join("\n");
}

function renderBoundaryReport(result: AnalysisResult): string {
  const lines: string[] = ["", pc.bold("  typegrade boundaries"), ""];

  const summary = result.boundarySummary;
  const quality = result.boundaryQuality;

  if (!summary || !quality) {
    lines.push("  No boundary data available. Run on a source project (not a package).");
    lines.push("");
    return lines.join("\n");
  }

  // Quality overview
  const gradeColor = scoreToColor(quality.score);
  lines.push(pc.bold("  Boundary Quality:"));
  lines.push(`    Score: ${gradeColor(`${quality.score}/100 (${quality.grade})`)}`);
  lines.push(`    Total boundaries: ${summary.totalBoundaries}`);
  lines.push(`    Validated: ${summary.validatedBoundaries}`);
  lines.push(`    Unvalidated: ${summary.unvalidatedBoundaries}`);
  lines.push(`    Coverage: ${Math.round(summary.boundaryCoverage * 100)}%`);
  lines.push("");

  // Hotspots
  if (summary.missingValidationHotspots.length > 0) {
    lines.push(pc.bold("  Missing Validation Hotspots:"));
    for (const hotspot of summary.missingValidationHotspots.slice(0, 10)) {
      const trustColor = hotspot.trustLevel === "untrusted-external" ? pc.red : pc.yellow;
      lines.push(
        `    ${trustColor(`[${hotspot.trustLevel}]`)} ${hotspot.file}:${hotspot.line} (${hotspot.boundaryType})`,
      );
    }
    if (summary.missingValidationHotspots.length > 10) {
      lines.push(pc.dim(`    ... and ${summary.missingValidationHotspots.length - 10} more`));
    }
    lines.push("");
  }

  // Taint breaks
  if (summary.taintBreaks.length > 0) {
    lines.push(pc.bold("  Taint Breaks (unvalidated data flows):"));
    for (const tb of summary.taintBreaks.slice(0, 5)) {
      lines.push(`    ${pc.red("✗")} ${tb.file}:${tb.line} — ${tb.source} → ${tb.sink}`);
    }
    lines.push("");
  }

  // Rationale
  if (quality.rationale.length > 0) {
    lines.push(pc.bold("  Scoring Rationale:"));
    for (const reason of quality.rationale) {
      lines.push(`    ${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderFixPlanReport(plan: FixPlan): string {
  const lines: string[] = ["", pc.bold("  typegrade fix-plan"), ""];

  if (plan.batches.length === 0) {
    lines.push("  No actionable fixes found.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(pc.bold("  Summary:"));
  lines.push(`    Total batches: ${plan.batches.length}`);
  lines.push(`    Expected uplift: +${plan.totalExpectedUplift} points`);
  lines.push(`    Schema version: ${plan.analysisSchemaVersion}`);
  lines.push("");

  lines.push(pc.bold("  Fix Batches (ordered by dependency + impact):"));
  for (const batch of plan.batches.slice(0, 12)) {
    const riskColor = riskToColorFn(batch.risk);
    const categoryTag = batch.fixCategory ? pc.dim(` [${batch.fixCategory}]`) : "";
    const confidenceTag = pc.dim(` (confidence: ${Math.round(batch.confidence * 100)}%)`);
    lines.push(`    ${riskColor(`[${batch.risk}]`)} ${batch.title}${categoryTag}${confidenceTag}`);
    lines.push(`      Uplift: +${batch.expectedScoreUplift} | Files: ${batch.targetFiles.length}`);
    if (batch.dependsOn.length > 0) {
      lines.push(`      Depends on: ${batch.dependsOn.join(", ")}`);
    }
  }
  if (plan.batches.length > 12) {
    lines.push(pc.dim(`    ... and ${plan.batches.length - 12} more batches`));
  }
  lines.push("");

  // Verification
  if (plan.verificationCommands.length > 0) {
    lines.push(pc.bold("  Verification Commands:"));
    for (const cmd of plan.verificationCommands) {
      lines.push(`    $ ${cmd}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderApplyFixesReport(appResult: FixApplicationResult): string {
  const lines: string[] = ["", pc.bold("  typegrade apply-fixes"), ""];

  if (appResult.applied.length === 0 && appResult.skipped.length === 0) {
    lines.push("  No fixes to apply.");
    lines.push("");
    return lines.join("\n");
  }

  if (appResult.applied.length > 0) {
    lines.push(pc.bold("  Applied:"));
    for (const fix of appResult.applied) {
      lines.push(
        `    ${pc.green("✓")} ${fix.batchId} — ${fix.filesModified.length} file(s) modified`,
      );
    }
    lines.push("");
  }

  if (appResult.skipped.length > 0) {
    lines.push(pc.bold("  Skipped:"));
    for (const skip of appResult.skipped) {
      lines.push(`    ${pc.yellow("○")} ${skip.batchId} — ${skip.reason}`);
    }
    lines.push("");
  }

  lines.push(pc.bold("  Result:"));
  lines.push(`    Score before: ${appResult.scoreBefore}`);
  lines.push(
    `    Score after: ${appResult.scoreAfter === null ? "re-analysis needed" : String(appResult.scoreAfter)}`,
  );
  lines.push(
    `    Verification: ${appResult.verificationPassed ? pc.green("passed") : pc.yellow("pending")}`,
  );
  lines.push("");

  return lines.join("\n");
}
