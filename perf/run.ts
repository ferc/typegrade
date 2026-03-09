/**
 * Performance benchmark harness for typegrade.
 *
 * Measures built artifacts directly via Node subprocess spawning.
 * No tsx dependency — runs from the compiled dist/ output.
 *
 * Usage:
 *   pnpm perf:cli       — Measure CLI cold-start for --version and --help
 *   pnpm perf:score     — Measure single project analyze latency (local fixture)
 *   pnpm perf:benchmark — Measure full train benchmark throughput
 *   pnpm perf           — Run all perf benchmarks
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PERF_OUTPUT = join(ROOT, "benchmarks-output", "perf");
const DIST_BIN = join(ROOT, "dist", "bin.js");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "high-precision");
const FIXTURE_BOUNDARY = join(ROOT, "test", "fixtures", "server-router");

interface PerfResult {
  name: string;
  runs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

interface PerfBaseline {
  results: PerfResult[];
  timestamp: string;
  nodeVersion: string;
}

interface PerfReport {
  results: PerfResult[];
  timestamp: string;
  nodeVersion: string;
  comparison?: PerfComparison[];
}

interface PerfComparison {
  name: string;
  currentP50: number;
  baselineP50: number;
  changePercent: number;
  regression: boolean;
  threshold?: number;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((ab, bb) => ab - bb);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(arr: number[], pp: number): number {
  const sorted = [...arr].sort((ab, bb) => ab - bb);
  const idx = Math.ceil((pp / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function runTimed(cmd: string, runs: number, label: string): PerfResult {
  const times: number[] = [];

  // Warmup run (not counted)
  try {
    execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: 60_000 });
  } catch {
    // Commands like --help exit 0, others may take longer
  }

  for (let ii = 0; ii < runs; ii++) {
    const start = performance.now();
    try {
      execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: 120_000 });
    } catch {
      // Score commands may fail on missing packages — we still measure time
    }
    times.push(performance.now() - start);
  }

  return {
    maxMs: Math.round(Math.max(...times)),
    meanMs: Math.round(times.reduce((ab, bb) => ab + bb, 0) / times.length),
    minMs: Math.round(Math.min(...times)),
    name: label,
    p50Ms: Math.round(median(times)),
    p95Ms: Math.round(percentile(times, 95)),
    runs,
  };
}

// Performance target thresholds (p50 in ms)
const THRESHOLDS: Record<string, number> = {
  "analyze-boundaries": 250,
  "analyze-fix-plan": 450,
  "analyze-local-fixture": 450,
  "cli-help": 80,
  "cli-version": 40,
};

function perfVersion(): PerfResult {
  return runTimed(`node ${DIST_BIN} --version`, 10, "cli-version");
}

function perfHelp(): PerfResult {
  return runTimed(`node ${DIST_BIN} --help`, 10, "cli-help");
}

function perfAnalyzeLocal(): PerfResult {
  if (!existsSync(FIXTURE_DIR)) {
    console.error(`Fixture not found: ${FIXTURE_DIR}`);
    process.exit(1);
  }
  return runTimed(`node ${DIST_BIN} analyze ${FIXTURE_DIR} --json`, 5, "analyze-local-fixture");
}

function perfBoundaries(): PerfResult {
  const fixtureDir = existsSync(FIXTURE_BOUNDARY) ? FIXTURE_BOUNDARY : FIXTURE_DIR;
  return runTimed(`node ${DIST_BIN} boundaries ${fixtureDir} --json`, 5, "analyze-boundaries");
}

function perfFixPlan(): PerfResult {
  if (!existsSync(FIXTURE_DIR)) {
    console.error(`Fixture not found: ${FIXTURE_DIR}`);
    process.exit(1);
  }
  return runTimed(`node ${DIST_BIN} fix-plan ${FIXTURE_DIR} --json`, 5, "analyze-fix-plan");
}

function perfBenchmarkTrain(): PerfResult {
  return runTimed("pnpm benchmark:train", 3, "benchmark-train");
}

function formatTable(results: PerfResult[]): string {
  const header =
    "Name                          Runs   Mean    Min     Max     P50     P95     Target";
  const sep = "─".repeat(header.length);
  const rows = results.map((rr) => {
    const threshold = THRESHOLDS[rr.name];
    const targetStr = threshold ? `≤${threshold}ms` : "";
    const hit = threshold ? (rr.p50Ms <= threshold ? " ✓" : " ✗") : "";
    return [
      rr.name.padEnd(30),
      String(rr.runs).padStart(4),
      `${rr.meanMs}ms`.padStart(7),
      `${rr.minMs}ms`.padStart(7),
      `${rr.maxMs}ms`.padStart(7),
      `${rr.p50Ms}ms`.padStart(7),
      `${rr.p95Ms}ms`.padStart(7),
      `${targetStr}${hit}`.padStart(10),
    ].join(" ");
  });
  return [sep, header, sep, ...rows, sep].join("\n");
}

function loadBaseline(): PerfBaseline | null {
  try {
    const files = execSync(`ls -t ${PERF_OUTPUT}/perf-*.json 2>/dev/null`, {
      encoding: "utf8",
      stdio: "pipe",
    })
      .trim()
      .split("\n");
    if (files.length > 0 && files[0]) {
      return JSON.parse(readFileSync(files[0], "utf8")) as PerfBaseline;
    }
  } catch {
    // No baseline available
  }
  return null;
}

function compareWithBaseline(
  results: PerfResult[],
  baseline: PerfBaseline,
): PerfComparison[] {
  const comparisons: PerfComparison[] = [];
  for (const result of results) {
    const baseResult = baseline.results.find((br) => br.name === result.name);
    if (baseResult) {
      const changePercent =
        baseResult.p50Ms === 0 ? 0 : ((result.p50Ms - baseResult.p50Ms) / baseResult.p50Ms) * 100;
      const threshold = THRESHOLDS[result.name];
      comparisons.push({
        baselineP50: baseResult.p50Ms,
        changePercent: Math.round(changePercent * 10) / 10,
        currentP50: result.p50Ms,
        name: result.name,
        regression: changePercent > 20, // >20% regression is flagged
        threshold,
      });
    }
  }
  return comparisons;
}

const mode = process.argv[2] ?? "all";
const isCI = process.argv.includes("--ci");
const results: PerfResult[] = [];

if (mode === "cli" || mode === "all") {
  console.log("Measuring CLI --version...");
  results.push(perfVersion());
  console.log("Measuring CLI --help...");
  results.push(perfHelp());
}

if (mode === "score" || mode === "all") {
  console.log("Measuring local fixture analyze...");
  results.push(perfAnalyzeLocal());
  console.log("Measuring boundaries...");
  results.push(perfBoundaries());
  console.log("Measuring fix-plan...");
  results.push(perfFixPlan());
}

if (mode === "benchmark" || mode === "all") {
  console.log("Measuring full train benchmark...");
  results.push(perfBenchmarkTrain());
}

console.log("\n" + formatTable(results) + "\n");

// Compare with baseline if available
const baseline = loadBaseline();
if (baseline) {
  const comparisons = compareWithBaseline(results, baseline);
  if (comparisons.length > 0) {
    console.log("Comparison with previous baseline:");
    for (const cmp of comparisons) {
      const arrow = cmp.changePercent > 0 ? "↑" : cmp.changePercent < 0 ? "↓" : "=";
      const sign = cmp.changePercent > 0 ? "+" : "";
      const flag = cmp.regression ? " ⚠ REGRESSION" : "";
      console.log(
        `  ${cmp.name.padEnd(30)} ${cmp.baselineP50}ms → ${cmp.currentP50}ms (${arrow} ${sign}${cmp.changePercent}%)${flag}`,
      );
    }
    console.log("");

    // CI mode: fail on regressions or threshold violations
    if (isCI) {
      const regressions = comparisons.filter((cc) => cc.regression);
      const thresholdViolations = results.filter((rr) => {
        const threshold = THRESHOLDS[rr.name];
        return threshold && rr.p50Ms > threshold;
      });

      if (regressions.length > 0) {
        console.error(`ERROR: ${regressions.length} performance regression(s) detected`);
        process.exit(1);
      }
      if (thresholdViolations.length > 0) {
        console.error(
          `ERROR: ${thresholdViolations.length} threshold violation(s): ${thresholdViolations.map((vv) => vv.name).join(", ")}`,
        );
        process.exit(1);
      }
    }
  }
}

// Write results
const report: PerfReport = {
  nodeVersion: process.version,
  results,
  timestamp: new Date().toISOString(),
};
if (baseline) {
  report.comparison = compareWithBaseline(results, baseline);
}

mkdirSync(PERF_OUTPUT, { recursive: true });
const outPath = join(PERF_OUTPUT, `perf-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Results written to ${outPath}`);
