#!/usr/bin/env tsx
/**
 * Builder tuning loop — automated train-only validation cycle.
 *
 * Runs: build → test → train benchmark → optimizer → train gate
 * Reports a structured summary that AI agents can parse.
 *
 * Quarantine: This script runs ONLY builder-allowed commands.
 * It must NOT invoke eval, judge, pool, or gate:eval.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    return { detail: extractDetail(name, output) || "Failed", durationMs, passed: false, step: name };
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
    const summaryLines = lines.filter((ln) =>
      ln.includes("Must-pass:") || ln.includes("Hard-diagnostic:") || ln.includes("Diagnostic:") || ln.includes("Scenario assertions:"),
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
  return output.slice(0, 200);
}

function main() {
  console.log("=== typegrade Builder Tuning Loop ===\n");
  console.log("Running: build → test → train benchmark → optimizer → train gate\n");

  const steps: StepResult[] = [];

  // Step 1: Build
  console.log("[1/5] Building...");
  const buildResult = runStep("build", "pnpm build");
  steps.push(buildResult);
  console.log(`  ${buildResult.passed ? "OK" : "FAIL"}: ${buildResult.detail} (${(buildResult.durationMs / 1000).toFixed(1)}s)`);
  if (!buildResult.passed) {
    console.log("\nBuild failed — stopping tuning loop.");
    writeSummary(steps);
    process.exit(1);
  }

  // Step 2: Test
  console.log("[2/5] Running tests...");
  const testResult = runStep("test", "pnpm test:run");
  steps.push(testResult);
  console.log(`  ${testResult.passed ? "OK" : "FAIL"}: ${testResult.detail} (${(testResult.durationMs / 1000).toFixed(1)}s)`);
  if (!testResult.passed) {
    console.log("\nTests failed — stopping tuning loop.");
    writeSummary(steps);
    process.exit(1);
  }

  // Step 3: Train benchmark
  console.log("[3/5] Running train benchmark...");
  const benchResult = runStep("benchmark:train", "pnpm benchmark:train", 600_000);
  steps.push(benchResult);
  console.log(`  ${benchResult.passed ? "OK" : "FAIL"}: ${benchResult.detail} (${(benchResult.durationMs / 1000).toFixed(1)}s)`);

  // Step 4: Optimizer (run even if benchmark had issues)
  console.log("[4/5] Running optimizer...");
  const optResult = runStep("optimize", "pnpm benchmark:optimize");
  steps.push(optResult);
  console.log(`  ${optResult.passed ? "OK" : "FAIL"}: ${optResult.detail} (${(optResult.durationMs / 1000).toFixed(1)}s)`);

  // Step 5: Train gate
  console.log("[5/5] Running train gate...");
  const gateResult = runStep("gate:train", "pnpm gate:train");
  steps.push(gateResult);
  console.log(`  ${gateResult.passed ? "OK" : "FAIL"}: ${gateResult.detail} (${(gateResult.durationMs / 1000).toFixed(1)}s)`);

  // Summary
  const allPassed = steps.every((ss) => ss.passed);
  const totalMs = steps.reduce((sum, ss) => sum + ss.durationMs, 0);

  console.log("\n=== Tuning Loop Summary ===\n");
  for (const step of steps) {
    const icon = step.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${step.step.padEnd(20)} ${step.detail}`);
  }
  console.log(`\n  ${steps.filter((ss) => ss.passed).length}/${steps.length} steps passed (${(totalMs / 1000).toFixed(1)}s total)`);

  if (allPassed) {
    console.log("\n  All clear — changes are train-safe.");
  } else {
    console.log("\n  Issues detected — review failures above.");
  }

  writeSummary(steps);

  if (!allPassed) {
    process.exit(1);
  }
}

function writeSummary(steps: StepResult[]): void {
  const outputDir = join(import.meta.dirname, "..", "benchmarks-output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const report = {
    allPassed: steps.every((ss) => ss.passed),
    steps,
    timestamp: new Date().toISOString(),
    totalDurationMs: steps.reduce((sum, ss) => sum + ss.durationMs, 0),
  };

  writeFileSync(join(outputDir, "tune-report.json"), JSON.stringify(report, null, 2));
}

main();
