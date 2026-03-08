import {
  renderDimensionTable,
  renderExplainability,
  renderJson,
  renderReport,
} from "./utils/format.js";
import type { AnalysisResult } from "./types.js";
import { Command } from "commander";
import { analyzeProject } from "./analyzer.js";
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
}

function outputResult(result: AnalysisResult, opts: OutputOptions) {
  if (opts.color === false) {
    pc.isColorSupported = false;
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
  "utility",
  "general",
] as const;

export function run() {
  const program = new Command();

  program
    .name("typegrade")
    .description("TypeScript type-safety and precision analyzer")
    .version("0.5.0")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--no-color", "Disable colors")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto");

  program
    .command("analyze [path]", { isDefault: true })
    .description("Analyze a local TypeScript project (default: .)")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const result = analyzeProject(projectPath, { domain, explain: Boolean(opts.explain) });
      outputResult(result, opts as OutputOptions);
    });

  program
    .command("score <package>")
    .description("Score an npm package or local package path")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show per-dimension breakdown")
    .option("--explain", "Show explainability report")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .action((pkg: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const domain = parseDomainOption(String(opts.domain ?? "auto"));
      const result = scorePackage(pkg, { domain });
      outputResult(result, opts as OutputOptions);
    });

  program
    .command("compare <pkgA> <pkgB>")
    .description("Compare two packages side-by-side")
    .option("--json", "Output as JSON")
    .option("--domain <domain>", `Domain mode: ${VALID_DOMAINS.join("|")}`, "auto")
    .action((pkgA: string, pkgB: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const domain = parseDomainOption(String(opts.domain ?? "auto"));

      const resultA = scorePackage(pkgA, { domain });
      const resultB = scorePackage(pkgB, { domain });

      if (opts.json) {
        console.log(JSON.stringify({ comparison: { first: resultA, second: resultB } }, null, 2));
      } else {
        console.log(renderComparison({ nameA: pkgA, nameB: pkgB, resultA, resultB }));
      }
    });

  program.parse();
}

function parseDomainOption(value: string): "auto" | "off" | string {
  if (VALID_DOMAINS.includes(value as (typeof VALID_DOMAINS)[number])) {
    return value;
  }
  console.error(`Invalid domain: ${value}. Valid options: ${VALID_DOMAINS.join(", ")}`);
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
