/**
 * Shadow-latest benchmark track — measures generalization on random npm packages.
 * Produces only redacted aggregate outcomes (no per-package details in builder artifacts).
 *
 * This is a judge-only command: raw results go to benchmarks-output/shadow-raw/,
 * only the RedactedShadowSummary is builder-visible.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorePackage } from "../src/package-scorer.js";
import type { AnalysisResult } from "../src/types.js";
import type { RedactedShadowSummary } from "./types.js";
import { loadManifest, samplePool } from "./split-loader.js";

interface ShadowLatestConfig {
  /** Number of packages to sample */
  sampleCount: number;
  /** Seed for reproducible sampling */
  seed: number;
  /** Output directory for raw results (judge-only) */
  rawOutputDir: string;
  /** Output directory for redacted summary */
  summaryOutputDir: string;
}

/** Per-package raw result (stored in shadow-raw/, never builder-visible) */
interface ShadowRawEntry {
  specHash: string;
  status: string;
  scoreValidity: string;
  trustClassification: string;
  entrypointStrategy: string;
  usedFallbackGlob: boolean;
  hasDomainScore: boolean;
  hasScenarioScore: boolean;
  consumerApi: number | null;
  agentReadiness: number | null;
  typeSafety: number | null;
  confidenceSummary: {
    graphResolution: number;
    domainInference: number;
    sampleCoverage: number;
    scenarioApplicability: number;
  };
  typesSource: string;
  sizeBand: string;
  moduleKind: string;
}

const DEFAULT_CONFIG: ShadowLatestConfig = {
  sampleCount: 30,
  seed: Date.now(),
  rawOutputDir: "benchmarks-output/shadow-raw",
  summaryOutputDir: "benchmarks-output",
};

/** Hash a string for anonymization */
function anonymize(input: string): string {
  // Simple hash — no crypto import needed, just enough to anonymize
  let hash = 0;
  for (let ii = 0; ii < input.length; ii++) {
    const ch = input.charCodeAt(ii);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/** Compute 99% lower confidence bound using Wilson score interval */
function wilsonLowerBound(successes: number, total: number): number {
  if (total === 0) return 0;
  const zz = 2.576; // Z-score for 99% confidence
  const pHat = successes / total;
  const denominator = 1 + (zz * zz) / total;
  const center = pHat + (zz * zz) / (2 * total);
  const spread = zz * Math.sqrt((pHat * (1 - pHat) + (zz * zz) / (4 * total)) / total);
  return Math.max(0, (center - spread) / denominator);
}

/** Run shadow-latest benchmark and produce redacted summary */
export async function runShadowLatest(
  config: Partial<ShadowLatestConfig> = {},
): Promise<RedactedShadowSummary> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Ensure output directories exist
  for (const dir of [cfg.rawOutputDir, cfg.summaryOutputDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Sample from eval-pool if available, otherwise use a minimal set
  let specs: { spec: string; typesSourceHint?: string; sizeBand?: string; moduleKind?: string }[] = [];
  try {
    const manifest = loadManifest("eval-pool");
    const { sampled } = samplePool(manifest, { count: cfg.sampleCount, seed: cfg.seed });
    specs = sampled.map((ss) => ({
      moduleKind: ss.entry.moduleKind,
      sizeBand: ss.entry.sizeBand,
      spec: ss.entry.spec,
      typesSourceHint: ss.entry.typesSourceHint,
    }));
  } catch {
    console.log("No eval-pool manifest found. Shadow benchmark requires eval-pool manifest.");
    return buildEmptySummary();
  }

  if (specs.length === 0) {
    console.log("No packages sampled. Shadow benchmark requires at least 1 package.");
    return buildEmptySummary();
  }

  console.log(`Scoring ${specs.length} shadow packages (seed=${cfg.seed})...\n`);

  const rawEntries: ShadowRawEntry[] = [];
  let installFailures = 0;
  let comparable = 0;
  let abstained = 0;
  let falseAuthoritative = 0;
  let fallbackGlob = 0;
  let domainOverreach = 0;
  let scenarioOverreach = 0;

  for (const pkg of specs) {
    const specHash = anonymize(pkg.spec);
    console.log(`  Scoring ${specHash}...`);

    let result: AnalysisResult;
    try {
      result = scorePackage(pkg.spec, { noCache: true });
    } catch (error) {
      installFailures++;
      rawEntries.push({
        agentReadiness: null,
        confidenceSummary: { domainInference: 0, graphResolution: 0, sampleCoverage: 0, scenarioApplicability: 0 },
        consumerApi: null,
        entrypointStrategy: "unknown",
        hasDomainScore: false,
        hasScenarioScore: false,
        moduleKind: pkg.moduleKind ?? "unknown",
        scoreValidity: "not-comparable",
        sizeBand: pkg.sizeBand ?? "unknown",
        specHash,
        status: "install-failure",
        trustClassification: "abstained",
        typeSafety: null,
        typesSource: pkg.typesSourceHint ?? "unknown",
        usedFallbackGlob: false,
      });
      continue;
    }

    const trustClass = result.trustSummary?.classification ?? "abstained";
    const isComparable = result.scoreValidity === "fully-comparable";
    const isDegraded = result.status === "degraded";
    const hasNumericScores = result.composites.some((cc) => cc.score !== null);

    if (isComparable) comparable++;
    if (isDegraded && !hasNumericScores) abstained++;
    if (isDegraded && hasNumericScores) falseAuthoritative++;
    if (result.graphStats.usedFallbackGlob) fallbackGlob++;
    if (result.domainInference?.domain && result.domainInference.domain !== "general" && (result.domainInference.confidence ?? 0) < 0.5) {
      domainOverreach++;
    }
    if (result.scenarioScore && result.domainInference?.domain === "general") {
      scenarioOverreach++;
    }

    rawEntries.push({
      agentReadiness: result.composites.find((cc) => cc.key === "agentReadiness")?.score ?? null,
      confidenceSummary: result.confidenceSummary,
      consumerApi: result.composites.find((cc) => cc.key === "consumerApi")?.score ?? null,
      entrypointStrategy: result.packageIdentity.entrypointStrategy,
      hasDomainScore: result.domainScore !== undefined,
      hasScenarioScore: result.scenarioScore !== undefined,
      moduleKind: pkg.moduleKind ?? result.packageIdentity.moduleKind ?? "unknown",
      scoreValidity: result.scoreValidity,
      sizeBand: pkg.sizeBand ?? "unknown",
      specHash,
      status: result.status,
      trustClassification: trustClass,
      typeSafety: result.composites.find((cc) => cc.key === "typeSafety")?.score ?? null,
      typesSource: result.packageIdentity.typesSource,
      usedFallbackGlob: result.graphStats.usedFallbackGlob,
    });
  }

  // Write raw results (judge-only, never builder-visible)
  const rawPath = join(cfg.rawOutputDir, `shadow-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
  writeFileSync(rawPath, JSON.stringify({ entries: rawEntries, seed: cfg.seed, timestamp: new Date().toISOString() }, null, 2));

  // Compute aggregate metrics
  const total = rawEntries.length;
  const comparableRate = total > 0 ? comparable / total : 0;
  const abstentionRate = total > 0 ? abstained / Math.max(1, rawEntries.filter((ee) => ee.status === "degraded").length) : 1;
  const falseAuthRate = total > 0 ? falseAuthoritative / total : 0;
  const installRate = total > 0 ? installFailures / total : 0;
  const fallbackRate = total > 0 ? fallbackGlob / total : 0;
  const domainOverreachRate = total > 0 ? domainOverreach / total : 0;
  const scenarioOverreachRate = total > 0 ? scenarioOverreach / total : 0;

  // Score compression: check if scores cluster in narrow band
  const validScores = rawEntries.map((ee) => ee.consumerApi).filter((ss): ss is number => ss !== null);
  let scoreCompression = 0;
  if (validScores.length >= 3) {
    const mean = validScores.reduce((aa, bb) => aa + bb, 0) / validScores.length;
    const variance = validScores.reduce((aa, bb) => aa + (bb - mean) ** 2, 0) / validScores.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    scoreCompression = cv < 0.1 ? 1 : 0;
  }

  // Build stratification (anonymized)
  const byTypesSource: Record<string, { count: number; comparableRate: number }> = {};
  const bySizeBand: Record<string, { count: number; comparableRate: number }> = {};
  const byModuleKind: Record<string, { count: number; comparableRate: number }> = {};

  for (const en of rawEntries) {
    const ts = en.typesSource;
    if (!byTypesSource[ts]) byTypesSource[ts] = { comparableRate: 0, count: 0 };
    byTypesSource[ts]!.count++;
    if (en.scoreValidity === "fully-comparable") byTypesSource[ts]!.comparableRate++;

    const sb = en.sizeBand;
    if (!bySizeBand[sb]) bySizeBand[sb] = { comparableRate: 0, count: 0 };
    bySizeBand[sb]!.count++;
    if (en.scoreValidity === "fully-comparable") bySizeBand[sb]!.comparableRate++;

    const mk = en.moduleKind;
    if (!byModuleKind[mk]) byModuleKind[mk] = { comparableRate: 0, count: 0 };
    byModuleKind[mk]!.count++;
    if (en.scoreValidity === "fully-comparable") byModuleKind[mk]!.comparableRate++;
  }

  // Normalize rates
  for (const vv of Object.values(byTypesSource)) vv.comparableRate = vv.count > 0 ? vv.comparableRate / vv.count : 0;
  for (const vv of Object.values(bySizeBand)) vv.comparableRate = vv.count > 0 ? vv.comparableRate / vv.count : 0;
  for (const vv of Object.values(byModuleKind)) vv.comparableRate = vv.count > 0 ? vv.comparableRate / vv.count : 0;

  // Compute confidence bounds
  const confidenceBounds = {
    abstentionCorrectnessRate: wilsonLowerBound(abstained, Math.max(1, rawEntries.filter((ee) => ee.status === "degraded").length)),
    comparableRate: wilsonLowerBound(comparable, total),
    falseAuthoritativeRate: 1 - wilsonLowerBound(total - falseAuthoritative, total),
    fallbackGlobRate: 1 - wilsonLowerBound(total - fallbackGlob, total),
  };

  // Build gates
  const gateResults: { gate: string; passed: boolean; detail: string }[] = [
    { detail: `${(falseAuthRate * 100).toFixed(1)}%`, gate: "false-authoritative-=0", passed: falseAuthoritative === 0 },
    { detail: `${(fallbackRate * 100).toFixed(1)}%`, gate: "fallback-glob-<1%", passed: fallbackRate < 0.01 },
    { detail: `${(installRate * 100).toFixed(1)}%`, gate: "install-failure-<5%", passed: installRate < 0.05 },
    { detail: `${(comparableRate * 100).toFixed(1)}%`, gate: "comparable-rate->50%", passed: comparableRate > 0.5 },
    { detail: `${(domainOverreachRate * 100).toFixed(1)}%`, gate: "domain-overreach-<15%", passed: domainOverreachRate < 0.15 },
    { detail: `${(scenarioOverreachRate * 100).toFixed(1)}%`, gate: "scenario-overreach-<15%", passed: scenarioOverreachRate < 0.15 },
    { detail: `${(abstentionRate * 100).toFixed(1)}%`, gate: "abstention-correctness->80%", passed: abstentionRate > 0.8 },
  ];

  const summary: RedactedShadowSummary = {
    abstentionCorrectnessRate: Math.round(abstentionRate * 1000) / 1000,
    allGatesPassed: gateResults.every((gg) => gg.passed),
    comparableRate: Math.round(comparableRate * 1000) / 1000,
    confidenceBounds,
    crossRunStability: 1, // Single run — stability requires multiple runs
    domainOverreachRate: Math.round(domainOverreachRate * 1000) / 1000,
    falseAuthoritativeRate: Math.round(falseAuthRate * 1000) / 1000,
    fallbackGlobRate: Math.round(fallbackRate * 1000) / 1000,
    gates: gateResults,
    installFailureRate: Math.round(installRate * 1000) / 1000,
    scenarioOverreachRate: Math.round(scenarioOverreachRate * 1000) / 1000,
    scoreCompressionRate: Math.round(scoreCompression * 1000) / 1000,
    stratification: { byModuleKind, bySizeBand, byTypesSource },
    timestamp: new Date().toISOString(),
    totalPackages: total,
  };

  // Write redacted summary (builder-visible)
  const summaryPath = join(cfg.summaryOutputDir, "shadow-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  return summary;
}

function buildEmptySummary(): RedactedShadowSummary {
  return {
    abstentionCorrectnessRate: 0,
    allGatesPassed: false,
    comparableRate: 0,
    confidenceBounds: { abstentionCorrectnessRate: 0, comparableRate: 0, falseAuthoritativeRate: 0, fallbackGlobRate: 0 },
    crossRunStability: 0,
    domainOverreachRate: 0,
    falseAuthoritativeRate: 0,
    fallbackGlobRate: 0,
    gates: [{ detail: "No packages sampled", gate: "shadow-data-exists", passed: false }],
    installFailureRate: 0,
    scenarioOverreachRate: 0,
    scoreCompressionRate: 0,
    timestamp: new Date().toISOString(),
    totalPackages: 0,
  };
}

/** Check shadow gates from a summary */
export function checkShadowGates(summary: RedactedShadowSummary): {
  passed: boolean;
  gates: { name: string; passed: boolean; value: string; threshold: string }[];
} {
  const gates = summary.gates.map((gg) => ({
    name: gg.gate,
    passed: gg.passed,
    threshold: gg.gate.split("-").pop() ?? "?",
    value: gg.detail,
  }));
  return { gates, passed: summary.allGatesPassed };
}

// CLI entrypoint — run shadow-latest when executed directly
async function main() {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number.parseInt(args[seedIdx + 1] ?? "42", 10) : Date.now();
  const countIdx = args.indexOf("--count");
  const count = countIdx >= 0 ? Number.parseInt(args[countIdx + 1] ?? "30", 10) : 30;

  console.log("=== Shadow Validation Benchmark ===\n");
  const summary = await runShadowLatest({ sampleCount: count, seed });
  const gateCheck = checkShadowGates(summary);

  console.log("\n=== Shadow Gate Results ===\n");
  for (const gate of gateCheck.gates) {
    const icon = gate.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${gate.name.padEnd(35)} ${gate.value} (threshold: ${gate.threshold})`);
  }

  const passedCount = gateCheck.gates.filter((gt) => gt.passed).length;
  console.log(`\n  ${passedCount}/${gateCheck.gates.length} shadow gates passed`);
  console.log(`  Total packages: ${summary.totalPackages}`);
  console.log(`  Comparable rate: ${(summary.comparableRate * 100).toFixed(1)}%`);
  console.log(`  False-authoritative rate: ${(summary.falseAuthoritativeRate * 100).toFixed(1)}%`);
  console.log(`  Fallback-glob rate: ${(summary.fallbackGlobRate * 100).toFixed(1)}%`);
  console.log(`\nRedacted summary saved to benchmarks-output/shadow-summary.json`);
  console.log(`Raw results saved to benchmarks-output/shadow-raw/ (judge-only)`);

  if (!gateCheck.passed) {
    console.log("\nShadow gate failures are non-blocking (report-only mode).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
