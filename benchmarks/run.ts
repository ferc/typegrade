#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorePackage } from "../src/package-scorer.js";
import type { AnalysisResult, ScenarioScore } from "../src/types.js";
import { PAIRWISE_ASSERTIONS } from "./assertions.js";
import type { DomainKey } from "../src/types.js";

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
  typeSafety: number | null;
  domainFitScore: number | null;
  scenarioScore: ScenarioScore | null;
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

        // Extract domain and scenario scores (now computed inside analyzer with actual surface)
        const domainFitScore = result.domainScore?.score ?? null;
        const scenarioScore: ScenarioScore | null = result.scenarioScore ?? null;

        entries.push({
          agentReadiness: getCompositeScore(result, "agentReadiness"),
          consumerApi: getCompositeScore(result, "consumerApi"),
          domainFitScore,
          name,
          result,
          scenarioScore,
          tier,
          typeSafety: getCompositeScore(result, "typeSafety"),
        });
        const domainStr = domainFitScore !== null ? ` | domainFit: ${domainFitScore}` : "";
        console.log(`  consumerApi: ${getCompositeScore(result, "consumerApi")} | agentReadiness: ${getCompositeScore(result, "agentReadiness")} | typeSafety: ${getCompositeScore(result, "typeSafety")}${domainStr}`);
      } catch (err) {
        console.error(`  FAILED: ${err}`);
      }
    }
  }

  // Print ranking table
  console.log("\n=== Benchmark Results ===\n");
  console.log("Package".padEnd(25) + "Tier".padEnd(12) + "ConsumerAPI".padEnd(14) + "AgentReady".padEnd(14) + "TypeSafety".padEnd(14) + "DomainFit".padEnd(14) + "Scenario");
  console.log("-".repeat(107));

  const sorted = entries.toSorted((a, b) => (b.consumerApi ?? 0) - (a.consumerApi ?? 0));
  for (const entry of sorted) {
    const scenarioStr = entry.scenarioScore
      ? `${entry.scenarioScore.score} (${entry.scenarioScore.passedScenarios}/${entry.scenarioScore.totalScenarios})`
      : "n/a";
    console.log(
      entry.name.padEnd(25) +
      entry.tier.padEnd(12) +
      String(entry.consumerApi ?? "n/a").padEnd(14) +
      String(entry.agentReadiness ?? "n/a").padEnd(14) +
      String(entry.typeSafety ?? "n/a").padEnd(14) +
      String(entry.domainFitScore ?? "n/a").padEnd(14) +
      scenarioStr,
    );
  }

  // Run pairwise assertions
  console.log("\n=== Pairwise Assertions ===\n");
  let mustPassPassed = 0;
  let mustPassFailed = 0;
  let diagnosticPassed = 0;
  let diagnosticFailed = 0;
  let hardDiagPassed = 0;
  let hardDiagFailed = 0;

  const assertionResults: {
    assertion: string;
    class: string;
    result: "pass" | "fail" | "skip";
    higherScore?: number | null;
    lowerScore?: number | null;
    delta?: number | null;
    minDelta?: number;
  }[] = [];

  for (const assertion of PAIRWISE_ASSERTIONS) {
    const higher = entries.find((e) => e.name === assertion.higher);
    const lower = entries.find((e) => e.name === assertion.lower);

    if (!higher || !lower) {
      console.log(`SKIP: ${assertion.higher} > ${assertion.lower} (missing data)`);
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, result: "skip" });
      continue;
    }

    let higherScore: number | null;
    let lowerScore: number | null;

    if (assertion.composite === "consumerApi") {
      higherScore = higher.consumerApi;
      lowerScore = lower.consumerApi;
    } else if (assertion.composite === "agentReadiness") {
      higherScore = higher.agentReadiness;
      lowerScore = lower.agentReadiness;
    } else {
      higherScore = higher.typeSafety;
      lowerScore = lower.typeSafety;
    }

    const delta = (higherScore ?? 0) - (lowerScore ?? 0);
    const meetsMinDelta = assertion.minDelta ? delta >= assertion.minDelta : true;
    const passes = higherScore !== null && lowerScore !== null && higherScore > lowerScore && meetsMinDelta;

    if (passes) {
      const label = assertion.class === "must-pass" ? "PASS" : assertion.class === "hard-diagnostic" ? "PASS (hard)" : `PASS (${assertion.class})`;
      console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
      if (assertion.class === "must-pass") {mustPassPassed++;}
      else if (assertion.class === "hard-diagnostic") {hardDiagPassed++;}
      else {diagnosticPassed++;}
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "pass" });
    } else {
      if (!meetsMinDelta && higherScore !== null && lowerScore !== null && higherScore > lowerScore) {
        const label = assertion.class === "must-pass" ? "MARGIN" : `MARGIN (${assertion.class})`;
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) but delta ${delta} < minDelta ${assertion.minDelta} [${assertion.composite}]`);
      } else {
        const label = assertion.class === "must-pass" ? "FAIL" : assertion.class === "hard-diagnostic" ? "FAIL (hard)" : `WARN (${assertion.class})`;
        console.log(`${label}: ${assertion.higher} (${higherScore}) > ${assertion.lower} (${lowerScore}) [${assertion.composite}]`);
      }
      if (assertion.class === "must-pass") {mustPassFailed++;}
      else if (assertion.class === "hard-diagnostic") {hardDiagFailed++;}
      else {diagnosticFailed++;}
      assertionResults.push({ assertion: `${assertion.higher} > ${assertion.lower}`, class: assertion.class, delta, higherScore, lowerScore, minDelta: assertion.minDelta, result: "fail" });
    }
  }

  const totalMustPass = mustPassPassed + mustPassFailed;
  const totalDiagnostic = diagnosticPassed + diagnosticFailed;
  const totalHardDiag = hardDiagPassed + hardDiagFailed;
  console.log(`\nMust-pass: ${mustPassPassed}/${totalMustPass} passed`);
  console.log(`Hard-diagnostic: ${hardDiagPassed}/${totalHardDiag} passed`);
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
      typeSafety: e.typeSafety,
      domainFitScore: e.domainFitScore,
      domain: e.result.domainInference?.domain ?? null,
      dimensions: e.result.dimensions.map((d) => ({
        key: d.key,
        score: d.score,
        confidence: d.confidence ?? null,
        metrics: d.metrics,
      })),
      graphStats: e.result.graphStats ?? null,
      dedupStats: e.result.dedupStats ?? null,
      domainInference: e.result.domainInference ?? null,
      topIssues: e.result.topIssues.slice(0, 5),
      scenarioScore: e.scenarioScore ?? null,
      explainability: e.result.explainability ?? null,
      caveats: e.result.caveats,
    })),
    assertions: assertionResults,
    summary: {
      mustPass: { passed: mustPassPassed, failed: mustPassFailed, total: totalMustPass },
      hardDiagnostic: { passed: hardDiagPassed, failed: hardDiagFailed, total: totalHardDiag },
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
