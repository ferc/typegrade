import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ResolvedEntrypoint } from "./types.js";

/** Declaration file extensions we recognize, in preference order */
const DTS_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"] as const;

/**
 * Resolve all declaration entrypoints from a package directory.
 * Checks types, typings, exports (including subpath exports with nested conditions),
 * typesVersions, main field fallback, and companion @types packages.
 */
export function resolveEntrypoints(pkgDir: string): ResolvedEntrypoint[] {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return [];
  }

  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return [];
  }

  const entrypoints: ResolvedEntrypoint[] = [];

  // 1. Check types/typings top-level fields
  const typesField = (pkg["types"] ?? pkg["typings"]) as string | undefined;
  const condition = pkg["types"] ? "types" : "typings";
  if (typesField) {
    const resolved = resolveDeclarationFile(pkgDir, typesField);
    if (resolved) {
      entrypoints.push({
        condition,
        filePath: resolved,
        subpath: ".",
      });
    }
  }

  // 2. Check exports field (with nested condition support)
  const exports = pkg["exports"] as Record<string, unknown> | undefined;
  if (exports && typeof exports === "object") {
    collectExportsEntrypoints({
      currentSubpath: ".",
      entrypoints,
      exports,
      pkgDir,
    });
  }

  // 3. Check typesVersions field
  const typesVersions = pkg["typesVersions"] as
    | Record<string, Record<string, string[]>>
    | undefined;
  if (typesVersions && typeof typesVersions === "object") {
    collectTypesVersionsEntrypoints(typesVersions, pkgDir, entrypoints);
  }

  // 4. Fallback: main or module field with companion .d.ts
  // Also triggers when exports field existed but resolved nothing valid
  const exportsResolvedNothing = exports && typeof exports === "object" && entrypoints.length === 0;
  if (entrypoints.length === 0 || exportsResolvedNothing) {
    const mainField = (pkg["main"] ?? pkg["module"]) as string | undefined;
    const fieldName = pkg["main"] ? "main" : "module";
    if (mainField) {
      const dtsCompanion = findDtsCompanion(pkgDir, mainField);
      if (dtsCompanion) {
        entrypoints.push({
          condition: fieldName,
          filePath: dtsCompanion,
          subpath: ".",
        });
      }
    }
  }

  // 5. Fallback: companion @types package
  if (entrypoints.length === 0) {
    const companionEntrypoints = resolveCompanionTypesPackage(pkgDir, pkg);
    entrypoints.push(...companionEntrypoints);
  }

  return entrypoints;
}

// --- Exports field resolution ---

interface CollectExportsOpts {
  exports: Record<string, unknown>;
  pkgDir: string;
  entrypoints: ResolvedEntrypoint[];
  currentSubpath: string;
}

function collectExportsEntrypoints(opts: CollectExportsOpts): void {
  const { exports, pkgDir, entrypoints, currentSubpath } = opts;
  for (const [key, value] of Object.entries(exports)) {
    if (key === "types" && typeof value === "string") {
      // Direct types condition
      const resolved = resolveDeclarationFile(pkgDir, value);
      if (resolved) {
        entrypoints.push({
          condition: conditionLabel(currentSubpath, "types"),
          filePath: resolved,
          subpath: currentSubpath,
        });
      }
    } else if (key === "types" && Array.isArray(value)) {
      // Array of types paths — try each in order, first match wins
      for (const item of value) {
        if (typeof item !== "string") {
          continue;
        }
        const resolved = resolveDeclarationFile(pkgDir, item);
        if (resolved) {
          entrypoints.push({
            condition: conditionLabel(currentSubpath, "types"),
            filePath: resolved,
            subpath: currentSubpath,
          });
          break;
        }
      }
    } else if (
      key.startsWith(".") &&
      !key.includes("*") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Subpath export like "./utils" or "."
      collectExportsEntrypoints({
        currentSubpath: key,
        entrypoints,
        exports: value as Record<string, unknown>,
        pkgDir,
      });
    } else if (key.startsWith(".") && typeof value === "string") {
      // Direct string subpath export (e.g., "./utils": "./dist/utils.d.ts")
      const resolved = resolveDeclarationFile(pkgDir, value);
      if (resolved) {
        entrypoints.push({
          condition: conditionLabel(currentSubpath, "direct"),
          filePath: resolved,
          subpath: key,
        });
      }
    } else if (
      key.startsWith(".") &&
      key.includes("*") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Wildcard subpath pattern like "./*" — resolve the types condition within
      resolveWildcardSubpathExport({
        conditions: value as Record<string, unknown>,
        entrypoints,
        pattern: key,
        pkgDir,
      });
    } else if (key.startsWith(".") && Array.isArray(value)) {
      // Array subpath export — delegate to helper to avoid excessive nesting
      collectArraySubpathExport({ entrypoints, items: value, pkgDir, subpath: key });
    } else if (
      !key.startsWith(".") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Nested condition like "import", "require", "default" — recurse to find types within
      collectExportsEntrypoints({
        currentSubpath,
        entrypoints,
        exports: value as Record<string, unknown>,
        pkgDir,
      });
    } else if (
      !key.startsWith(".") &&
      typeof value === "string" &&
      (key === "default" || key === "import" || key === "require")
    ) {
      // Condition string value — try resolving as declaration file
      const resolved = resolveDeclarationFile(pkgDir, value);
      if (resolved) {
        entrypoints.push({
          condition: conditionLabel(currentSubpath, key),
          filePath: resolved,
          subpath: currentSubpath,
        });
      }
    }
  }
}

/**
 * Handle an array-valued subpath export entry.
 * Tries each element in order: strings are resolved as declaration files,
 * objects are recursed into as nested condition maps.
 */
function collectArraySubpathExport(opts: {
  items: unknown[];
  pkgDir: string;
  entrypoints: ResolvedEntrypoint[];
  subpath: string;
}): void {
  const { items, pkgDir, entrypoints, subpath } = opts;
  for (const item of items) {
    if (typeof item === "string") {
      const resolved = resolveDeclarationFile(pkgDir, item);
      if (resolved) {
        entrypoints.push({
          condition: conditionLabel(subpath, "direct"),
          filePath: resolved,
          subpath,
        });
        break;
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      // Nested condition object inside array
      collectExportsEntrypoints({
        currentSubpath: subpath,
        entrypoints,
        exports: item as Record<string, unknown>,
        pkgDir,
      });
    }
  }
}

// --- Wildcard subpath resolution ---

/**
 * Resolve wildcard subpath exports like "./*": { "types": "./dist/*.d.ts" }.
 * Expands the wildcard by scanning the target directory for matching declaration files.
 */
function resolveWildcardSubpathExport(opts: {
  pattern: string;
  conditions: Record<string, unknown>;
  pkgDir: string;
  entrypoints: ResolvedEntrypoint[];
}): void {
  const { pattern, conditions, pkgDir, entrypoints } = opts;

  // Extract the types condition from the nested object
  const typesTarget = conditions["types"];
  if (typeof typesTarget !== "string" || !typesTarget.includes("*")) {
    // Fall back to regular nested resolution if no wildcard types
    collectExportsEntrypoints({
      currentSubpath: pattern,
      entrypoints,
      exports: conditions,
      pkgDir,
    });
    return;
  }

  // Split the types target around * to get prefix and suffix
  const [targetPrefix, targetSuffix] = typesTarget.split("*");
  if (targetPrefix === undefined || targetSuffix === undefined) {
    return;
  }

  // Resolve the directory from the prefix
  const targetDir = join(pkgDir, targetPrefix);
  if (!existsSync(targetDir)) {
    return;
  }

  // Scan for matching declaration files
  try {
    const entries = readdirSync(targetDir);
    for (const entry of entries) {
      const entryName = String(entry);
      if (!entryName.endsWith(targetSuffix)) {
        continue;
      }
      const stem = entryName.slice(0, entryName.length - targetSuffix.length);
      const filePath = join(targetDir, entryName);
      if (existsSync(filePath)) {
        const subpath = pattern.replace("*", stem);
        entrypoints.push({
          condition: conditionLabel(subpath, "types"),
          filePath,
          subpath,
        });
      }
    }
  } catch {
    // Directory scan failed — skip wildcard expansion
  }
}

// --- typesVersions resolution ---

/**
 * Parse the typesVersions field and resolve version-specific type entrypoints.
 * Format: { ">=4.0": { "*": ["dist/types/*"] }, ... }
 * We pick the first version range (TypeScript convention: most specific first).
 */
function collectTypesVersionsEntrypoints(
  typesVersions: Record<string, Record<string, string[]>>,
  pkgDir: string,
  entrypoints: ResolvedEntrypoint[],
): void {
  // Use the first (most specific) version range
  const versionRanges = Object.keys(typesVersions);
  if (versionRanges.length === 0) {
    return;
  }

  // Prefer the wildcard "*" range, otherwise take the first
  const selectedRange = versionRanges.find((range) => range === "*") ?? versionRanges[0]!;
  const pathMappings = typesVersions[selectedRange];
  if (!pathMappings || typeof pathMappings !== "object") {
    return;
  }

  for (const [pattern, targets] of Object.entries(pathMappings)) {
    if (!Array.isArray(targets)) {
      continue;
    }

    // For the root pattern ("." or "*"), resolve to a concrete file
    if (pattern === "." || pattern === "*") {
      for (const target of targets) {
        if (typeof target !== "string") {
          continue;
        }
        // If target contains *, it's a wildcard mapping — try to resolve index
        const concreteTarget = target.includes("*") ? target.replace("*", "index") : target;
        const resolved = resolveDeclarationFile(pkgDir, concreteTarget);
        if (resolved) {
          entrypoints.push({
            condition: `typesVersions[${selectedRange}]`,
            filePath: resolved,
            subpath: ".",
          });
          // First matching target wins
          break;
        }
      }
    } else {
      // Named subpath pattern like "./utils" or "utils"
      const subpath = pattern.startsWith(".") ? pattern : `./${pattern}`;
      for (const target of targets) {
        if (typeof target !== "string") {
          continue;
        }
        const concreteTarget = target.includes("*") ? target.replace("*", "index") : target;
        const resolved = resolveDeclarationFile(pkgDir, concreteTarget);
        if (resolved) {
          entrypoints.push({
            condition: `typesVersions[${selectedRange}]`,
            filePath: resolved,
            subpath,
          });
          break;
        }
      }
    }
  }
}

// --- Companion @types resolution ---

/**
 * If the package itself has no types, check for @types/packageName
 * in the same node_modules directory.
 */
function resolveCompanionTypesPackage(
  pkgDir: string,
  pkg: Record<string, unknown>,
): ResolvedEntrypoint[] {
  const packageName = pkg["name"] as string | undefined;
  if (!packageName) {
    return [];
  }

  // Determine the @types package name
  const typesPackageName = packageName.startsWith("@")
    ? `@types/${packageName.slice(1).replace("/", "__")}`
    : `@types/${packageName}`;

  // Look in the parent node_modules
  const nodeModulesDir = dirname(pkgDir);
  const parentBasename = basename(nodeModulesDir);
  if (parentBasename !== "node_modules") {
    // For scoped packages, go up one more level
    const grandparent = dirname(nodeModulesDir);
    if (basename(grandparent) !== "node_modules") {
      return [];
    }
  }

  // Resolve the node_modules root for @types lookup
  // PkgDir could be node_modules/pkg or node_modules/@scope/pkg
  const nodeModulesRoot =
    parentBasename === "node_modules" ? nodeModulesDir : dirname(nodeModulesDir);

  const typesDir = join(nodeModulesRoot, typesPackageName);
  if (!existsSync(typesDir)) {
    return [];
  }

  // Recursively resolve the @types package's own entrypoints
  return resolveEntrypoints(typesDir).map((ep) =>
    Object.assign(ep, { condition: `@types/${ep.condition}` }),
  );
}

// --- Helpers ---

/**
 * Resolve a declaration file path, handling .d.ts / .d.mts / .d.cts extensions.
 * If the path directly exists, returns it. Otherwise tries adding declaration extensions.
 */
function resolveDeclarationFile(pkgDir: string, relativePath: string): string | null {
  const fullPath = join(pkgDir, relativePath);
  const isDts = DTS_EXTENSIONS.some((ext) => relativePath.endsWith(ext));

  // Direct match — only if it's actually a declaration file
  if (isDts && existsSync(fullPath)) {
    return fullPath;
  }

  // If the path ends with a .d.ts variant but doesn't exist, don't try further
  if (isDts) {
    return null;
  }

  // Strip .js / .mjs / .cjs and try .d.ts / .d.mts / .d.cts
  const stripped = relativePath.replace(/\.[mc]?js$/, "");
  for (const ext of DTS_EXTENSIONS) {
    const candidate = join(pkgDir, `${stripped}${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Try appending /index.d.ts (directory-as-module)
  for (const ext of DTS_EXTENSIONS) {
    const candidate = join(pkgDir, relativePath, `index${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Given a main field (e.g., "dist/index.js"), find a companion .d.ts file.
 */
function findDtsCompanion(pkgDir: string, mainField: string): string | null {
  // Strip JS extension and try declaration extensions
  const stripped = mainField.replace(/\.[mc]?js$/, "");
  for (const ext of DTS_EXTENSIONS) {
    const candidate = join(pkgDir, `${stripped}${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function conditionLabel(subpath: string, leaf: string): string {
  return subpath === "." ? leaf : `${subpath}.${leaf}`;
}
