import type { DeclarationGraph, GraphStats, ResolvedEntrypoint } from "./types.js";
import { type WalkOptions, walkDeclarationGraph } from "./walker.js";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
  "dist/index.d.ts",
  "lib/index.d.ts",
  "build/index.d.ts",
  "types/index.d.ts",
  "typings/index.d.ts",
  "dist/types/index.d.ts",
  "dist/typings/index.d.ts",
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
