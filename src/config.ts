import { join, resolve } from "node:path";
import type { TypegradeConfig } from "./types.js";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Supported config file names in priority order */
const CONFIG_FILE_NAMES = [
  "typegrade.config.ts",
  "typegrade.config.js",
  "typegrade.config.mjs",
] as const;

/**
 * Resolve the path to a typegrade config file in the given project directory.
 * Searches for supported config file names in priority order.
 *
 * @example
 * ```ts
 * const configPath = resolveConfigPath("/path/to/project");
 * if (configPath) {
 *   console.log(`Found config at ${configPath}`);
 * }
 * ```
 *
 * @param projectPath - Absolute or relative path to the project root
 * @returns Absolute path to the config file, or null if none found
 */
export function resolveConfigPath(projectPath: string): string | null {
  const root = resolve(projectPath);

  for (const fileName of CONFIG_FILE_NAMES) {
    const candidate = join(root, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Validate that a loaded value conforms to the expected TypegradeConfig shape.
 * Performs shallow structural checks — does not validate nested object internals.
 */
function validateConfig(raw: unknown): TypegradeConfig | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const config: TypegradeConfig = {};

  const domainVal = candidate["domain"];
  if (typeof domainVal === "string") {
    config.domain = domainVal as NonNullable<TypegradeConfig["domain"]>;
  }

  const profileVal = candidate["profile"];
  if (typeof profileVal === "string") {
    config.profile = profileVal as NonNullable<TypegradeConfig["profile"]>;
  }

  const boundariesVal = candidate["boundaries"];
  if (typeof boundariesVal === "object" && boundariesVal !== null) {
    config.boundaries = boundariesVal as NonNullable<TypegradeConfig["boundaries"]>;
  }

  const monorepoVal = candidate["monorepo"];
  if (typeof monorepoVal === "object" && monorepoVal !== null) {
    config.monorepo = monorepoVal as NonNullable<TypegradeConfig["monorepo"]>;
  }

  const suppressionsVal = candidate["suppressions"];
  if (typeof suppressionsVal === "object" && suppressionsVal !== null) {
    config.suppressions = suppressionsVal as NonNullable<TypegradeConfig["suppressions"]>;
  }

  const minScoreVal = candidate["minScore"];
  if (typeof minScoreVal === "number") {
    config.minScore = minScoreVal;
  }

  return config;
}

/**
 * Load a typegrade configuration file from the given project directory.
 * Searches for `typegrade.config.ts`, `typegrade.config.js`, or `typegrade.config.mjs`
 * and dynamically imports the default export.
 *
 * @example
 * ```ts
 * const config = await loadConfig("/path/to/project");
 * if (config) {
 *   console.log(`Domain: ${config.domain}`);
 * }
 * ```
 *
 * @param projectPath - Absolute or relative path to the project root
 * @returns Parsed config object, or null if no config file found or loading fails
 */
export async function loadConfig(projectPath: string): Promise<TypegradeConfig | null> {
  const configPath = resolveConfigPath(projectPath);
  if (configPath === null) {
    return null;
  }

  try {
    // Convert to file URL for cross-platform dynamic import compatibility
    const fileUrl = pathToFileURL(configPath).href;
    const imported = await import(fileUrl);
    const rawExport = imported.default ?? imported;
    return validateConfig(rawExport);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: failed to load config from ${configPath}: ${message}`);
    return null;
  }
}

/** Keys from TypegradeConfig that map to CLI option names */
const CONFIG_KEY_TO_CLI: Record<keyof TypegradeConfig, string> = {
  boundaries: "boundaries",
  domain: "domain",
  minScore: "minScore",
  monorepo: "monorepo",
  profile: "profile",
  suppressions: "suppressions",
};

/**
 * Merge a loaded TypegradeConfig with CLI options. CLI options take precedence
 * over config file values. Undefined CLI options fall back to config values.
 *
 * @example
 * ```ts
 * const merged = mergeConfigWithOptions(config, { domain: "validation", verbose: true });
 * ```
 *
 * @param config - Loaded config object, or null if no config file
 * @param cliOptions - CLI option values from Commander.js
 * @returns Merged configuration with CLI options taking precedence
 */
export function mergeConfigWithOptions(
  config: TypegradeConfig | null,
  cliOptions: Record<string, unknown>,
): TypegradeConfig {
  // Start from config defaults or empty object
  const base: TypegradeConfig = config === null ? {} : { ...config };

  // CLI options override config values when explicitly provided
  for (const [configKey, cliKey] of Object.entries(CONFIG_KEY_TO_CLI)) {
    const cliValue = cliOptions[cliKey];
    if (cliValue !== undefined) {
      (base as Record<string, unknown>)[configKey] = cliValue;
    }
  }

  return base;
}
