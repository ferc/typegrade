import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Classification of a CLI target argument */
export type TargetKind = "workspace" | "repo" | "package-path" | "package-spec" | "invalid";

/** Classified target with resolved metadata */
export interface ClassifiedTarget {
  /** Original argument as provided by user */
  raw: string;
  /** Classification */
  kind: TargetKind;
  /** Resolved absolute path (for local targets) */
  resolvedPath?: string;
  /** Error message for invalid targets */
  error?: string;
}

/**
 * Classify a CLI positional argument as a target kind.
 *
 * Rules:
 * - Starts with `.`, `/`, or exists on disk → local path
 *   - Has pnpm-workspace.yaml or package.json with workspaces → workspace
 *   - Has tsconfig.json or src/ directory → repo (source project)
 *   - Has package.json with types/typings → package-path (local package surface)
 *   - Otherwise → repo (default for existing paths)
 * - Does not resolve locally → package-spec (npm package name)
 */
export function classifyTarget(raw: string): ClassifiedTarget {
  const isLocalRef = raw.startsWith(".") || raw.startsWith("/") || existsSync(raw);

  if (!isLocalRef) {
    // Validate as npm package spec: must not contain suspicious characters
    if (/^[@a-z0-9][\w./@-]*$/i.test(raw)) {
      return { kind: "package-spec", raw };
    }
    return { error: `"${raw}" is not a local path or valid package name`, kind: "invalid", raw };
  }

  const absPath = resolve(raw);
  if (!existsSync(absPath)) {
    return { error: `Path "${raw}" does not exist`, kind: "invalid", raw };
  }

  // Check for workspace root indicators
  if (isWorkspaceRoot(absPath)) {
    return { kind: "workspace", raw, resolvedPath: absPath };
  }

  // Paths inside node_modules are always packages, never source projects
  // (tsconfig.json / src/ inside node_modules are false positives for repo detection)
  if (absPath.includes("/node_modules/")) {
    return { kind: "package-path", raw, resolvedPath: absPath };
  }

  // Check for source project indicators
  if (isSourceProject(absPath)) {
    return { kind: "repo", raw, resolvedPath: absPath };
  }

  // Check for local package surface (has package.json with types info)
  if (isLocalPackageSurface(absPath)) {
    return { kind: "package-path", raw, resolvedPath: absPath };
  }

  // Default: treat existing paths as repos
  return { kind: "repo", raw, resolvedPath: absPath };
}

/** Check if a path is a workspace root (monorepo) */
function isWorkspaceRoot(absPath: string): boolean {
  if (existsSync(join(absPath, "pnpm-workspace.yaml"))) {
    return true;
  }

  const pkgJsonPath = join(absPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
      if (Array.isArray(pkg["workspaces"])) {
        return true;
      }
      // Yarn/npm workspaces can also be { packages: [...] }
      if (
        typeof pkg["workspaces"] === "object" &&
        pkg["workspaces"] !== null &&
        Array.isArray((pkg["workspaces"] as Record<string, unknown>)["packages"])
      ) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

/** Check if a path looks like a source project */
function isSourceProject(absPath: string): boolean {
  if (existsSync(join(absPath, "tsconfig.json"))) {
    return true;
  }
  if (existsSync(join(absPath, "src"))) {
    return true;
  }
  return false;
}

/** Check if a path looks like a local package surface (declaration-oriented) */
function isLocalPackageSurface(absPath: string): boolean {
  const pkgJsonPath = join(absPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
    // Has explicit types/typings field → package surface
    if (pkg["types"] || pkg["typings"]) {
      return true;
    }
    // Has exports with types conditions → package surface
    if (typeof pkg["exports"] === "object" && pkg["exports"] !== null) {
      const exportsStr = JSON.stringify(pkg["exports"]);
      if (exportsStr.includes('"types"')) {
        return true;
      }
    }
  } catch {
    // Ignore parse errors
  }

  return false;
}

/** Returns true if the target is a local path (workspace, repo, or package-path) */
export function isLocalTarget(target: ClassifiedTarget): boolean {
  return target.kind === "workspace" || target.kind === "repo" || target.kind === "package-path";
}

/** Returns true if the target can be scored as a package */
export function isPackageTarget(target: ClassifiedTarget): boolean {
  return target.kind === "package-spec" || target.kind === "package-path";
}
