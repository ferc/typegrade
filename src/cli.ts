import { Command } from "commander";
import pc from "picocolors";
import { analyzeProject } from "./analyzer.js";
import { scorePackage } from "./package-scorer.js";
import { renderDimensionTable, renderJson, renderReport } from "./utils/format.js";
import type { AnalysisResult } from "./types.js";

function getAgentReadinessScore(result: AnalysisResult): number {
  const ar = result.composites.find((c) => c.key === "agentReadiness");
  return ar?.score ?? 0;
}

function outputResult(
  result: AnalysisResult,
  opts: { json?: boolean; verbose?: boolean; minScore?: number; color?: boolean },
) {
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
  }

  const score = getAgentReadinessScore(result);
  if (typeof opts.minScore === "number" && score < opts.minScore) {
    console.error(`Score ${score} is below minimum ${opts.minScore}`);
    process.exit(1);
  }
}

export function run() {
  const program = new Command();

  program
    .name("tsguard")
    .description("TypeScript type-safety and precision analyzer")
    .version("0.2.0")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .option("--no-color", "Disable colors");

  program
    .command("analyze [path]", { isDefault: true })
    .description("Analyze a local TypeScript project (default: .)")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-dimension breakdown")
    .action((path: string | undefined, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const projectPath = path ?? ".";
      const result = analyzeProject(projectPath);
      outputResult(result, opts);
    });

  program
    .command("score <package>")
    .description("Score an npm package or local package path")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show per-dimension breakdown")
    .action((pkg: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const result = scorePackage(pkg);
      outputResult(result, opts);
    });

  program.parse();
}
