import type { GraphNode, ResolvedEntrypoint } from "./types.js";
import type { Project, SourceFile } from "ts-morph";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Declaration file extensions to try when resolving reference path directives */
const DTS_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"] as const;

export interface WalkOptions {
  /**
   * If true, follow cross-package type references into sibling @types/* packages.
   * This allows more complete coverage for packages that re-export from @types.
   */
  followSiblingTypes?: boolean;
  /**
   * Additional package directories that should be considered "in-scope" for traversal.
   * Used to include @types/* sibling packages in the analysis.
   */
  additionalPkgDirs?: string[];
}

export interface WalkResult {
  nodes: Map<string, GraphNode>;
  /** Number of import/reference edges that pointed outside the package directory */
  crossPackageTypeRefs: number;
}

interface WalkContext {
  project: Project;
  normalizedPkgDir: string;
  inScopeDirs: string[];
}

/**
 * Walk the declaration import graph via BFS from resolved entrypoints.
 * Follows:
 * - import/export statements (including `import type`)
 * - `/// <reference path="...">` directives (resolved with .d.ts/.d.mts/.d.cts fallback)
 * - `/// <reference types="...">` directives
 * Only includes files within the package directory (and any additional dirs).
 * Cross-package references are counted but not followed (unless followSiblingTypes is set).
 */
export interface WalkInput {
  entrypoints: ResolvedEntrypoint[];
  project: Project;
  pkgDir: string;
  options?: WalkOptions;
}

export function walkDeclarationGraph(input: WalkInput): WalkResult {
  const { entrypoints, project, pkgDir, options } = input;
  const nodes = new Map<string, GraphNode>();

  // Normalize pkgDir for path prefix matching
  const normalizedPkgDir = pkgDir.endsWith("/") ? pkgDir : `${pkgDir}/`;

  // Build list of all in-scope directories for path matching
  const inScopeDirs = [normalizedPkgDir];
  if (options?.additionalPkgDirs) {
    for (const dir of options.additionalPkgDirs) {
      const normalized = dir.endsWith("/") ? dir : `${dir}/`;
      inScopeDirs.push(normalized);
    }
  }

  const ctx: WalkContext = { inScopeDirs, normalizedPkgDir, project };

  // Initialize BFS queue with entrypoints
  const queue: { filePath: string; depth: number; subpath: string }[] = [];

  for (const ep of entrypoints) {
    const sf = project.getSourceFile(ep.filePath);
    if (!sf) {
      continue;
    }

    const absPath = sf.getFilePath();
    if (!inScopeDirs.some((dir) => absPath.startsWith(dir))) {
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
  let crossPackageTypeRefs = 0;
  while (head < queue.length) {
    const { filePath, depth, subpath } = queue[head]!;
    head++;

    const sf = project.getSourceFile(filePath);
    if (!sf) {
      continue;
    }

    // Collect all referenced files: imports/exports + reference directives
    const refs = collectAllReferences(sf, ctx);
    crossPackageTypeRefs += refs.crossPackageCount;

    for (const refPath of refs.inScope) {
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

  return { crossPackageTypeRefs, nodes };
}

interface CollectedRefs {
  inScope: string[];
  crossPackageCount: number;
}

function collectAllReferences(sf: SourceFile, ctx: WalkContext): CollectedRefs {
  const seen = new Set<string>();
  const inScope: string[] = [];
  let crossPackageCount = 0;

  function addRef(absPath: string): void {
    if (seen.has(absPath)) {
      return;
    }
    seen.add(absPath);
    if (ctx.inScopeDirs.some((dir) => absPath.startsWith(dir))) {
      inScope.push(absPath);
    } else {
      crossPackageCount++;
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
    const resolved = resolveReferencePath(fileDir, rawPath, ctx.project);
    if (resolved) {
      addRef(resolved);
    }
  }

  // 3. /// <reference types="..." /> directives
  for (const ref of sf.getTypeReferenceDirectives()) {
    const typesName = ref.getFileName();
    // Try to find the referenced types file within the same package
    const resolved = resolveReferenceTypes(typesName, ctx.normalizedPkgDir, ctx.project);
    if (resolved) {
      addRef(resolved);
    }
  }

  return { crossPackageCount, inScope };
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
 * Looks for the types within the package's own files first, then
 * checks `@types/<name>/index.d.ts` in the node_modules tree for
 * non-relative references (e.g., `/// <reference types="node" />`).
 */
interface ResolveTypesInput {
  typesName: string;
  normalizedPkgDir: string;
  project: Project;
}

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
    return null;
  }

  // Non-relative reference — look for @types/<name>/index.d.ts in node_modules
  return resolveAtTypesPackage({ normalizedPkgDir, project, typesName });
}

/**
 * Resolve a non-relative `/// <reference types="..." />` to an @types package.
 * Walks up the directory tree looking for node_modules/@types/<name>/index.d.ts.
 */
function resolveAtTypesPackage(input: ResolveTypesInput): string | null {
  const { typesName, normalizedPkgDir, project } = input;

  // Walk up from the package directory looking for node_modules
  let searchDir = normalizedPkgDir.endsWith("/") ? normalizedPkgDir.slice(0, -1) : normalizedPkgDir;

  // Limit traversal depth to avoid infinite loops
  const maxDepth = 10;
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = resolve(searchDir, "node_modules", "@types", typesName, "index.d.ts");
    if (existsSync(candidate)) {
      // Try to get existing source file, or add it to the project
      const sf = project.getSourceFile(candidate) ?? project.addSourceFileAtPath(candidate);
      return sf.getFilePath();
    }

    const parent = dirname(searchDir);
    if (parent === searchDir) {
      break;
    }
    searchDir = parent;
  }

  return null;
}
