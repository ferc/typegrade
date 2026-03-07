#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorePackage } from "../src/package-scorer.js";
import type { AnalysisResult } from "../src/types.js";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";

const manifestPath = join(import.meta.dirname, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

interface ManifestEntry {
  spec: string;
  typesVersion?: string;
}

interface BenchmarkEntry {
  name: string;
  tier: string;
  result: AnalysisResult;
  consumerApi: number | null;
  agentReadiness: number | null;
}

function parseManifestEntry(entry: string | { spec: string; typesVersion?: string }): ManifestEntry {
  if (typeof entry === "string") {
    return { spec: entry };
  }
  return entry;
}

function getCompositeScore(result: AnalysisResult, key: string): number | null {
  return result.composites.find((c) => c.key === key)?.score ?? null;
}

async function main() {
  const entries: BenchmarkEntry[] = [];

  for (const [tier, packages] of Object.entries(manifest.packages) as [string, (string | { spec: string; typesVersion?: string })[]][]) {
    for (const pkg of packages) {
      const { spec, typesVersion } = parseManifestEntry(pkg);
      const name = spec.replace(/@[\d.]+$/, "");
      console.log(`Scoring ${spec}...`);
      try {
        const result = scorePackage(spec, typesVersion ? { typesVersion } : undefined);
        entries.push({
          agentReadiness: getCompositeScore(result, "agentReadiness"),
          consumerApi: getCompositeScore(result, "consumerApi"),
          name,
          result,
          tier,
        });
        console.log(`  consumerApi: ${getCompositeScore(result, "consumerApi")}`);
      } catch (err) {
        console.error(`  FAILED: ${err}`);
      }
    }
  }

  // Print ranking table
  console.log("\n=== Benchmark Results ===\n");
  console.log("Package".padEnd(20) + "Tier".padEnd(10) + "ConsumerAPI".padEnd(14) + "AgentReady");
  console.log("-".repeat(54));

  const sorted = entries.toSorted((a, b) => (b.consumerApi ?? 0) - (a.consumerApi ?? 0));
  for (const entry of sorted) {
    console.log(
      entry.name.padEnd(20) +
      entry.tier.padEnd(10) +
      String(entry.consumerApi ?? "n/a").padEnd(14) +
      String(entry.agentReadiness ?? "n/a"),
    );
  }

  // Run pairwise assertions
  console.log("\n=== Pairwise Assertions ===\n");
  let passed = 0;
  let failed = 0;

  const assertionResults: { assertion: string; result: "pass" | "fail" | "skip"; higherScore?: number | null; lowerScore?: number | null }[] = [];

  for (const assertion of PAIRWISE_ASSERTIONS) {
    const higher = entries.find((e) => e.name === assertion.higher);
    const lower = entries.find((e) => e.name === assertion.lower);

    if (!higher || !lower) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} (missing data)`);
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, result: "skip" });
      continue;
    }

    const higherScore = assertion.composite === "consumerApi" ? higher.consumerApi : higher.agentReadiness;
    const lowerScore = assertion.composite === "consumerApi" ? lower.consumerApi : lower.agentReadiness;

    if (higherScore !== null && lowerScore !== null && higherScore > lowerScore) {
      console.log(`PASS: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore})`);
      passed++;
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, higherScore, lowerScore, result: "pass" });
    } else {
      console.log(`FAIL: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore})`);
      failed++;
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, higherScore, lowerScore, result: "fail" });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} assertions`);

  // Persist results to JSON
  const resultsDir = join(import.meta.dirname, "results");
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    entries: entries.map((e) => ({
      name: e.name,
      tier: e.tier,
      consumerApi: e.consumerApi,
      agentReadiness: e.agentReadiness,
    })),
    assertions: assertionResults,
    summary: { passed, failed, total: passed + failed },
  };

  const filename = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  writeFileSync(join(resultsDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nResults saved to benchmarks/results/${filename}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
