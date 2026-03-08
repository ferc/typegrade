/**
 * Performance benchmark harness for typegrade.
 *
 * Usage:
 *   pnpm perf:cli       — Measure CLI cold-start for --help
 *   pnpm perf:score     — Measure single package score latency (local fixture)
 *   pnpm perf:benchmark — Measure full train benchmark throughput
 *   pnpm perf           — Run all perf benchmarks
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PERF_OUTPUT = join(ROOT, "benchmarks-output", "perf");
const DIST_BIN = join(ROOT, "dist", "bin.js");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "high-precision");

interface PerfResult {
  name: string;
  runs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function runTimed(cmd: string, runs: number, label: string): PerfResult {
  const times: number[] = [];

  // Warmup run (not counted)
  try {
    execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: 60_000 });
  } catch {
    // --help exits 0, score may take longer
  }

  for (let i = 0; i < runs; i++) {
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
    meanMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    minMs: Math.round(Math.min(...times)),
    name: label,
    p50Ms: Math.round(median(times)),
    p95Ms: Math.round(percentile(times, 95)),
    runs,
  };
}

function perfCli(): PerfResult {
  return runTimed(`node ${DIST_BIN} --help`, 10, "cli-help");
}

function perfScoreLocal(): PerfResult {
  if (!existsSync(FIXTURE_DIR)) {
    console.error(`Fixture not found: ${FIXTURE_DIR}`);
    process.exit(1);
  }
  return runTimed(`node ${DIST_BIN} analyze ${FIXTURE_DIR} --json`, 5, "analyze-local-fixture");
}

function perfBenchmarkTrain(): PerfResult {
  return runTimed("pnpm benchmark:train", 3, "benchmark-train");
}

function formatTable(results: PerfResult[]): string {
  const header = "Name                      Runs   Mean    Min     Max     P50     P95";
  const sep = "─".repeat(header.length);
  const rows = results.map((r) =>
    [
      r.name.padEnd(26),
      String(r.runs).padStart(4),
      `${r.meanMs}ms`.padStart(7),
      `${r.minMs}ms`.padStart(7),
      `${r.maxMs}ms`.padStart(7),
      `${r.p50Ms}ms`.padStart(7),
      `${r.p95Ms}ms`.padStart(7),
    ].join(" "),
  );
  return [sep, header, sep, ...rows, sep].join("\n");
}

const mode = process.argv[2] ?? "all";
const results: PerfResult[] = [];

if (mode === "cli" || mode === "all") {
  console.log("Measuring CLI cold-start...");
  results.push(perfCli());
}

if (mode === "score" || mode === "all") {
  console.log("Measuring local fixture analyze...");
  results.push(perfScoreLocal());
}

if (mode === "benchmark" || mode === "all") {
  console.log("Measuring full train benchmark...");
  results.push(perfBenchmarkTrain());
}

console.log("\n" + formatTable(results) + "\n");

// Write results
mkdirSync(PERF_OUTPUT, { recursive: true });
const outPath = join(PERF_OUTPUT, `perf-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
console.log(`Results written to ${outPath}`);
