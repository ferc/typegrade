import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

  let pkg: Record<string, unknown> = undefined as unknown as Record<string, unknown>;
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

  // 4. Fallback: main field with companion .d.ts
  if (entrypoints.length === 0) {
    const mainField = pkg["main"] as string | undefined;
    if (mainField) {
      const dtsCompanion = findDtsCompanion(pkgDir, mainField);
      if (dtsCompanion) {
        entrypoints.push({
          condition: "main",
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
    } else if (key.startsWith(".") && value && typeof value === "object" && !Array.isArray(value)) {
      // Subpath export like "./utils" or "."
      collectExportsEntrypoints({
        currentSubpath: key,
        entrypoints,
        exports: value as Record<string, unknown>,
        pkgDir,
      });
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
    }
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

  // Direct match
  if (existsSync(fullPath)) {
    return fullPath;
  }

  // If the path already ends with a .d.ts variant, don't try further
  if (DTS_EXTENSIONS.some((ext) => relativePath.endsWith(ext))) {
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
