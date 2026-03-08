import { existsSync, readFileSync } from "node:fs";
import type { ResolvedEntrypoint } from "./types.js";
import { join } from "node:path";

/**
 * Resolve all declaration entrypoints from a package directory.
 * Checks types, typings, exports (including subpath exports with conditions).
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

  // Check types/typings top-level fields
  const typesField = (pkg.types ?? pkg.typings) as string | undefined;
  const condition = pkg.types ? "types" : "typings";
  if (typesField && existsSync(join(pkgDir, typesField))) {
    entrypoints.push({
      condition,
      filePath: join(pkgDir, typesField),
      subpath: ".",
    });
  }

  // Check exports field
  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (exports && typeof exports === "object") {
    collectExportsEntrypoints({
      currentSubpath: ".",
      entrypoints,
      exports,
      pkgDir,
    });
  }

  return entrypoints;
}

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
      const filePath = join(pkgDir, value);
      if (existsSync(filePath)) {
        entrypoints.push({
          condition: conditionLabel(currentSubpath, "types"),
          filePath,
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
      // Condition like "import", "require", "default"
      collectExportsEntrypoints({
        currentSubpath,
        entrypoints,
        exports: value as Record<string, unknown>,
        pkgDir,
      });
    }
  }
}

function conditionLabel(subpath: string, leaf: string): string {
  return subpath === "." ? leaf : `${subpath}.${leaf}`;
}
