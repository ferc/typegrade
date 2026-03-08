#!/usr/bin/env tsx
/**
 * Builder tuning loop — automated train-only validation cycle.
 *
 * Runs: build → test → train benchmark → optimizer → train gate → verify
 * Reports a structured summary that AI agents can parse.
 *
 * Usage:
 *   tsx benchmarks/tune.ts [--subsystem <name>]
 *
 * Valid subsystems:
 *   coverage-truth, domain-taxonomy, scenario-packs,
 *   scorer-calibration, optimizer, benchmark-governance, general (default)
 *
 * Quarantine: This script runs ONLY builder-allowed commands.
 * It must NOT invoke eval, judge, pool, or gate:eval.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VALID_SUBSYSTEMS = [
  "coverage-truth",
  "domain-taxonomy",
  "scenario-packs",
  "scorer-calibration",
  "optimizer",
  "benchmark-governance",
  "general",
] as const;

type Subsystem = (typeof VALID_SUBSYSTEMS)[number];

interface StepResult {
  step: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

function runStep(name: string, cmd: string, timeoutMs = 300_000): StepResult {
  const start = performance.now();
  const cwd = join(import.meta.dirname, "..");
  try {
    const output = execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe", timeout: timeoutMs });
    const durationMs = Math.round(performance.now() - start);
    return { detail: extractDetail(name, output), durationMs, passed: true, step: name };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; stdout?: string };
    const output = err.stdout ?? err.stderr ?? "";
    const durationMs = Math.round(performance.now() - start);
    return {
      detail: extractDetail(name, output) || "Failed",
      durationMs,
      passed: false,
      step: name,
    };
  }
}

function extractDetail(step: string, output: string): string {
  if (step === "build") {
    return output.includes("Build success") ? "Build succeeded" : "Build output available";
  }
  if (step === "test") {
    const passMatch = output.match(/(\d+) passed/);
    const failMatch = output.match(/(\d+) failed/);
    if (failMatch) {
      return `${failMatch[1]} test(s) failed`;
    }
    return passMatch ? `${passMatch[1]} tests passed` : "Tests completed";
  }
  if (step === "benchmark:train") {
    const lines = output.split("\n");
    const summaryLines = lines.filter(
      (ln) =>
        ln.includes("Must-pass:") ||
        ln.includes("Hard-diagnostic:") ||
        ln.includes("Diagnostic:") ||
        ln.includes("Scenario assertions:"),
    );
    return summaryLines.map((ln) => ln.trim()).join("; ") || "Benchmark completed";
  }
  if (step === "optimize") {
    if (output.includes("already optimal")) {
      return "Weights already optimal";
    }
    if (output.includes("Improved")) {
      return "Improved weights found — review optimizer output";
    }
    return "Optimizer completed";
  }
  if (step === "gate:train") {
    const gateMatch = output.match(/(\d+)\/(\d+) gates passed/);
    return gateMatch ? `${gateMatch[1]}/${gateMatch[2]} gates passed` : "Gate check completed";
  }
  if (step === "verify") {
    const lines = output.split("\n");
    const summaryLines = lines.filter(
      (ln) =>
        ln.includes("Must-pass:") ||
        ln.includes("Hard-diagnostic:") ||
        ln.includes("Diagnostic:") ||
        ln.includes("Scenario assertions:"),
    );
    return summaryLines.length > 0
      ? `Verified: ${summaryLines.map((ln) => ln.trim()).join("; ")}`
      : "Post-optimizer verification completed";
  }
  return output.slice(0, 200);
}

function parseSubsystem(): Subsystem {
  const cliArgs = process.argv.slice(2);
  const idx = cliArgs.indexOf("--subsystem");
  if (idx < 0) {
    return "general";
  }
  const value = cliArgs[idx + 1];
  if (!value || !VALID_SUBSYSTEMS.includes(value as Subsystem)) {
    const validList = VALID_SUBSYSTEMS.join(", ");
    console.error(`Invalid subsystem: "${value ?? ""}". Valid values: ${validList}`);
    process.exit(1);
  }
  return value as Subsystem;
}

function logStep(result: StepResult): void {
  const status = result.passed ? "OK" : "FAIL";
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(`  ${status}: ${result.detail} (${seconds}s)`);
}

function main() {
  const subsystem = parseSubsystem();

  console.log("=== typegrade Builder Tuning Loop ===\n");
  console.log(`Subsystem: ${subsystem}`);
  console.log("Running: build → test → train benchmark → optimizer → train gate → verify\n");

  const steps: StepResult[] = [];

  // Step 1: Build
  console.log("[1/6] Building...");
  const buildResult = runStep("build", "pnpm build");
  steps.push(buildResult);
  logStep(buildResult);
  if (!buildResult.passed) {
    console.log("\nBuild failed — stopping tuning loop.");
    writeSummary(steps, subsystem);
    process.exit(1);
  }

  // Step 2: Test
  console.log("[2/6] Running tests...");
  const testResult = runStep("test", "pnpm test:run");
  steps.push(testResult);
  logStep(testResult);
  if (!testResult.passed) {
    console.log("\nTests failed — stopping tuning loop.");
    writeSummary(steps, subsystem);
    process.exit(1);
  }

  // Step 3: Train benchmark
  console.log("[3/6] Running train benchmark...");
  const benchResult = runStep("benchmark:train", "pnpm benchmark:train", 600_000);
  steps.push(benchResult);
  logStep(benchResult);

  // Step 4: Optimizer (run even if benchmark had issues)
  console.log("[4/6] Running optimizer...");
  const optResult = runStep("optimize", "pnpm benchmark:optimize");
  steps.push(optResult);
  logStep(optResult);

  // Step 5: Train gate
  console.log("[5/6] Running train gate...");
  const gateResult = runStep("gate:train", "pnpm gate:train");
  steps.push(gateResult);
  logStep(gateResult);

  // Step 6: Verify — re-run train benchmark if optimizer found improvements
  const optimizerImproved = optResult.passed && optResult.detail.includes("Improved");
  if (optimizerImproved) {
    console.log("[6/6] Verifying — optimizer found improvements, re-running train benchmark...");
    const verifyResult = runStep("verify", "pnpm benchmark:train", 600_000);
    steps.push(verifyResult);
    logStep(verifyResult);
  } else {
    console.log("[6/6] Verify — skipped (no optimizer improvements detected)");
  }

  // Summary
  const allPassed = steps.every((ss) => ss.passed);
  const totalMs = steps.reduce((sum, ss) => sum + ss.durationMs, 0);

  console.log("\n=== Tuning Loop Summary ===\n");
  console.log(`  Subsystem: ${subsystem}`);
  for (const step of steps) {
    const icon = step.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${step.step.padEnd(20)} ${step.detail}`);
  }
  console.log(
    `\n  ${steps.filter((ss) => ss.passed).length}/${steps.length} steps passed (${(totalMs / 1000).toFixed(1)}s total)`,
  );

  if (allPassed) {
    console.log("\n  All clear — changes are train-safe.");
  } else {
    console.log("\n  Issues detected — review failures above.");
  }

  writeSummary(steps, subsystem);

  if (!allPassed) {
    process.exit(1);
  }
}

function writeSummary(steps: StepResult[], subsystem: Subsystem): void {
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const report = {
    allPassed: steps.every((ss) => ss.passed),
    steps,
    subsystem,
    timestamp: new Date().toISOString(),
    totalDurationMs: steps.reduce((sum, ss) => sum + ss.durationMs, 0),
  };

  writeFileSync(join(outputDir, "tune-report.json"), JSON.stringify(report, null, 2));
}

main();
