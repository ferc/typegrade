import { Command } from "commander";
import { analyzeProject } from "./analyzer.js";
import { scorePackage } from "./package-scorer.js";
import { renderReport, renderJson, renderDimensionTable } from "./utils/format.js";

function outputResult(
  result: ReturnType<typeof analyzeProject>,
  opts: { json?: boolean; verbose?: boolean; minScore?: number },
) {
  if (opts.json) {
    console.log(renderJson(result));
  } else {
    console.log(renderReport(result));
    if (opts.verbose) {
      console.log(renderDimensionTable(result.dimensions));
    }
  }

  if (typeof opts.minScore === "number" && result.overallScore < opts.minScore) {
    console.error(
      `Score ${result.overallScore} is below minimum ${opts.minScore}`,
    );
    process.exit(1);
  }
}

export function run() {
  const program = new Command();

  program
    .name("tsguard")
    .description("TypeScript type-safety and precision analyzer")
    .version("0.1.0")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-file breakdown")
    .option("--no-color", "Disable colors");

  program
    .command("analyze [path]", { isDefault: true })
    .description("Analyze a local TypeScript project (default: .)")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Exit code 1 if score < n (CI gate)", parseInt)
    .option("--verbose", "Show per-file breakdown")
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
    .option("--verbose", "Show per-file breakdown")
    .action((pkg: string, cmdOpts: Record<string, unknown>) => {
      const parentOpts = program.opts();
      const opts = { ...parentOpts, ...cmdOpts };
      const result = scorePackage(pkg);
      outputResult(result, opts);
    });

  program.parse();
}
