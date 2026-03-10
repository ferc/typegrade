import type { DeclarationGraph, GraphStats, ResolvedEntrypoint } from "./types.js";
import { type WalkOptions, walkDeclarationGraph } from "./walker.js";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Project } from "ts-morph";
import { deduplicateGraph } from "./dedup.js";
import { resolveEntrypoints } from "./resolve.js";

export type {
  DeclarationGraph,
  DedupGroup,
  GraphNode,
  GraphStats,
  ResolvedEntrypoint,
} from "./types.js";
export type { WalkInput, WalkOptions, WalkResult } from "./walker.js";
export { resolveEntrypoints } from "./resolve.js";

/** Well-known locations for declaration index files, tried in order */
const LAST_RESORT_PATHS = [
  "index.d.ts",
  "index.d.mts",
  "index.d.cts",
  "dist/index.d.ts",
  "dist/index.d.mts",
  "dist/index.d.cts",
  "lib/index.d.ts",
  "lib/index.d.mts",
  "lib/index.d.cts",
  "build/index.d.ts",
  "build/index.d.mts",
  "types/index.d.ts",
  "typings/index.d.ts",
  "dist/types/index.d.ts",
  "dist/typings/index.d.ts",
  "dist/src/index.d.ts",
  "out/index.d.ts",
  "src/index.d.ts",
  "source/index.d.ts",
  "esm/index.d.ts",
  "cjs/index.d.ts",
  "module/index.d.ts",
  "dist/esm/index.d.ts",
  "dist/cjs/index.d.ts",
  // Platform-specific and additional patterns
  "dist/node/index.d.ts",
  "dist/browser/index.d.ts",
  "dist/common/index.d.ts",
  "dist/lib/index.d.ts",
  "dist/mod.d.ts",
  "mod.d.ts",
  "output/index.d.ts",
  "release/index.d.ts",
  "pkg/index.d.ts",
  "bundle/index.d.ts",
  // Non-index declaration files at well-known locations
  "dist/types.d.ts",
  "dist/typings.d.ts",
  "types.d.ts",
  "typings.d.ts",
  "dist/main.d.ts",
  "dist/module.d.ts",
  // Additional module format directories
  "dist/es/index.d.ts",
  "dist/mjs/index.d.ts",
  "dist/umd/index.d.ts",
  // Declarations directories
  "dist/declarations/index.d.ts",
  "declarations/index.d.ts",
] as const;

/**
 * Build a declaration graph for a package directory.
 *
 * 1. Resolves entrypoints from package.json (types, typings, exports, typesVersions, main, @types)
 * 2. If nothing found, tries last-resort well-known paths before giving up
 * 3. Walks the import/reference graph via BFS
 * 4. Deduplicates equivalent modules
 * 5. Returns the final file list + stats
 */
export interface BuildGraphOptions {
  /** Follow sibling @types/* packages for more complete coverage */
  followSiblingTypes?: boolean;
}

export function buildDeclarationGraph(
  pkgDir: string,
  project: Project,
  options?: BuildGraphOptions,
): DeclarationGraph {
  let entrypoints = resolveEntrypoints(pkgDir);
  let fallbackReason: string | undefined = undefined;

  // If no entrypoints found via package.json resolution, try last-resort well-known paths
  if (entrypoints.length === 0) {
    const lastResort = tryLastResortPaths(pkgDir);
    if (lastResort) {
      entrypoints = [lastResort.entrypoint];
      fallbackReason = lastResort.reason;
    }
  }

  // Detect and include sibling @types/* packages for better coverage
  const walkOptions: WalkOptions = {};
  if (options?.followSiblingTypes) {
    const siblingDirs = findSiblingTypePackages(pkgDir);
    if (siblingDirs.length > 0) {
      walkOptions.additionalPkgDirs = siblingDirs;
      walkOptions.followSiblingTypes = true;
      // Also resolve entrypoints from sibling @types packages
      for (const sibDir of siblingDirs) {
        const sibEntrypoints = resolveEntrypoints(sibDir);
        entrypoints.push(...sibEntrypoints);
      }
    }
  }

  // Include sibling .d.ts files in the same directory as existing entrypoints.
  // Pick up ambient declarations like globals.d.ts and types.d.ts.
  // These are not explicitly imported but live alongside the main entrypoint.
  entrypoints = addSiblingDeclarationEntrypoints(entrypoints);

  // If still nothing, return empty graph
  if (entrypoints.length === 0) {
    return {
      dedupGroups: [],
      entrypoints: [],
      filesToAnalyze: [],
      nodes: new Map(),
      stats: {
        dedupByStrategy: {},
        fallbackReason: "no-entrypoints-found",
        filesDeduped: 0,
        totalAfterDedup: 0,
        totalEntrypoints: 0,
        totalReachable: 0,
        usedFallbackGlob: true,
      },
    };
  }

  // Walk the import graph from entrypoints
  const walkResult = walkDeclarationGraph({
    entrypoints,
    options: walkOptions,
    pkgDir,
    project,
  });
  const { nodes, crossPackageTypeRefs } = walkResult;

  // Deduplicate
  const { groups, filesToRemove } = deduplicateGraph(nodes, entrypoints, project);

  // Final file list: all reachable minus deduped
  const filesToAnalyze = [...nodes.keys()].filter((fp) => !filesToRemove.has(fp));

  // Compute stats
  const dedupByStrategy: Record<string, number> = {};
  for (const grp of groups) {
    dedupByStrategy[grp.reason] = (dedupByStrategy[grp.reason] ?? 0) + grp.duplicates.length;
  }

  const stats: GraphStats = {
    crossPackageTypeRefs,
    dedupByStrategy,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    filesDeduped: filesToRemove.size,
    totalAfterDedup: filesToAnalyze.length,
    totalEntrypoints: entrypoints.length,
    totalReachable: nodes.size,
    usedFallbackGlob: fallbackReason !== undefined,
  };

  return {
    dedupGroups: groups,
    entrypoints,
    filesToAnalyze,
    nodes,
    stats,
  };
}

/**
 * Find the sibling @types/* package that corresponds to the package being
 * analyzed. For example, if pkgDir points at `express`, this returns
 * `node_modules/@types/express` when it exists.
 *
 * Scoped packages use the DefinitelyTyped naming convention:
 *   `@scope/pkg` -> `@types/scope__pkg`
 */
function findSiblingTypePackages(pkgDir: string): string[] {
  try {
    // Read the package name from the package being analyzed
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      return [];
    }

    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      name?: string;
    };
    if (!pkg.name) {
      return [];
    }

    // Determine the node_modules root
    const parentDir = dirname(pkgDir);
    const parentName = basename(parentDir);

    // For scoped packages (node_modules/@scope/pkg), go up two levels
    const nodeModulesRoot = parentName === "node_modules" ? parentDir : dirname(parentDir);
    if (basename(nodeModulesRoot) !== "node_modules") {
      return [];
    }

    // Convert package name to @types convention:
    //   "express"      -> "express"
    //   "@scope/pkg"   -> "scope__pkg"
    const typesName = pkg.name.startsWith("@") ? pkg.name.slice(1).replace("/", "__") : pkg.name;

    const typePkgDir = join(nodeModulesRoot, "@types", typesName);
    if (existsSync(typePkgDir)) {
      return [typePkgDir];
    }

    return [];
  } catch {
    // Ignore filesystem errors
    return [];
  }
}

/** Well-known sibling declaration file names that packages commonly include */
const SIBLING_DTS_NAMES = new Set([
  "globals.d.ts",
  "types.d.ts",
  "ambient.d.ts",
  "global.d.ts",
  "typings.d.ts",
  "declarations.d.ts",
  "interfaces.d.ts",
  "env.d.ts",
]);

/**
 * Scan entrypoint directories for sibling .d.ts files that are not already in
 * the entrypoint list. Only adds well-known sibling names to avoid pulling in
 * unrelated declaration files.
 */
function addSiblingDeclarationEntrypoints(entrypoints: ResolvedEntrypoint[]): ResolvedEntrypoint[] {
  if (entrypoints.length === 0) {
    return entrypoints;
  }

  // Collect all existing entrypoint file paths for dedup
  const existingPaths = new Set(entrypoints.map((ep) => ep.filePath));

  // Collect unique directories from existing entrypoints
  const entrypointDirs = new Set<string>();
  for (const ep of entrypoints) {
    entrypointDirs.add(dirname(ep.filePath));
  }

  const siblings: ResolvedEntrypoint[] = [];
  for (const dir of entrypointDirs) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!SIBLING_DTS_NAMES.has(file)) {
          continue;
        }
        const fullPath = join(dir, file);
        if (existingPaths.has(fullPath)) {
          continue;
        }
        if (existsSync(fullPath)) {
          siblings.push({
            condition: "sibling-declaration",
            filePath: fullPath,
            subpath: ".",
          });
          existingPaths.add(fullPath);
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  if (siblings.length === 0) {
    return entrypoints;
  }

  return [...entrypoints, ...siblings];
}

/**
 * Try well-known declaration file locations as a last resort.
 * Returns the first match with a reason string for diagnostics.
 */
function tryLastResortPaths(
  pkgDir: string,
): { entrypoint: ResolvedEntrypoint; reason: string } | null {
  for (const relPath of LAST_RESORT_PATHS) {
    const fullPath = join(pkgDir, relPath);
    if (existsSync(fullPath)) {
      return {
        entrypoint: {
          condition: "last-resort",
          filePath: fullPath,
          subpath: ".",
        },
        reason: `last-resort:${relPath}`,
      };
    }
  }
  return null;
}
