/**
 * Split-aware manifest loader with quarantine enforcement.
 *
 * This module enforces the train/eval separation:
 * - Train code (calibrate.ts, optimize.ts) may only load train manifests
 * - Eval code (judge.ts) may only produce redacted summaries
 * - Pool sampling is deterministic for a given seed and count
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkManifestV2, BenchmarkSplit, ManifestEntry, ManifestEntryV2, RandomSampleSpec } from "./types.js";

const BENCHMARKS_DIR = import.meta.dirname;

/** Canonical manifest filenames per split */
const MANIFEST_FILES: Record<BenchmarkSplit, string> = {
  train: "manifest.train.json",
  "eval-fixed": "manifest.eval.fixed.json",
  "eval-pool": "manifest.eval.pool.json",
};

/** Forbidden manifest patterns for optimizer/calibrator code */
const OPTIMIZER_FORBIDDEN_PATTERNS = [
  "eval.fixed",
  "eval.pool",
  "eval-raw",
  "eval-summary",
];

// ─── Manifest Loading ──────────────────────────────────────────────────────

export function loadManifest(split: BenchmarkSplit): BenchmarkManifestV2 {
  const filename = MANIFEST_FILES[split];
  const manifestPath = join(BENCHMARKS_DIR, filename);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Handle V1 format (just has "packages" at top level, no version field)
  if (!raw.version) {
    return {
      packages: raw.packages ?? raw,
      split,
      version: 2,
    };
  }

  return raw as BenchmarkManifestV2;
}

export function loadManifestByFilename(filename: string): BenchmarkManifestV2 {
  const manifestPath = join(BENCHMARKS_DIR, filename);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Infer split from filename
  let split: BenchmarkSplit = "train";
  if (filename.includes("eval.fixed")) split = "eval-fixed";
  else if (filename.includes("eval.pool")) split = "eval-pool";

  if (!raw.version) {
    return { packages: raw.packages ?? raw, split, version: 2 };
  }

  return raw as BenchmarkManifestV2;
}

// ─── Entry Normalization ───────────────────────────────────────────────────

export interface NormalizedEntry {
  spec: string;
  typesVersion?: string;
  proxyFamily?: string;
  sizeBand?: "small" | "medium" | "large";
  typesSourceHint?: "bundled" | "@types" | "mixed";
  moduleKind?: "esm" | "cjs" | "dual";
  notes?: string;
}

export function normalizeEntry(entry: ManifestEntry): NormalizedEntry {
  if (typeof entry === "string") {
    return { spec: entry };
  }
  return entry as NormalizedEntry;
}

export function getPackageName(entry: ManifestEntry): string {
  const spec = typeof entry === "string" ? entry : (entry as ManifestEntryV2).spec;
  return spec.replaceAll(/@[\d.]+$/g, "");
}

// ─── Flat Package List ─────────────────────────────────────────────────────

export interface FlatEntry {
  tier: string;
  entry: NormalizedEntry;
  name: string;
}

export function flattenManifest(manifest: BenchmarkManifestV2): FlatEntry[] {
  const flat: FlatEntry[] = [];
  for (const [tier, packages] of Object.entries(manifest.packages)) {
    for (const pkg of packages) {
      const normalized = normalizeEntry(pkg);
      flat.push({
        entry: normalized,
        name: normalized.spec.replaceAll(/@[\d.]+$/g, ""),
        tier,
      });
    }
  }
  return flat;
}

// ─── Pool Sampling ─────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32) for reproducible sampling */
function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample N packages from the pool manifest using a seeded PRNG.
 * Sampling is stratified by proxyFamily to ensure domain diversity.
 */
export function samplePool(manifest: BenchmarkManifestV2, spec: RandomSampleSpec): {
  sampled: FlatEntry[];
  manifestHash: string;
  sampledHashes: string[];
} {
  const flat = flattenManifest(manifest);
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifest.packages))
    .digest("hex")
    .slice(0, 16);

  if (spec.count >= flat.length) {
    return {
      manifestHash,
      sampled: flat,
      sampledHashes: flat.map((f) => hashSpec(f.entry.spec)),
    };
  }

  // Group by proxyFamily for stratified sampling
  const byFamily = new Map<string, FlatEntry[]>();
  for (const entry of flat) {
    const family = entry.entry.proxyFamily ?? "general";
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family)!.push(entry);
  }

  // Proportional allocation per family
  const families = [...byFamily.entries()];
  const totalAvailable = flat.length;
  const rng = mulberry32(spec.seed);

  // Shuffle within each family, then take proportional count
  const sampled: FlatEntry[] = [];
  const remaining = spec.count;

  for (const [, entries] of families) {
    // Fisher-Yates shuffle
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    const take = Math.max(1, Math.round((entries.length / totalAvailable) * remaining));
    sampled.push(...entries.slice(0, take));
  }

  // If we have too many, trim; if too few, add from remainder
  if (sampled.length > spec.count) {
    // Shuffle the whole sampled set and trim
    for (let i = sampled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [sampled[i], sampled[j]] = [sampled[j]!, sampled[i]!];
    }
    sampled.length = spec.count;
  }

  return {
    manifestHash,
    sampled,
    sampledHashes: sampled.map((f) => hashSpec(f.entry.spec)),
  };
}

function hashSpec(spec: string): string {
  return createHash("sha256").update(spec).digest("hex").slice(0, 12);
}

// ─── Quarantine Guards ─────────────────────────────────────────────────────

/**
 * Assert that the calling module is not trying to load eval manifests.
 * Used by calibrate.ts and optimize.ts to enforce quarantine at runtime.
 */
export function assertTrainOnly(callerFile: string): void {
  const callerContent = readFileSync(callerFile, "utf8");
  for (const pattern of OPTIMIZER_FORBIDDEN_PATTERNS) {
    if (callerContent.includes(pattern)) {
      throw new Error(
        `Quarantine violation: ${callerFile} references eval pattern '${pattern}'. ` +
        `Optimizer/calibrator code must only access train data.`,
      );
    }
  }
}

/**
 * Validate that a manifest file belongs to the expected split.
 * Prevents accidental cross-split loading.
 */
export function validateManifestSplit(manifest: BenchmarkManifestV2, expectedSplit: BenchmarkSplit): void {
  if (manifest.split && manifest.split !== expectedSplit) {
    throw new Error(
      `Split mismatch: expected '${expectedSplit}' but manifest declares '${manifest.split}'`,
    );
  }
}
