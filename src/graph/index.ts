import type { DeclarationGraph, GraphStats } from "./types.js";
import type { Project } from "ts-morph";
import { deduplicateGraph } from "./dedup.js";
import { resolveEntrypoints } from "./resolve.js";
import { walkDeclarationGraph } from "./walker.js";

export type {
  DeclarationGraph,
  DedupGroup,
  GraphNode,
  GraphStats,
  ResolvedEntrypoint,
} from "./types.js";
export { resolveEntrypoints } from "./resolve.js";

/**
 * Build a declaration graph for a package directory.
 *
 * 1. Resolves entrypoints from package.json
 * 2. Walks the import/reference graph via BFS
 * 3. Deduplicates equivalent modules
 * 4. Returns the final file list + stats
 */
export function buildDeclarationGraph(pkgDir: string, project: Project): DeclarationGraph {
  const entrypoints = resolveEntrypoints(pkgDir);

  // If no entrypoints found, flag fallback mode
  if (entrypoints.length === 0) {
    return {
      dedupGroups: [],
      entrypoints: [],
      filesToAnalyze: [],
      nodes: new Map(),
      stats: {
        dedupByStrategy: {},
        filesDeduped: 0,
        totalAfterDedup: 0,
        totalEntrypoints: 0,
        totalReachable: 0,
        usedFallbackGlob: true,
      },
    };
  }

  // Walk the import graph from entrypoints
  const nodes = walkDeclarationGraph(entrypoints, project, pkgDir);

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
    dedupByStrategy,
    filesDeduped: filesToRemove.size,
    totalAfterDedup: filesToAnalyze.length,
    totalEntrypoints: entrypoints.length,
    totalReachable: nodes.size,
    usedFallbackGlob: false,
  };

  return {
    dedupGroups: groups,
    entrypoints,
    filesToAnalyze,
    nodes,
    stats,
  };
}
