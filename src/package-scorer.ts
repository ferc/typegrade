import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AnalysisResult, PackageAnalysisContext } from "./types.js";
import { analyzeProject } from "./analyzer.js";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

function parsePackageSpec(spec: string): { name: string; version: string } {
  // Handle scoped packages: @scope/pkg@1.0.0
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx > 0) {
      const afterSlash = spec.slice(slashIdx + 1);
      const atIdx = afterSlash.indexOf("@");
      if (atIdx > 0) {
        return {
          name: spec.slice(0, slashIdx + 1 + atIdx),
          version: afterSlash.slice(atIdx + 1),
        };
      }
    }
    return { name: spec, version: "latest" };
  }
  // Unscoped: pkg@1.0.0
  const atIdx = spec.indexOf("@");
  if (atIdx > 0) {
    return { name: spec.slice(0, atIdx), version: spec.slice(atIdx + 1) };
  }
  return { name: spec, version: "latest" };
}

export function scorePackage(nameOrPath: string): AnalysisResult {
  // Local path — analyze directly, including .d.ts files
  if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || existsSync(nameOrPath)) {
    return analyzeProject(resolve(nameOrPath), {
      mode: "package",
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
  }

  // Parse name@version spec
  const { name: packageName, version: packageVersion } = parsePackageSpec(nameOrPath);

  // Npm package — install to temp dir
  const tmpDir = join(tmpdir(), `tsguard-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: {
          [packageName]: packageVersion,
        },
        name: "tsguard-tmp",
        version: "0.0.0",
      }),
    );

    execSync("npm install --ignore-scripts --no-audit --no-fund", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 60_000,
    });

    const pkgDir = join(tmpDir, "node_modules", packageName);
    let typesPackageName: string | undefined;

    if (existsSync(pkgDir)) {
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      if (!pkgJson.types && !pkgJson.typings && !pkgJson.exports) {
        typesPackageName = packageName.startsWith("@")
          ? `@types/${packageName.slice(1).replace("/", "__")}`
          : `@types/${packageName}`;

        try {
          execSync(`npm install ${typesPackageName} --ignore-scripts --no-audit --no-fund`, {
            cwd: tmpDir,
            stdio: "pipe",
            timeout: 30_000,
          });
        } catch {
          typesPackageName = undefined;
        }
      }
    }

    // Resolve the actual package directory to use for declarations
    const effectivePkgDir = typesPackageName
      ? join(tmpDir, "node_modules", typesPackageName)
      : pkgDir;
    const effectivePkgName = typesPackageName ?? packageName;

    // Resolve declaration entrypoints from package.json
    const entrypoints = resolveDeclarationEntrypoints(effectivePkgDir);
    let includePaths: string[];

    if (entrypoints.length > 0) {
      // Use resolved entrypoints — more accurate than globbing everything
      includePaths = entrypoints.map((ep) => `node_modules/${effectivePkgName}/${ep}`);
    } else {
      // Fallback: glob only .d.ts to avoid ESM/CJS twin double-counting
      includePaths = [`node_modules/${effectivePkgName}/**/*.d.ts`];
    }

    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "bundler",
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
        },
        include: includePaths,
      }),
    );

    // Build package context for correct metadata resolution
    const targetPkgJsonPath = join(effectivePkgDir, "package.json");
    const packageContext: PackageAnalysisContext = {
      packageJsonPath: targetPkgJsonPath,
      packageName,
      packageRoot: effectivePkgDir,
      typesEntrypoint: entrypoints[0] ?? null,
    };

    return analyzeProject(tmpDir, {
      mode: "package",
      packageContext,
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
  } finally {
    try {
      rmSync(tmpDir, { force: true, recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

function resolveDeclarationEntrypoints(pkgDir: string): string[] {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {return [];}

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return [];
  }

  const entrypoints: string[] = [];

  // Check types/typings top-level field
  const typesField = (pkg.types ?? pkg.typings) as string | undefined;
  if (typesField && existsSync(join(pkgDir, typesField))) {
    entrypoints.push(typesField);
  }

  // Check exports conditional types
  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (exports && typeof exports === "object") {
    collectExportTypes(exports, pkgDir, entrypoints);
  }

  // Deduplicate by stem to avoid ESM/CJS twins
  return deduplicateByDtsStem(entrypoints);
}

function collectExportTypes(
  exports: Record<string, unknown>,
  pkgDir: string,
  entrypoints: string[],
): void {
  for (const [key, value] of Object.entries(exports)) {
    if (key === "types" && typeof value === "string") {
      if (existsSync(join(pkgDir, value))) {
        entrypoints.push(value);
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collectExportTypes(value as Record<string, unknown>, pkgDir, entrypoints);
    }
  }
}

function deduplicateByDtsStem(paths: string[]): string[] {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const stem = p.replace(/\.d\.[mc]?ts$/, "");
    if (!seen.has(stem)) {
      seen.set(stem, p);
    } else {
      // Prefer .d.ts over .d.mts/.d.cts
      const existing = seen.get(stem)!;
      if (existing.endsWith(".d.mts") || existing.endsWith(".d.cts")) {
        if (p.endsWith(".d.ts")) {
          seen.set(stem, p);
        }
      }
    }
  }
  return [...seen.values()];
}
