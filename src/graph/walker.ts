import { dirname, join, resolve } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import type { GraphNode, ResolvedEntrypoint } from "./types.js";

/**
 * Walk the declaration import graph via BFS from resolved entrypoints.
 * Follows: import/export statements, /// <reference path="..."> directives.
 * Only includes files within the package directory.
 */
export function walkDeclarationGraph(
  entrypoints: ResolvedEntrypoint[],
  project: Project,
  pkgDir: string,
): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();

  // Normalize pkgDir for path prefix matching
  const normalizedPkgDir = pkgDir.endsWith("/") ? pkgDir : `${pkgDir}/`;

  // Initialize BFS queue with entrypoints
  const queue: { filePath: string; depth: number; subpath: string }[] = [];

  for (const ep of entrypoints) {
    const sf = project.getSourceFile(ep.filePath);
    if (!sf) {
      continue;
    }

    const absPath = sf.getFilePath();
    if (!absPath.startsWith(normalizedPkgDir)) {
      continue;
    }

    if (!nodes.has(absPath)) {
      nodes.set(absPath, {
        depth: 0,
        filePath: absPath,
        isEntrypoint: true,
        reachableFrom: [ep.subpath],
      });
      queue.push({ depth: 0, filePath: absPath, subpath: ep.subpath });
    } else {
      const existing = nodes.get(absPath)!;
      if (!existing.reachableFrom.includes(ep.subpath)) {
        existing.reachableFrom.push(ep.subpath);
      }
    }
  }

  // BFS
  let head = 0;
  while (head < queue.length) {
    const { filePath, depth, subpath } = queue[head]!;
    head++;

    const sf = project.getSourceFile(filePath);
    if (!sf) {
      continue;
    }

    // Collect all referenced files: imports/exports + reference path directives
    const referencedFiles = collectAllReferences(sf, project, normalizedPkgDir);

    for (const refPath of referencedFiles) {
      if (!nodes.has(refPath)) {
        nodes.set(refPath, {
          depth: depth + 1,
          filePath: refPath,
          isEntrypoint: false,
          reachableFrom: [subpath],
        });
        queue.push({ depth: depth + 1, filePath: refPath, subpath });
      } else {
        const existing = nodes.get(refPath)!;
        if (!existing.reachableFrom.includes(subpath)) {
          existing.reachableFrom.push(subpath);
        }
        if (depth + 1 < existing.depth) {
          existing.depth = depth + 1;
        }
      }
    }
  }

  return nodes;
}

function collectAllReferences(
  sf: SourceFile,
  project: Project,
  normalizedPkgDir: string,
): string[] {
  const results: string[] = [];

  // 1. Import/export statement references
  for (const refSf of sf.getReferencedSourceFiles()) {
    const refPath = refSf.getFilePath();
    if (refPath.startsWith(normalizedPkgDir)) {
      results.push(refPath);
    }
  }

  // 2. /// <reference path="..." /> directives
  const fileDir = dirname(sf.getFilePath());
  for (const ref of sf.getPathReferenceDirectives()) {
    const resolvedPath = resolve(fileDir, ref.getFileName());
    const refSf = project.getSourceFile(resolvedPath);
    if (refSf) {
      const absPath = refSf.getFilePath();
      if (absPath.startsWith(normalizedPkgDir)) {
        results.push(absPath);
      }
    }
  }

  return results;
}
