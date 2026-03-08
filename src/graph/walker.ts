import type { GraphNode, ResolvedEntrypoint } from "./types.js";
import type { Project, SourceFile } from "ts-morph";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Declaration file extensions to try when resolving reference path directives */
const DTS_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"] as const;

/**
 * Walk the declaration import graph via BFS from resolved entrypoints.
 * Follows:
 * - import/export statements (including `import type`)
 * - `/// <reference path="...">` directives (resolved with .d.ts/.d.mts/.d.cts fallback)
 * - `/// <reference types="...">` directives
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

    if (nodes.has(absPath)) {
      const existing = nodes.get(absPath)!;
      if (!existing.reachableFrom.includes(ep.subpath)) {
        existing.reachableFrom.push(ep.subpath);
      }
    } else {
      nodes.set(absPath, {
        depth: 0,
        filePath: absPath,
        isEntrypoint: true,
        reachableFrom: [ep.subpath],
      });
      queue.push({ depth: 0, filePath: absPath, subpath: ep.subpath });
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

    // Collect all referenced files: imports/exports + reference directives
    const referencedFiles = collectAllReferences(sf, project, normalizedPkgDir);

    for (const refPath of referencedFiles) {
      if (nodes.has(refPath)) {
        const existing = nodes.get(refPath)!;
        if (!existing.reachableFrom.includes(subpath)) {
          existing.reachableFrom.push(subpath);
        }
        if (depth + 1 < existing.depth) {
          existing.depth = depth + 1;
        }
      } else {
        nodes.set(refPath, {
          depth: depth + 1,
          filePath: refPath,
          isEntrypoint: false,
          reachableFrom: [subpath],
        });
        queue.push({ depth: depth + 1, filePath: refPath, subpath });
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
  const seen = new Set<string>();
  const results: string[] = [];

  function addRef(absPath: string): void {
    if (absPath.startsWith(normalizedPkgDir) && !seen.has(absPath)) {
      seen.add(absPath);
      results.push(absPath);
    }
  }

  // 1. Import/export statement references (includes type-only imports)
  // Ts-morph's getReferencedSourceFiles() follows both value and type-only imports/exports.
  for (const refSf of sf.getReferencedSourceFiles()) {
    addRef(refSf.getFilePath());
  }

  const fileDir = dirname(sf.getFilePath());

  // 2. /// <reference path="..." /> directives
  // GetPathReferenceDirectives() is the correct API (getReferencedSourceFiles does NOT follow these)
  for (const ref of sf.getPathReferenceDirectives()) {
    const rawPath = ref.getFileName();
    const resolved = resolveReferencePath(fileDir, rawPath, project);
    if (resolved) {
      addRef(resolved);
    }
  }

  // 3. /// <reference types="..." /> directives
  for (const ref of sf.getTypeReferenceDirectives()) {
    const typesName = ref.getFileName();
    // Try to find the referenced types file within the same package
    const resolved = resolveReferenceTypes(typesName, normalizedPkgDir, project);
    if (resolved) {
      addRef(resolved);
    }
  }

  return results;
}

/**
 * Resolve a `/// <reference path="..." />` directive to an absolute file path.
 * Handles .d.ts, .d.mts, .d.cts extensions gracefully.
 */
function resolveReferencePath(fileDir: string, rawPath: string, project: Project): string | null {
  // Direct resolve
  const directPath = resolve(fileDir, rawPath);
  const directSf = project.getSourceFile(directPath);
  if (directSf) {
    return directSf.getFilePath();
  }

  // If the path doesn't already end with a declaration extension, try adding them
  if (!DTS_EXTENSIONS.some((ext) => rawPath.endsWith(ext))) {
    const stripped = rawPath.replace(/\.[mc]?ts$/, "").replace(/\.[mc]?js$/, "");
    for (const ext of DTS_EXTENSIONS) {
      const candidate = resolve(fileDir, `${stripped}${ext}`);
      if (existsSync(candidate)) {
        const refSf = project.getSourceFile(candidate) ?? project.addSourceFileAtPath(candidate);
        return refSf.getFilePath();
      }
    }
  }

  return null;
}

/**
 * Resolve a `/// <reference types="..." />` directive.
 * Looks for the types within the package's own files (e.g., a globals.d.ts).
 */
function resolveReferenceTypes(
  typesName: string,
  normalizedPkgDir: string,
  project: Project,
): string | null {
  // Common pattern: reference types points to a file relative to the package
  // E.g., /// <reference types="./types" /> or /// <reference types="./globals" />
  if (typesName.startsWith(".")) {
    // Relative reference — resolve from package root
    for (const ext of DTS_EXTENSIONS) {
      const candidate = resolve(normalizedPkgDir, `${typesName}${ext}`);
      const sf = project.getSourceFile(candidate);
      if (sf) {
        return sf.getFilePath();
      }
    }
  }

  return null;
}
