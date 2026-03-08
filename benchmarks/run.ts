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
  let mustPassPassed = 0;
  let mustPassFailed = 0;
  let diagnosticPassed = 0;
  let diagnosticFailed = 0;

  const assertionResults: { assertion: string; class: string; result: "pass" | "fail" | "skip"; higherScore?: number | null; lowerScore?: number | null; delta?: number | null; minDelta?: number }[] = [];

  for (const assertion of PAIRWISE_ASSERTIONS) {
    const higher = entries.find((e) => e.name === assertion.higher);
    const lower = entries.find((e) => e.name === assertion.lower);

    if (!higher || !lower) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} (missing data)`);
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, result: "skip" });
      continue;
    }

    const higherScore = assertion.composite === "consumerApi" ? higher.consumerApi : higher.agentReadiness;
    const lowerScore = assertion.composite === "consumerApi" ? lower.consumerApi : lower.agentReadiness;

    const delta = (higherScore ?? 0) - (lowerScore ?? 0);
    const meetsMinDelta = assertion.minDelta ? delta >= assertion.minDelta : true;
    const passes = higherScore !== null && lowerScore !== null && higherScore > lowerScore && meetsMinDelta;

    if (passes) {
      const label = assertion.class === "must-pass" ? "PASS" : "PASS (diag)";
      console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore})`);
      if (assertion.class === "must-pass") {mustPassPassed++;} else {diagnosticPassed++;}
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "pass" });
    } else {
      // Check if it's a margin failure (order correct but delta too small)
      if (!meetsMinDelta && higherScore !== null && lowerScore !== null && higherScore > lowerScore) {
        const label = assertion.class === "must-pass" ? "MARGIN" : "MARGIN (diag)";
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) but delta ${delta} < minDelta ${assertion.minDelta}`);
      } else {
        const label = assertion.class === "must-pass" ? "FAIL" : "WARN (diag)";
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore})`);
      }
      if (assertion.class === "must-pass") {mustPassFailed++;} else {diagnosticFailed++;}
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "fail" });
    }
  }

  const totalMustPass = mustPassPassed + mustPassFailed;
  const totalDiagnostic = diagnosticPassed + diagnosticFailed;
  console.log(`\nMust-pass: ${mustPassPassed}/${totalMustPass} passed`);
  console.log(`Diagnostic: ${diagnosticPassed}/${totalDiagnostic} passed (warnings only)`);

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
      dimensions: e.result.dimensions.map((d) => ({
        key: d.key,
        score: d.score,
        confidence: d.confidence ?? null,
      })),
      graphStats: e.result.graphStats ?? null,
      domainInference: e.result.domainInference ?? null,
      caveats: e.result.caveats,
    })),
    assertions: assertionResults,
    summary: {
      mustPass: { passed: mustPassPassed, failed: mustPassFailed, total: totalMustPass },
      diagnostic: { passed: diagnosticPassed, failed: diagnosticFailed, total: totalDiagnostic },
    },
  };

  const filename = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  writeFileSync(join(resultsDir, filename), JSON.stringify(snapshot, null, 2));
  console.log(`\nResults saved to benchmarks/results/${filename}`);

  // Exit code 1 only on must-pass failures
  if (mustPassFailed > 0) {
    process.exit(1);
  }
}

main();
