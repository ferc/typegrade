#!/usr/bin/env tsx
/**
 * Multi-seed random eval runner — runs N seeds over the eval pool.
 *
 * Each seed produces a separate eval snapshot in benchmarks-output/eval-raw/.
 * After all seeds complete, run `pnpm benchmark:judge` to produce an
 * aggregate eval summary with seed instability metrics.
 *
 * Usage:
 *   tsx benchmarks/multi-seed.ts [--seeds N] [--count M] [--base-seed S]
 *
 * Defaults: 5 seeds, 10 packages per seed, base seed 42.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);

const seedsIdx = args.indexOf("--seeds");
const seedCount = seedsIdx >= 0 ? Number.parseInt(args[seedsIdx + 1] ?? "5", 10) : 5;

const countIdx = args.indexOf("--count");
const sampleCount = countIdx >= 0 ? Number.parseInt(args[countIdx + 1] ?? "10", 10) : 10;

const baseSeedIdx = args.indexOf("--base-seed");
const baseSeed = baseSeedIdx >= 0 ? Number.parseInt(args[baseSeedIdx + 1] ?? "42", 10) : 42;

function main() {
  console.log("=== typegrade Multi-Seed Random Eval ===\n");
  console.log(`  Seeds: ${seedCount}`);
  console.log(`  Sample count per seed: ${sampleCount}`);
  console.log(`  Base seed: ${baseSeed}\n`);

  const projectRoot = join(import.meta.dirname, "..");
  let passed = 0;
  let failed = 0;

  for (let idx = 0; idx < seedCount; idx++) {
    const seed = baseSeed + idx;
    console.log(`\n--- Seed ${seed} (${idx + 1}/${seedCount}) ---\n`);

    try {
      execSync(
        `tsx benchmarks/run.ts --pool-sample ${sampleCount} --seed ${seed}`,
        { cwd: projectRoot, encoding: "utf8", stdio: "inherit", timeout: 600_000 },
      );
      passed++;
    } catch (error) {
      console.error(`Seed ${seed} failed: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  }

  console.log(`\n=== Multi-seed run complete ===`);
  console.log(`  Passed: ${passed}/${seedCount}`);
  if (failed > 0) {
    console.log(`  Failed: ${failed}/${seedCount}`);
  }
  console.log(`\nRun 'pnpm benchmark:judge' to produce aggregate eval summary.`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
