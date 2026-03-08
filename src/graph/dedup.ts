import type { Project } from "ts-morph";
import type { DedupGroup, GraphNode, ResolvedEntrypoint } from "./types.js";

/**
 * Multi-level deduplication of declaration files.
 *
 * Level 1: Stem dedup — .d.ts/.d.mts/.d.cts and dist/esm vs dist/cjs
 * Level 2: Symbol-hash — files with identical exported symbol name sets
 * Level 3: Exports-identity — entrypoints pointing to the same subpath
 *
 * Returns dedup groups and the set of files to remove.
 */
export function deduplicateGraph(
  nodes: Map<string, GraphNode>,
  entrypoints: ResolvedEntrypoint[],
  project: Project,
): { groups: DedupGroup[]; filesToRemove: Set<string> } {
  const groups: DedupGroup[] = [];
  const filesToRemove = new Set<string>();

  // Level 1: Stem dedup
  const stemGroups = groupByStem([...nodes.keys()]);
  for (const [_stem, paths] of stemGroups) {
    if (paths.length <= 1) {
      continue;
    }
    const canonical = pickCanonicalByStem(paths);
    const duplicates = paths.filter((p) => p !== canonical);
    if (duplicates.length > 0) {
      groups.push({ canonical, duplicates, reason: "stem" });
      for (const dup of duplicates) {
        filesToRemove.add(dup);
      }
    }
  }

  // Level 2: Symbol-hash dedup (only on files surviving level 1)
  const surviving = [...nodes.keys()].filter((p) => !filesToRemove.has(p));
  const hashGroups = groupBySymbolHash(surviving, project);
  for (const [_hash, paths] of hashGroups) {
    if (paths.length <= 1) {
      continue;
    }
    const canonical = pickCanonicalByDepth(paths, nodes);
    const duplicates = paths.filter((p) => p !== canonical);
    if (duplicates.length > 0) {
      groups.push({ canonical, duplicates, reason: "symbol-hash" });
      for (const dup of duplicates) {
        filesToRemove.add(dup);
      }
    }
  }

  // Level 3: Exports-identity dedup
  const subpathEntrypoints = groupEntrypointsBySubpath(entrypoints);
  for (const [_subpath, eps] of subpathEntrypoints) {
    if (eps.length <= 1) {
      continue;
    }
    // Multiple entrypoints for the same subpath → keep only one graph branch
    const epPaths = eps.map((ep) => ep.filePath).filter((p) => !filesToRemove.has(p));
    if (epPaths.length <= 1) {
      continue;
    }

    const canonical = pickCanonicalByDepth(epPaths, nodes);
    const duplicateEntrypoints = epPaths.filter((p) => p !== canonical);

    // Remove duplicate entrypoints and files reachable ONLY from them
    for (const dupEp of duplicateEntrypoints) {
      if (!filesToRemove.has(dupEp)) {
        const reachable = findExclusivelyReachable(dupEp, canonical, nodes, filesToRemove);
        const allDups = [dupEp, ...reachable];
        groups.push({ canonical, duplicates: allDups, reason: "exports-identity" });
        for (const dup of allDups) {
          filesToRemove.add(dup);
        }
      }
    }
  }

  return { filesToRemove, groups };
}

// --- Level 1: Stem ---

function groupByStem(paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const stem = normalizeStem(p);
    const group = groups.get(stem);
    if (group) {
      group.push(p);
    } else {
      groups.set(stem, [p]);
    }
  }
  return groups;
}

function normalizeStem(path: string): string {
  // Strip .d.ts, .d.mts, .d.cts extensions
  let stem = path.replace(/\.d\.[mc]?ts$/, "");
  // Normalize dist/esm and dist/cjs to dist
  stem = stem.replaceAll(/\/dist\/(esm|cjs|es|commonjs)\//g, "/dist/");
  return stem;
}

function pickCanonicalByStem(paths: string[]): string {
  // Prefer .d.ts over .d.mts/.d.cts
  const dts = paths.find((p) => p.endsWith(".d.ts"));
  if (dts) {
    return dts;
  }
  // Prefer shorter path
  return paths.toSorted((a, b) => a.length - b.length)[0]!;
}

// --- Level 2: Symbol hash ---

function groupBySymbolHash(paths: string[], project: Project): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const sf = project.getSourceFile(p);
    if (!sf) {
      continue;
    }

    const exportedNames: string[] = [];
    for (const [name] of sf.getExportedDeclarations()) {
      exportedNames.push(name);
    }
    exportedNames.sort();
    const hash = exportedNames.join(",");

    // Only group non-empty export sets
    if (exportedNames.length === 0) {
      continue;
    }

    const group = groups.get(hash);
    if (group) {
      group.push(p);
    } else {
      groups.set(hash, [p]);
    }
  }
  return groups;
}

// --- Level 3: Exports-identity ---

function groupEntrypointsBySubpath(
  entrypoints: ResolvedEntrypoint[],
): Map<string, ResolvedEntrypoint[]> {
  const groups = new Map<string, ResolvedEntrypoint[]>();
  for (const ep of entrypoints) {
    const group = groups.get(ep.subpath);
    if (group) {
      group.push(ep);
    } else {
      groups.set(ep.subpath, [ep]);
    }
  }
  return groups;
}

/**
 * Find files reachable from dupEntrypoint but NOT from canonicalEntrypoint
 * (and not already removed).
 */
function findExclusivelyReachable(
  dupEntrypoint: string,
  canonicalEntrypoint: string,
  nodes: Map<string, GraphNode>,
  alreadyRemoved: Set<string>,
): string[] {
  const exclusive: string[] = [];

  // Get canonical entrypoint's reachable subpaths
  const canonicalNode = nodes.get(canonicalEntrypoint);
  const canonicalSubpaths = new Set(canonicalNode?.reachableFrom ?? []);

  for (const [path, node] of nodes) {
    if (path === dupEntrypoint || path === canonicalEntrypoint) {
      continue;
    }
    if (alreadyRemoved.has(path)) {
      continue;
    }

    // If this file is only reachable from the duplicate entrypoint's subpaths
    // And not from any of the canonical entrypoint's subpaths
    const reachableOnlyFromDup = node.reachableFrom.every(
      (subpath) => !canonicalSubpaths.has(subpath),
    );

    // Also check: is this file ONLY reachable from subpaths that the dup entrypoint serves?
    const dupNode = nodes.get(dupEntrypoint);
    const dupSubpaths = new Set(dupNode?.reachableFrom ?? []);
    const reachableFromDupSubpaths = node.reachableFrom.some((subpath) => dupSubpaths.has(subpath));

    if (reachableOnlyFromDup && reachableFromDupSubpaths) {
      exclusive.push(path);
    }
  }

  return exclusive;
}

// --- Shared ---

function pickCanonicalByDepth(paths: string[], nodes: Map<string, GraphNode>): string {
  // Prefer entrypoint files, then shallower depth, then .d.ts, then shorter path
  return paths.toSorted((a, b) => {
    const nodeA = nodes.get(a);
    const nodeB = nodes.get(b);

    // Entrypoints first
    if (nodeA?.isEntrypoint && !nodeB?.isEntrypoint) {
      return -1;
    }
    if (!nodeA?.isEntrypoint && nodeB?.isEntrypoint) {
      return 1;
    }

    // Shallower depth
    const depthA = nodeA?.depth ?? 999;
    const depthB = nodeB?.depth ?? 999;
    if (depthA !== depthB) {
      return depthA - depthB;
    }

    // Prefer .d.ts
    if (a.endsWith(".d.ts") && !b.endsWith(".d.ts")) {
      return -1;
    }
    if (!a.endsWith(".d.ts") && b.endsWith(".d.ts")) {
      return 1;
    }

    return a.length - b.length;
  })[0]!;
}
