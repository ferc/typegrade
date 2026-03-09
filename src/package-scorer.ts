import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalysisStatus,
  type PackageAnalysisContext,
  type ScoreValidity,
} from "./types.js";
import { type AnalyzeOptions, analyzeProject } from "./analyzer.js";
import { basename, join, resolve } from "node:path";
import { buildDeclarationGraph, resolveEntrypoints } from "./graph/index.js";
import {
  computePackageCacheKey,
  getPackageCachePath,
  hasPackageCache,
  markPackageCached,
} from "./cache.js";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DomainType } from "./domain.js";
import type { GraphStats } from "./graph/types.js";
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

/**
 * Detect the module kind from a package.json object.
 */
function detectModuleKind(pkgJson: Record<string, unknown>): "esm" | "cjs" | "dual" | "unknown" {
  const hasExports = Boolean(pkgJson["exports"]);
  const typeField = pkgJson["type"] as string | undefined;
  const hasMain = Boolean(pkgJson["main"]);
  const hasModule = Boolean(pkgJson["module"]);

  if (typeField === "module") {
    // If it also has a main/require export, it could be dual
    if (hasMain || (hasExports && hasRequireExport(pkgJson))) {
      return "dual";
    }
    return "esm";
  }
  if (typeField === "commonjs" || (!typeField && hasMain && !hasModule)) {
    return "cjs";
  }
  if (hasModule && hasMain) {
    return "dual";
  }
  if (hasExports) {
    // Exports map with both import and require conditions
    if (hasImportExport(pkgJson) && hasRequireExport(pkgJson)) {
      return "dual";
    }
    if (hasImportExport(pkgJson)) {
      return "esm";
    }
    if (hasRequireExport(pkgJson)) {
      return "cjs";
    }
  }
  return "unknown";
}

function hasRequireExport(pkgJson: Record<string, unknown>): boolean {
  const { exports } = pkgJson;
  if (!exports || typeof exports !== "object") {
    return false;
  }
  const str = JSON.stringify(exports);
  return str.includes('"require"');
}

function hasImportExport(pkgJson: Record<string, unknown>): boolean {
  const { exports } = pkgJson;
  if (!exports || typeof exports !== "object") {
    return false;
  }
  const str = JSON.stringify(exports);
  return str.includes('"import"');
}

/**
 * Detect the entrypoint strategy from resolved entrypoints and package.json.
 */
function detectEntrypointStrategy(
  pkgJson: Record<string, unknown>,
  entrypointCondition: string | undefined,
): "exports-map" | "types-field" | "main-field" | "fallback-glob" | "unknown" {
  if (!entrypointCondition) {
    return "unknown";
  }
  // Conditions from resolveEntrypoints: "types", "typings", "import.types", "require.types", "main", "module", etc.
  if (entrypointCondition.includes("types") && pkgJson["exports"]) {
    return "exports-map";
  }
  if (entrypointCondition === "types" || entrypointCondition === "typings") {
    return "types-field";
  }
  if (entrypointCondition === "main" || entrypointCondition === "module") {
    return "main-field";
  }
  // Exports-map derived conditions
  if (entrypointCondition.includes(".")) {
    return "exports-map";
  }
  return "unknown";
}

/**
 * Build a degraded AnalysisResult when the package cannot be fully analyzed.
 * Populates all mandatory fields with safe defaults.
 */
function buildDegradedResult(opts: {
  packageName: string;
  spec: string;
  version: string | null;
  errorMessage: string;
}): AnalysisResult {
  const zeroComposite = (key: "consumerApi" | "agentReadiness" | "typeSafety") => ({
    compositeConfidenceReasons: ["Degraded analysis — scores are not comparable"],
    confidence: 0,
    grade: "N/A" as const,
    key,
    rationale: [`Degraded: ${opts.errorMessage}`],
    score: null,
  });
  const consumerApi = zeroComposite("consumerApi");
  const agentReadiness = zeroComposite("agentReadiness");
  const typeSafety = zeroComposite("typeSafety");

  return {
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    caveats: [opts.errorMessage],
    composites: [consumerApi, agentReadiness, typeSafety],
    dedupStats: { filesRemoved: 0, groups: 0 },
    degradedReason: opts.errorMessage,
    dimensions: [],
    filesAnalyzed: 0,
    globalScores: { agentReadiness, consumerApi, typeSafety },
    graphStats: makeFallbackGraphStats(),
    mode: "package",
    packageIdentity: {
      displayName: opts.packageName,
      resolvedSpec: opts.spec,
      resolvedVersion: opts.version,
    },
    profileInfo: {
      profile: "package",
      profileConfidence: 0,
      profileReasons: ["Degraded analysis"],
    },
    projectName: opts.packageName,
    scoreComparability: "global",
    scoreProfile: "published-declarations",
    scoreValidity: "not-comparable",
    status: "degraded",
    timeMs: 0,
    topIssues: [],
  };
}

/**
 * Check whether an analysis result has all-zero composites and degraded coverage,
 * indicating a result that should be marked as degraded.
 */
function isEffectivelyDegraded(result: AnalysisResult): boolean {
  const allZeroOrNull = result.composites.every((comp) => comp.score === null || comp.score === 0);
  if (!allZeroOrNull) {
    return false;
  }
  // Check coverage diagnostics
  const coverage = result.coverageDiagnostics;
  if (coverage && (coverage.undersampled || coverage.samplingClass === "undersampled")) {
    return true;
  }
  // Also degrade if zero files were analyzed
  if (result.filesAnalyzed === 0) {
    return true;
  }
  return false;
}

/**
 * Stamp mandatory status fields on a successful result and enrich PackageIdentity.
 */
function stampResultStatus(result: AnalysisResult): void {
  if (isEffectivelyDegraded(result)) {
    result.status = "degraded";
    result.scoreValidity = "not-comparable";
    result.degradedReason =
      result.degradedReason ?? "All composite scores are zero with degraded coverage";
  } else {
    result.status = result.status ?? ("complete" as AnalysisStatus);
    result.scoreValidity = result.scoreValidity ?? ("fully-comparable" as ScoreValidity);
  }
  // Ensure analysisSchemaVersion is set
  result.analysisSchemaVersion = result.analysisSchemaVersion ?? ANALYSIS_SCHEMA_VERSION;
}

function scoreLocalPackage(
  localPath: string,
  pkgJsonPath: string,
  domain?: "auto" | "off" | DomainType,
): AnalysisResult {
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const packageName = pkgJson.name ?? "local-package";

  // Check if there are declaration entry fields
  const hasTypeEntries = Boolean(pkgJson.types || pkgJson.typings || pkgJson.exports);

  const resolvedVersion: string | null = pkgJson.version ?? null;
  const moduleKind = detectModuleKind(pkgJson);

  if (!hasTypeEntries) {
    // No type entrypoints — fall back to analyzing all files
    const result = analyzeProject(localPath, {
      ...(domain !== undefined && { domain }),
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
    result.packageIdentity = {
      displayName: packageName,
      entrypointStrategy: "fallback-glob",
      moduleKind,
      resolvedSpec: localPath,
      resolvedVersion,
      typesSource: "unknown",
    };
    stampResultStatus(result);
    return result;
  }

  // Build declaration graph using the package's own structure
  const graphProject = loadProject(localPath);
  const graph = buildDeclarationGraph(localPath, graphProject);

  const entrypoints = resolveEntrypoints(localPath);
  const entrypointStrategy = detectEntrypointStrategy(pkgJson, entrypoints[0]?.condition);

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

  const opts: AnalyzeOptions = {
    ...(domain !== undefined && { domain }),
    mode: "package",
    packageContext,
    sourceFilesOptions: { includeDts: true, includeNodeModules: true },
  };
  if (graph.filesToAnalyze.length > 0) {
    opts.fileFilter = new Set(graph.filesToAnalyze);
  }

  const result = analyzeProject(localPath, opts);
  result.packageIdentity = {
    displayName: packageName,
    entrypointStrategy,
    moduleKind,
    resolvedSpec: localPath,
    resolvedVersion,
    typesSource: "bundled",
  };
  stampResultStatus(result);
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
  domain?: "auto" | "off" | DomainType;
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

  try {
    execSync("npm install --ignore-scripts --no-audit --no-fund", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (error) {
    // Clean up temp dir on install failure
    try {
      rmSync(tmpDir, { force: true, recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Package install failed for ${packageName}@${packageVersion}: ${message}`, {
      cause: error,
    });
  }

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

/**
 * Score an npm package or local package path for type precision quality.
 *
 * @example
 * ```ts
 * import { scorePackage } from "typegrade";
 * const result = scorePackage("zod");
 * console.log(result.composites); // consumerApi, agentReadiness, typeSafety
 * ```
 */
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
      ...(options?.domain !== undefined && { domain: options.domain }),
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
      entrypointStrategy: "fallback-glob",
      moduleKind: "unknown",
      resolvedSpec: localPath,
      resolvedVersion: null,
      typesSource: "unknown",
    };
    stampResultStatus(result);
    return result;
  }

  // Parse name@version spec
  const { name: packageName, version: packageVersion } = parsePackageSpec(nameOrPath);

  // Use cached install — catch install failures gracefully
  let cached: { installRoot: string; cleanup: () => void } | undefined = undefined;
  try {
    cached = ensureCachedInstall(packageName, packageVersion, {
      noCache: options?.noCache,
      typesVersion: options?.typesVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildDegradedResult({
      errorMessage: `Package install failed: ${message}`,
      packageName,
      spec: nameOrPath,
      version: packageVersion === "latest" ? null : packageVersion,
    });
  }

  const { installRoot, cleanup } = cached;
  try {
    const pkgDir = join(installRoot, "node_modules", packageName);

    // Detect types package
    let typesPackageName: string | undefined = undefined;
    let pkgJson: Record<string, unknown> = {};
    if (existsSync(pkgDir)) {
      pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      if (!pkgJson["types"] && !pkgJson["typings"] && !pkgJson["exports"]) {
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

    // Detect module kind and entrypoint strategy from the source package
    const moduleKind = detectModuleKind(pkgJson);
    const effectivePkgJson = typesPackageName
      ? JSON.parse(readFileSync(join(effectivePkgDir, "package.json"), "utf8"))
      : pkgJson;
    const entrypointStrategy = detectEntrypointStrategy(
      effectivePkgJson,
      entrypoints[0]?.condition,
    );

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

    const opts: AnalyzeOptions = {
      ...(options?.domain !== undefined && { domain: options.domain }),
      mode: "package",
      packageContext,
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    };
    if (graph.filesToAnalyze.length > 0) {
      opts.fileFilter = new Set(graph.filesToAnalyze);
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
      entrypointStrategy,
      moduleKind,
      resolvedSpec: nameOrPath,
      resolvedVersion,
      typesSource,
    };

    stampResultStatus(result);
    return result;
  } finally {
    cleanup();
  }
}
