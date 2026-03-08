import type { AnalysisResult, PackageAnalysisContext, PackageIdentity } from "./types.js";
import { basename, join, resolve } from "node:path";
import { buildDeclarationGraph, resolveEntrypoints } from "./graph/index.js";
import {
  computePackageCacheKey,
  getPackageCachePath,
  hasPackageCache,
  markPackageCached,
} from "./cache.js";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { GraphStats } from "./graph/types.js";
import { analyzeProject } from "./analyzer.js";
import { execSync } from "node:child_process";
import { loadProject } from "./utils/project-loader.js";
import { tmpdir } from "node:os";

function makeFallbackGraphStats(): GraphStats {
  return {
    dedupByStrategy: {},
    fallbackReason: "no-package-type-entries",
    filesDeduped: 0,
    totalAfterDedup: 0,
    totalEntrypoints: 0,
    totalReachable: 0,
    usedFallbackGlob: true,
  };
}

function scoreLocalPackage(
  localPath: string,
  pkgJsonPath: string,
  domain?: "auto" | "off" | string,
): AnalysisResult {
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const packageName = pkgJson.name ?? "local-package";

  // Check if there are declaration entry fields
  const hasTypeEntries = Boolean(pkgJson.types || pkgJson.typings || pkgJson.exports);

  const resolvedVersion: string | null = pkgJson.version ?? null;
  const packageIdentity: PackageIdentity = {
    displayName: packageName,
    resolvedSpec: localPath,
    resolvedVersion,
  };

  if (!hasTypeEntries) {
    // No type entrypoints — fall back to analyzing all files
    const result = analyzeProject(localPath, {
      domain: domain as any,
      mode: "package",
      packageContext: {
        graphStats: makeFallbackGraphStats(),
        packageJsonPath: pkgJsonPath,
        packageName,
        packageRoot: localPath,
        typesEntrypoint: null,
        typesSource: "unknown",
      },
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
    result.packageIdentity = packageIdentity;
    return result;
  }

  // Build declaration graph using the package's own structure
  const graphProject = loadProject(localPath);
  const graph = buildDeclarationGraph(localPath, graphProject);

  const entrypoints = resolveEntrypoints(localPath);
  const packageContext: PackageAnalysisContext = {
    graphStats: graph.stats,
    packageJsonPath: pkgJsonPath,
    packageName,
    packageRoot: localPath,
    typesEntrypoint: entrypoints[0]?.filePath
      ? entrypoints[0].filePath.replace(`${localPath}/`, "")
      : null,
    typesSource: "bundled",
  };

  const opts: Parameters<typeof analyzeProject>[1] = {
    domain: domain as any,
    mode: "package",
    packageContext,
    sourceFilesOptions: { includeDts: true, includeNodeModules: true },
  };
  if (graph.filesToAnalyze.length > 0) {
    opts!.fileFilter = new Set(graph.filesToAnalyze);
  }

  const result = analyzeProject(localPath, opts);
  result.packageIdentity = packageIdentity;
  return result;
}

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

function getTsVersion(): string {
  try {
    return execSync("tsc --version", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "unknown";
  }
}

export interface ScorePackageOptions {
  typesVersion?: string;
  domain?: "auto" | "off" | string;
  /** Disable the package cache (always install fresh) */
  noCache?: boolean;
}

/**
 * Install a package into the cache directory, or reuse an existing cached install.
 * Returns the path to the install root (which contains node_modules/).
 */
function ensureCachedInstall(
  packageName: string,
  packageVersion: string,
  options?: { typesVersion?: string | undefined; noCache?: boolean | undefined },
): { installRoot: string; cleanup: () => void } {
  const tsVersion = getTsVersion();
  const cacheKey = computePackageCacheKey({
    packageSpec: `${packageName}@${packageVersion}`,
    tsVersion,
    typesVersion: options?.typesVersion,
  });

  // Check cache
  if (!options?.noCache && hasPackageCache(cacheKey)) {
    const cachePath = getPackageCachePath(cacheKey);
    return { cleanup: () => {}, installRoot: cachePath };
  }

  // Install to temp dir, then copy to cache
  const tmpDir = join(tmpdir(), `typegrade-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  writeFileSync(
    join(tmpDir, "package.json"),
    JSON.stringify({
      dependencies: {
        [packageName]: packageVersion,
      },
      name: "typegrade-tmp",
      version: "0.0.0",
    }),
  );

  execSync("npm install --ignore-scripts --no-audit --no-fund", {
    cwd: tmpDir,
    stdio: "pipe",
    timeout: 60_000,
  });

  const pkgDir = join(tmpDir, "node_modules", packageName);
  let typesPackageName: string | undefined = undefined;

  if (existsSync(pkgDir)) {
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (!pkgJson.types && !pkgJson.typings && !pkgJson.exports) {
      typesPackageName = packageName.startsWith("@")
        ? `@types/${packageName.slice(1).replace("/", "__")}`
        : `@types/${packageName}`;

      const typesSpec = options?.typesVersion
        ? `${typesPackageName}@${options.typesVersion}`
        : typesPackageName;

      try {
        execSync(`npm install ${typesSpec} --ignore-scripts --no-audit --no-fund`, {
          cwd: tmpDir,
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch {
        typesPackageName = undefined;
      }
    }
  }

  // Determine effective package dir and write tsconfig
  const effectivePkgName = typesPackageName ?? packageName;
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
      include: [
        `node_modules/${effectivePkgName}/**/*.d.ts`,
        `node_modules/${effectivePkgName}/**/*.d.mts`,
        `node_modules/${effectivePkgName}/**/*.d.cts`,
      ],
    }),
  );

  // Copy to cache
  if (!options?.noCache) {
    const cachePath = getPackageCachePath(cacheKey);
    mkdirSync(cachePath, { recursive: true });
    cpSync(tmpDir, cachePath, { recursive: true });
    markPackageCached(cacheKey);

    // Clean up temp dir
    try {
      rmSync(tmpDir, { force: true, recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    return { cleanup: () => {}, installRoot: cachePath };
  }

  // No cache — use temp dir directly, caller must clean up
  return {
    cleanup: () => {
      try {
        rmSync(tmpDir, { force: true, recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    },
    installRoot: tmpDir,
  };
}

export function scorePackage(nameOrPath: string, options?: ScorePackageOptions): AnalysisResult {
  // Local path — analyze directly, including .d.ts files
  if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || existsSync(nameOrPath)) {
    const localPath = resolve(nameOrPath);
    const localPkgJsonPath = join(localPath, "package.json");

    // If local path has a package.json, use declaration graph for proper entrypoint resolution
    if (existsSync(localPkgJsonPath)) {
      return scoreLocalPackage(localPath, localPkgJsonPath, options?.domain);
    }

    const result = analyzeProject(localPath, {
      domain: options?.domain as any,
      mode: "package",
      packageContext: {
        graphStats: makeFallbackGraphStats(),
        packageJsonPath: "",
        packageName: "local-package",
        packageRoot: localPath,
        typesEntrypoint: null,
        typesSource: "unknown",
      },
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
    result.packageIdentity = {
      displayName: basename(localPath),
      resolvedSpec: localPath,
      resolvedVersion: null,
    };
    return result;
  }

  // Parse name@version spec
  const { name: packageName, version: packageVersion } = parsePackageSpec(nameOrPath);

  // Use cached install
  const { installRoot, cleanup } = ensureCachedInstall(packageName, packageVersion, {
    noCache: options?.noCache,
    typesVersion: options?.typesVersion,
  });

  try {
    const pkgDir = join(installRoot, "node_modules", packageName);

    // Detect types package
    let typesPackageName: string | undefined = undefined;
    if (existsSync(pkgDir)) {
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      if (!pkgJson.types && !pkgJson.typings && !pkgJson.exports) {
        const candidate = packageName.startsWith("@")
          ? `@types/${packageName.slice(1).replace("/", "__")}`
          : `@types/${packageName}`;
        if (existsSync(join(installRoot, "node_modules", candidate))) {
          typesPackageName = candidate;
        }
      }
    }

    const effectivePkgDir = typesPackageName
      ? join(installRoot, "node_modules", typesPackageName)
      : pkgDir;
    const typesSource: "bundled" | "@types" = typesPackageName ? "@types" : "bundled";

    // Build declaration graph: resolve entrypoints → walk imports → deduplicate
    const graphProject = loadProject(installRoot);
    const graph = buildDeclarationGraph(effectivePkgDir, graphProject, {
      followSiblingTypes: true,
    });

    // Resolve first entrypoint for context
    const entrypoints = resolveEntrypoints(effectivePkgDir);

    // Build package context — graphStats always present
    const targetPkgJsonPath = join(effectivePkgDir, "package.json");
    const packageContext: PackageAnalysisContext = {
      graphStats: graph.stats,
      packageJsonPath: targetPkgJsonPath,
      packageName,
      packageRoot: effectivePkgDir,
      typesEntrypoint: entrypoints[0]?.filePath
        ? entrypoints[0].filePath.replace(`${effectivePkgDir}/`, "")
        : null,
      typesSource,
    };

    const opts: Parameters<typeof analyzeProject>[1] = {
      domain: options?.domain as any,
      mode: "package",
      packageContext,
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    };
    if (graph.filesToAnalyze.length > 0) {
      opts!.fileFilter = new Set(graph.filesToAnalyze);
    }

    const result = analyzeProject(installRoot, opts);

    // Resolve version from the installed package's package.json
    let resolvedVersion: string | null = null;
    try {
      const installedPkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      resolvedVersion = installedPkgJson.version ?? null;
    } catch {
      // Version unavailable
    }
    result.packageIdentity = {
      displayName: packageName,
      resolvedSpec: nameOrPath,
      resolvedVersion,
    };

    return result;
  } finally {
    cleanup();
  }
}
