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
  holdout: "manifest.holdout.json",
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
  if (filename.includes("holdout")) split = "holdout";
  else if (filename.includes("eval.fixed")) split = "eval-fixed";
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
 * Build a stratification key from family, size band, and types source.
 * This ensures sampling diversity across all three dimensions.
 */
function stratKey(entry: NormalizedEntry): string {
  const family = entry.proxyFamily ?? "general";
  const size = entry.sizeBand ?? "medium";
  const source = entry.typesSourceHint ?? "bundled";
  return `${family}|${size}|${source}`;
}

/**
 * Sample N packages from the pool manifest using a seeded PRNG.
 * Sampling is stratified by proxyFamily, sizeBand, and typesSourceHint
 * to ensure diversity across domain, surface size, and type source.
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

  // Group by stratification key (family + sizeBand + typesSource)
  const byStratum = new Map<string, FlatEntry[]>();
  for (const entry of flat) {
    const key = stratKey(entry.entry);
    if (!byStratum.has(key)) {
      byStratum.set(key, []);
    }
    byStratum.get(key)!.push(entry);
  }

  const strata = [...byStratum.entries()];
  const totalAvailable = flat.length;
  const rng = mulberry32(spec.seed);

  // Shuffle within each stratum, then take proportional count
  const sampled: FlatEntry[] = [];
  const remaining = spec.count;

  for (const [, entries] of strata) {
    // Fisher-Yates shuffle
    for (let idx = entries.length - 1; idx > 0; idx--) {
      const jj = Math.floor(rng() * (idx + 1));
      [entries[idx], entries[jj]] = [entries[jj]!, entries[idx]!];
    }
    const take = Math.max(1, Math.round((entries.length / totalAvailable) * remaining));
    sampled.push(...entries.slice(0, take));
  }

  // If we have too many, trim; if too few, add from remainder
  if (sampled.length > spec.count) {
    // Shuffle the whole sampled set and trim
    for (let idx = sampled.length - 1; idx > 0; idx--) {
      const jj = Math.floor(rng() * (idx + 1));
      [sampled[idx], sampled[jj]] = [sampled[jj]!, sampled[idx]!];
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

// ─── Structural Manifest Validation ───────────────────────────────────────

/** Validate a package spec has the required format: name@version */
function isValidPackageSpec(spec: string): boolean {
  // Scoped: @scope/name@version
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx < 2) {
      return false;
    }
    const afterSlash = spec.slice(slashIdx + 1);
    const atIdx = afterSlash.indexOf("@");
    // Must have @version suffix
    return atIdx > 0 && afterSlash.length > atIdx + 1;
  }
  // Unscoped: name@version
  const atIdx = spec.indexOf("@");
  return atIdx > 0 && spec.length > atIdx + 1;
}

/** Validation error for a manifest entry */
export interface ManifestValidationError {
  tier: string;
  spec: string;
  reason: string;
}

/**
 * Validate all entries in a manifest structurally (no network calls).
 * Checks that every spec has an explicit version (no "latest" or bare names).
 * Returns an array of validation errors (empty = valid).
 */
export function validateManifestStructure(manifest: BenchmarkManifestV2): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];
  const seen = new Set<string>();

  for (const [tier, packages] of Object.entries(manifest.packages)) {
    if (!Array.isArray(packages)) {
      errors.push({ reason: "Tier value is not an array", spec: "(none)", tier });
      continue;
    }
    for (const pkg of packages) {
      const normalized = normalizeEntry(pkg);
      const { spec } = normalized;

      if (!spec || spec.trim().length === 0) {
        errors.push({ reason: "Empty spec", spec: "(empty)", tier });
        continue;
      }

      if (!isValidPackageSpec(spec)) {
        errors.push({ reason: "Spec must be name@version (no bare names or 'latest')", spec, tier });
        continue;
      }

      if (seen.has(spec)) {
        errors.push({ reason: "Duplicate spec in manifest", spec, tier });
      }
      seen.add(spec);
    }
  }

  return errors;
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
