#!/usr/bin/env tsx
/**
 * Multi-seed random eval runner — runs fixed seeds over the eval pool.
 *
 * Each seed produces a separate eval snapshot in benchmarks-output/eval-raw/.
 * After all seeds complete, run `pnpm benchmark:judge` to produce an
 * aggregate eval summary with seed instability metrics.
 *
 * Usage:
 *   tsx benchmarks/multi-seed.ts [--count M] [--seeds N]
 *
 * Defaults: 10 fixed seeds, 30 packages per seed.
 * Seeds are fixed to ensure reproducibility across runs.
 * Use --seeds N to use the first N seeds from the extended pool.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";

/** Extended seed pool — deterministic across all runs */
const SEED_POOL = [
  11, 23, 37, 41, 59, 71, 83, 97, 101, 127, 131, 139, 149, 157, 163, 173, 181, 191, 197, 199, 211,
  223, 227, 229, 233,
];

const args = process.argv.slice(2);

const countIdx = args.indexOf("--count");
const sampleCount = countIdx >= 0 ? Number.parseInt(args[countIdx + 1] ?? "30", 10) : 30;

const seedsIdx = args.indexOf("--seeds");
const seedCount = seedsIdx >= 0 ? Number.parseInt(args[seedsIdx + 1] ?? "10", 10) : 10;

const seeds = SEED_POOL.slice(0, Math.min(seedCount, SEED_POOL.length));

function main() {
  console.log("=== typegrade Multi-Seed Random Eval ===\n");
  console.log(`  Seeds: [${seeds.join(", ")}]`);
  console.log(`  Sample count per seed: ${sampleCount}\n`);

  const projectRoot = join(import.meta.dirname, "..");
  let passed = 0;
  let failed = 0;

  for (let idx = 0; idx < seeds.length; idx++) {
    const seed = seeds[idx]!;
    console.log(`\n--- Seed ${seed} (${idx + 1}/${seeds.length}) ---\n`);

    try {
      execSync(`tsx benchmarks/run.ts --count ${sampleCount} --seed ${seed}`, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: "inherit",
        timeout: 600_000,
      });
      passed++;
    } catch (error) {
      console.error(
        `Seed ${seed} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed++;
    }
  }

  console.log(`\n=== Multi-seed run complete ===`);
  console.log(`  Passed: ${passed}/${seeds.length}`);
  if (failed > 0) {
    console.log(`  Failed: ${failed}/${seeds.length}`);
  }
  console.log(`\nRun 'pnpm benchmark:judge' to produce aggregate eval summary.`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
