import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Content-addressed package cache for typegrade.
 *
 * Cache layout:
 *   $CACHE_DIR/
 *     packages/
 *       <key>/          — extracted package files (after npm install)
 *     results/
 *       <key>.json      — cached AnalysisResult
 */

const TOOL_VERSION = "0.5.0";

function getCacheRoot(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg ?? join(homedir(), ".cache");
  return join(base, "typegrade");
}

export interface PackageCacheKey {
  packageSpec: string;
  typesVersion?: string | undefined;
  tsVersion: string;
}

export function computePackageCacheKey(opts: PackageCacheKey): string {
  const parts = [TOOL_VERSION, opts.packageSpec, opts.tsVersion, opts.typesVersion ?? ""].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

export interface ResultCacheKey {
  packageCacheKey: string;
  scoringConfigHash: string;
  nodeMajor: number;
}

export function computeResultCacheKey(opts: ResultCacheKey): string {
  const parts = [
    TOOL_VERSION,
    opts.packageCacheKey,
    opts.scoringConfigHash,
    String(opts.nodeMajor),
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

/**
 * Compute a hash of scoring configuration (weights, thresholds, etc.)
 * so that cache invalidation happens when scoring logic changes.
 */
export function computeScoringConfigHash(constantsPath: string): string {
  try {
    const content = readFileSync(constantsPath, "utf8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

export function getPackageCachePath(key: string): string {
  return join(getCacheRoot(), "packages", key);
}

export function getResultCachePath(key: string): string {
  return join(getCacheRoot(), "results", `${key}.json`);
}

export function hasPackageCache(key: string): boolean {
  const dir = getPackageCachePath(key);
  return existsSync(join(dir, ".typegrade-cached"));
}

export function markPackageCached(key: string): void {
  const dir = getPackageCachePath(key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".typegrade-cached"), new Date().toISOString());
}

export function hasResultCache(key: string): boolean {
  return existsSync(getResultCachePath(key));
}

export function readResultCache<TResult>(key: string): TResult | null {
  const cachePath = getResultCachePath(key);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as TResult;
  } catch {
    return null;
  }
}

export function writeResultCache<TResult>(key: string, data: TResult): void {
  const cachePath = getResultCachePath(key);
  mkdirSync(join(getCacheRoot(), "results"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data));
}

export function ensureCacheDir(): void {
  mkdirSync(join(getCacheRoot(), "packages"), { recursive: true });
  mkdirSync(join(getCacheRoot(), "results"), { recursive: true });
}
