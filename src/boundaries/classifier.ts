import type { BoundaryType, TrustLevel } from "../types.js";

/** Patterns for classifying boundary types from call expressions */
const NETWORK_PATTERNS = [
  /\bfetch\b/,
  /\baxios\b/,
  /\bhttp\b/,
  /\brequest\b/,
  /\.get\(/,
  /\.post\(/,
  /\.put\(/,
  /\.delete\(/,
  /\.patch\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\.listen\(/,
  /createServer/,
];

const FILESYSTEM_PATTERNS = [
  /\breadFileSync\b/,
  /\breadFile\b/,
  /\bwriteFileSync\b/,
  /\bwriteFile\b/,
  /\bcreateReadStream\b/,
  /\bcreateWriteStream\b/,
  /\bfs\.\w+/,
  /\bfsp\.\w+/,
];

const ENV_PATTERNS = [/process\.env/, /\bDotenv\b/, /\.env\b/];

const CONFIG_PATTERNS = [
  /\bconfig\b/i,
  /\bsettings\b/i,
  /\.ya?ml\b/,
  /\.toml\b/,
  /\.ini\b/,
  /\bcosmiconfig\b/,
  /\brc-config\b/,
];

const SERIALIZATION_PATTERNS = [
  /JSON\.parse/,
  /JSON\.stringify/,
  /\byaml\.parse\b/,
  /\byaml\.load\b/,
  /\btoml\.parse\b/,
  /\bsuperjson\b/,
  /\bprotobuf\b/,
  /\bmsgpack\b/,
];

const IPC_PATTERNS = [
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bworker_threads\b/,
  /\bpostMessage\b/,
  /\bprocess\.send\b/,
];

const UI_INPUT_PATTERNS = [
  /\bdocument\.getElementById\b/,
  /\bquerySelector\b/,
  /\b\.value\b/,
  /\bevent\.target\b/,
  /\bformData\b/i,
  /\binputRef\b/,
  /\buseInput\b/,
];

/**
 * Classify a boundary type from expression text.
 */
export function classifyBoundaryType(expression: string): BoundaryType {
  if (NETWORK_PATTERNS.some((pat) => pat.test(expression))) {
    return "network";
  }
  if (FILESYSTEM_PATTERNS.some((pat) => pat.test(expression))) {
    return "filesystem";
  }
  if (ENV_PATTERNS.some((pat) => pat.test(expression))) {
    return "env";
  }
  if (SERIALIZATION_PATTERNS.some((pat) => pat.test(expression))) {
    return "serialization";
  }
  if (IPC_PATTERNS.some((pat) => pat.test(expression))) {
    return "IPC";
  }
  if (UI_INPUT_PATTERNS.some((pat) => pat.test(expression))) {
    return "UI-input";
  }
  if (CONFIG_PATTERNS.some((pat) => pat.test(expression))) {
    return "config";
  }
  return "unknown";
}

/**
 * Classify trust level based on boundary type and context.
 */
export function classifyTrustLevel(
  boundaryType: BoundaryType,
  context: { isTestFile: boolean; isConfigFile: boolean; isBenchmarkFile: boolean },
): TrustLevel {
  // Test and benchmark files are trusted local
  if (context.isTestFile || context.isBenchmarkFile) {
    return "trusted-local";
  }

  // Config files reading local config are semi-trusted
  if (context.isConfigFile) {
    return "semi-trusted-external";
  }

  switch (boundaryType) {
    case "network": {
      return "untrusted-external";
    }
    case "UI-input": {
      return "untrusted-external";
    }
    case "env": {
      return "semi-trusted-external";
    }
    case "filesystem": {
      return "semi-trusted-external";
    }
    case "serialization": {
      return "semi-trusted-external";
    }
    case "IPC": {
      return "semi-trusted-external";
    }
    case "config": {
      return "trusted-local";
    }
    case "trusted-local": {
      return "trusted-local";
    }
    default: {
      return "unknown";
    }
  }
}

/** File-level context detection patterns */
const TEST_FILE_PATTERN = /\.(test|spec|__tests__)\./i;
const CONFIG_FILE_PATTERN = /\b(config|settings|rc)\b/i;
const BENCHMARK_FILE_PATTERN = /\b(bench|benchmark|perf)\b/i;

/**
 * Determine file-level context for trust classification.
 */
export function getFileContext(filePath: string): {
  isTestFile: boolean;
  isConfigFile: boolean;
  isBenchmarkFile: boolean;
} {
  return {
    isBenchmarkFile: BENCHMARK_FILE_PATTERN.test(filePath),
    isConfigFile: CONFIG_FILE_PATTERN.test(filePath),
    isTestFile: TEST_FILE_PATTERN.test(filePath),
  };
}
