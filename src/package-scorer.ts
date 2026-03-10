import {
  ANALYSIS_SCHEMA_VERSION,
  type AcquisitionStage,
  type AnalysisResult,
  type AnalysisStatus,
  type DegradedCategory,
  type PackageAnalysisContext,
  type ResolutionDiagnostics,
  type ScoreValidity,
} from "./types.js";
import { type AnalyzeOptions, analyzeProject } from "./analyzer.js";
import { basename, dirname, join, resolve } from "node:path";
import { buildDeclarationGraph, resolveEntrypoints } from "./graph/index.js";
import {
  computePackageCacheKey,
  computeResultCacheKey,
  computeScoringConfigHash,
  getPackageCachePath,
  hasPackageCache,
  markPackageCached,
  readResultCache,
  writeResultCache,
} from "./cache.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { DomainType } from "./domain.js";
import type { GraphStats } from "./graph/types.js";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// --- WS4: Package layout classification ---

/** Classification of a package's declaration layout */
type PackageLayoutClass =
  | "standard"
  | "declaration-sparse"
  | "no-declarations"
  | "no-types-entry"
  | "unsupported-bundler";

/** Check whether a package.json exports map contains "types" entries */
function hasTypesInExports(pkgJson: Record<string, unknown>): boolean {
  const { exports } = pkgJson;
  if (!exports || typeof exports !== "object") {
    return false;
  }
  return JSON.stringify(exports).includes('"types"');
}

/**
 * Count .d.ts files in the package directory using a bounded recursive search.
 * Recurses up to `maxDepth` levels to catch nested declaration layouts
 * (e.g. `out/`, `dist/dts/`, `dist/esm/`).
 */
function countDtsFiles(pkgDir: string, maxDepth = 4): number {
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const nm = entry.name;
          if (nm.endsWith(".d.ts") || nm.endsWith(".d.mts") || nm.endsWith(".d.cts")) {
            count++;
          }
        } else if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules"
        ) {
          walk(join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  };
  walk(pkgDir, 0);
  return count;
}

/**
 * Detect if a package uses a bundler plugin that generates types at build time
 * rather than shipping pre-built .d.ts files. These packages cannot be analyzed
 * without running the build step.
 */
function detectBundlerPlugin(pkgJson: Record<string, unknown>): boolean {
  // Common bundler plugins that generate types dynamically
  const bundlerTypePlugins = [
    "rollup-plugin-dts",
    "vite-plugin-dts",
    "@rollup/plugin-typescript",
    "unplugin-auto-import",
    "rollup-plugin-typescript2",
    "esbuild-plugin-d.ts",
  ];

  // Check devDependencies and dependencies for known type-generating plugins
  const deps = {
    ...(pkgJson["dependencies"] as Record<string, string> | undefined),
    ...(pkgJson["devDependencies"] as Record<string, string> | undefined),
  };

  // Bundler plugin dependency indicates unsupported bundler layout
  for (const plugin of bundlerTypePlugins) {
    if (deps[plugin]) {
      return true;
    }
  }

  // Check for build scripts referencing type generation
  const scripts = pkgJson["scripts"] as Record<string, string> | undefined;
  if (scripts) {
    const buildScript = scripts["build"] ?? scripts["prepare"] ?? scripts["prepublish"] ?? "";
    if (buildScript.includes("dts") || buildScript.includes("tsc --emitDeclarationOnly")) {
      return true;
    }
  }

  return false;
}

/**
 * Classify a package layout to determine analysis strategy.
 */
function classifyPackageLayout(
  pkgDir: string,
  pkgJson: Record<string, unknown>,
): PackageLayoutClass {
  const hasTypeEntries = Boolean(
    pkgJson["types"] || pkgJson["typings"] || hasTypesInExports(pkgJson),
  );
  const dtsFiles = countDtsFiles(pkgDir);

  if (dtsFiles === 0) {
    // No declarations at all — check if it's a bundler plugin situation
    if (hasTypeEntries && detectBundlerPlugin(pkgJson)) {
      return "unsupported-bundler";
    }
    return "no-declarations";
  }
  if (!hasTypeEntries && dtsFiles > 0) {
    return "no-types-entry";
  }
  if (hasTypeEntries && dtsFiles < 3) {
    return "declaration-sparse";
  }
  return "standard";
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
 * Populates ALL mandatory fields with safe defaults — no optional fields left missing.
 * Degraded results never emit domain scores, scenario scores, or fix batches.
 */
function buildDegradedResult(opts: {
  packageName: string;
  spec: string;
  version: string | null;
  errorMessage: string;
  category: DegradedCategory;
  resolutionDiagnostics?: ResolutionDiagnostics;
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
    confidenceSummary: {
      domainInference: 0,
      graphResolution: 0,
      sampleCoverage: 0,
      scenarioApplicability: 0,
    },
    coverageDiagnostics: {
      ...(opts.category === "install-failure"
        ? { coverageFailureMode: "install-failure" as const }
        : {}),
      measuredDeclarations: 0,
      measuredPositions: 0,
      reachableFiles: 0,
      samplingClass: "undersampled",
      typesSource: "unknown",
      undersampled: true,
      undersampledReasons: [opts.errorMessage],
    },
    dedupStats: { filesRemoved: 0, groups: 0 },
    degradedCategory: opts.category,
    degradedReason: opts.errorMessage,
    dimensions: [],
    evidenceSummary: {
      coreSurfaceCoverage: 0,
      domainEvidence: 0,
      exportCoverage: 0,
      scenarioEvidence: 0,
      specializationEvidence: 0,
    },
    filesAnalyzed: 0,
    globalScores: { agentReadiness, consumerApi, typeSafety },
    graphStats: makeFallbackGraphStats(),
    mode: "package",
    noiseSummary: {
      excludedPaths: [],
      generatedIssueCount: 0,
      generatedIssueRatio: 0,
      sourceOwnedIssueCount: 0,
      suppressedGeneratedCount: 0,
    },
    packageIdentity: {
      displayName: opts.packageName,
      entrypointStrategy: "unknown",
      resolvedSpec: opts.spec,
      resolvedVersion: opts.version,
      typesSource: "unknown",
    },
    profileInfo: {
      profile: "package",
      profileConfidence: 0,
      profileReasons: ["Degraded analysis"],
    },
    projectName: opts.packageName,
    resolutionDiagnostics: opts.resolutionDiagnostics ?? {
      acquisitionStage: categoryToAcquisitionStage(opts.category),
      attemptedStrategies: [],
      chosenStrategy: "none",
      declarationCount: 0,
      failureReason: opts.errorMessage,
      failureStage: categoryToAcquisitionStage(opts.category),
    },
    scoreComparability: "global",
    scoreProfile: "published-declarations",
    scoreValidity: "not-comparable",
    status: "degraded",
    timeMs: 0,
    topIssues: [],
    trustSummary: {
      canCompare: false,
      canGate: false,
      classification: "abstained",
      reasons: [opts.errorMessage],
    },
  };
}

/** Map degraded category to the acquisition stage where failure likely occurred */
function categoryToAcquisitionStage(category: DegradedCategory): AcquisitionStage {
  const stageMap: Record<DegradedCategory, AcquisitionStage> = {
    "confidence-collapse": "complete",
    "install-failure": "package-install",
    "insufficient-surface": "graph-build",
    "invalid-package-spec": "spec-resolution",
    "missing-declarations": "declaration-entrypoint-resolution",
    "partial-graph-resolution": "graph-build",
    "resource-exhaustion": "complete",
    "unsupported-package-layout": "declaration-entrypoint-resolution",
    "workspace-discovery-failure": "spec-resolution",
  };
  return stageMap[category] ?? "spec-resolution";
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
    result.degradedCategory = result.degradedCategory ?? "insufficient-surface";
  } else {
    result.status = result.status ?? ("complete" as AnalysisStatus);
    result.scoreValidity = result.scoreValidity ?? ("fully-comparable" as ScoreValidity);
  }
  // Ensure analysisSchemaVersion is set
  result.analysisSchemaVersion = result.analysisSchemaVersion ?? ANALYSIS_SCHEMA_VERSION;
}

/**
 * Search for .d.ts files up to `maxDepth` levels deep and return the first one found.
 * This is a deeper fallback than LAST_RESORT_PATHS — it does a recursive scan
 * to find declarations at non-standard locations.
 */
function findAnyDtsFile(pkgDir: string, maxDepth = 5): string | null {
  const search = (dir: string, depth: number): string | null => {
    if (depth > maxDepth) {
      return null;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      // Check files first at this level
      for (const entry of entries) {
        if (entry.isFile()) {
          const nm = entry.name;
          if (nm.endsWith(".d.ts") || nm.endsWith(".d.mts") || nm.endsWith(".d.cts")) {
            return join(dir, nm);
          }
        }
      }
      // Then recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          const found = search(join(dir, entry.name), depth + 1);
          if (found) {
            return found;
          }
        }
      }
    } catch {
      // Ignore unreadable directories
    }
    return null;
  };
  return search(pkgDir, 0);
}

/** Build a fallback analysis result from non-standard declaration path */
function buildNonStandardDeclFallback(opts: {
  deepDts: string;
  domain: string | undefined;
  effectivePkgDir: string;
  installRoot: string;
  moduleKind: "esm" | "cjs" | "dual" | "unknown";
  nameOrPath: string;
  noCache: boolean | undefined;
  packageName: string;
  packageVersion: string;
  resultCacheKeyStr: string;
  typesSource: "bundled" | "@types" | "mixed" | "unknown";
}): AnalysisResult {
  const analyzeOpts = {
    mode: "package" as const,
    packageContext: {
      graphStats: makeFallbackGraphStats(),
      packageJsonPath: join(opts.effectivePkgDir, "package.json"),
      packageName: opts.packageName,
      packageRoot: opts.effectivePkgDir,
      typesEntrypoint: opts.deepDts.replace(`${opts.effectivePkgDir}/`, ""),
      typesSource: opts.typesSource,
    },
    sourceFilesOptions: { includeDts: true, includeNodeModules: true },
  };
  if (opts.domain !== undefined) {
    (analyzeOpts as Record<string, unknown>)["domain"] = opts.domain;
  }
  const result = analyzeProject(opts.installRoot, analyzeOpts);
  result.packageIdentity = {
    displayName: opts.packageName,
    entrypointStrategy: "fallback-glob",
    moduleKind: opts.moduleKind,
    resolvedSpec: opts.nameOrPath,
    resolvedVersion: opts.packageVersion === "latest" ? null : opts.packageVersion,
    typesSource: opts.typesSource,
  };
  result.caveats = result.caveats ?? [];
  result.caveats.push(
    "Declarations found at non-standard location — confidence may be lower than usual",
  );
  stampResultStatus(result);
  if (!opts.noCache) {
    writeResultCache(opts.resultCacheKeyStr, result);
  }
  return result;
}

function scoreLocalPackage(opts: {
  localPath: string;
  pkgJsonPath: string;
  domain?: "auto" | "off" | DomainType;
  noCache?: boolean;
}): AnalysisResult {
  const { localPath, pkgJsonPath, domain, noCache } = opts;
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const packageName = pkgJson.name ?? "local-package";

  const resolvedVersion: string | null = pkgJson.version ?? null;
  const moduleKind = detectModuleKind(pkgJson);

  // Classify the package layout (advisory — does not hard-gate scoring)
  const layout = classifyPackageLayout(localPath, pkgJson);

  // Compute result cache key for local packages
  const tsVersion = getTsVersion();
  const pkgCacheKey = computePackageCacheKey({
    packageSpec: `${packageName}@${resolvedVersion ?? "local"}`,
    tsVersion,
  });
  const resultKey = computeResultCacheKey({
    nodeMajor: parseInt(process.versions.node, 10),
    packageCacheKey: pkgCacheKey,
    scoringConfigHash: getScoringConfigHash(),
  });

  // Check result cache
  if (!noCache) {
    const cached = readResultCache<AnalysisResult>(resultKey);
    if (cached) {
      return cached;
    }
  }

  // Graph-first analysis: attempt entrypoint resolution and graph walk
  // Before falling back to layout-based degradation (WS1+WS2)
  const graphProject = loadProject(localPath);
  const graph = buildDeclarationGraph(localPath, graphProject);
  const entrypoints = resolveEntrypoints(localPath);
  const graphResolved = graph.filesToAnalyze.length > 0;

  // Unsupported bundler layout — type entries exist but point to build artifacts not yet generated
  if (layout === "unsupported-bundler" && !graphResolved) {
    return buildDegradedResult({
      category: "unsupported-package-layout",
      errorMessage: `Package ${packageName} uses a bundler plugin for type generation — declarations are not available at install time`,
      packageName,
      spec: localPath,
      version: resolvedVersion,
    });
  }

  // Only degrade for missing declarations after BOTH shallow check AND graph resolution fail
  if (layout === "no-declarations" && !graphResolved) {
    // Deep scan: try to find .d.ts files at non-standard locations
    const deepDts = findAnyDtsFile(localPath);
    if (deepDts) {
      // Found declarations at non-standard path — use fallback glob analysis
      const result = analyzeProject(localPath, {
        ...(domain !== undefined && { domain }),
        mode: "package",
        packageContext: {
          graphStats: makeFallbackGraphStats(),
          packageJsonPath: pkgJsonPath,
          packageName,
          packageRoot: localPath,
          typesEntrypoint: deepDts.replace(`${localPath}/`, ""),
          typesSource: "bundled",
        },
        sourceFilesOptions: { includeDts: true, includeNodeModules: true },
      });
      result.packageIdentity = {
        displayName: packageName,
        entrypointStrategy: "fallback-glob",
        moduleKind,
        resolvedSpec: localPath,
        resolvedVersion,
        typesSource: "bundled",
      };
      result.caveats = result.caveats ?? [];
      result.caveats.push(
        "Declarations found at non-standard location — confidence may be lower than usual",
      );
      stampResultStatus(result);
      if (!noCache) {
        writeResultCache(resultKey, result);
      }
      return result;
    }

    return buildDegradedResult({
      category: "missing-declarations",
      errorMessage: `No .d.ts files found in ${packageName}`,
      packageName,
      spec: localPath,
      version: resolvedVersion,
    });
  }

  // Has .d.ts files but no package.json type entries and graph found nothing — fallback glob
  if (layout === "no-types-entry" && !graphResolved) {
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
    if (!noCache) {
      writeResultCache(resultKey, result);
    }
    return result;
  }

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

  const analyzeOpts: AnalyzeOptions = {
    ...(domain !== undefined && { domain }),
    mode: "package",
    packageContext,
    sourceFilesOptions: { includeDts: true, includeNodeModules: true },
  };
  if (graphResolved) {
    analyzeOpts.fileFilter = new Set(graph.filesToAnalyze);
  }

  const result = analyzeProject(localPath, analyzeOpts);
  result.packageIdentity = {
    displayName: packageName,
    entrypointStrategy,
    moduleKind,
    resolvedSpec: localPath,
    resolvedVersion,
    typesSource: "bundled",
  };

  // Add caveat for declaration-sparse packages
  if (layout === "declaration-sparse") {
    result.caveats = result.caveats ?? [];
    result.caveats.push(
      "Declaration-sparse package (<3 .d.ts files) — confidence may be lower than usual",
    );
  }

  stampResultStatus(result);
  if (!noCache) {
    writeResultCache(resultKey, result);
  }
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

let cachedTsVersion: string | null = null;

function getTsVersion(): string {
  if (cachedTsVersion !== null) {
    return cachedTsVersion;
  }
  try {
    cachedTsVersion = execSync("tsc --version", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    cachedTsVersion = "unknown";
  }
  return cachedTsVersion;
}

let cachedScoringConfigHash: string | null = null;

/**
 * Compute and cache the scoring config hash from the constants source file.
 * Falls back to "unknown" when the source file is not available (e.g. bundled).
 */
function getScoringConfigHash(): string {
  if (cachedScoringConfigHash !== null) {
    return cachedScoringConfigHash;
  }
  // Resolve constants.ts relative to this module's location
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const constantsPath = join(thisDir, "constants.ts");
  cachedScoringConfigHash = computeScoringConfigHash(constantsPath);
  return cachedScoringConfigHash;
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
    const bundledEntrypoints = resolveEntrypoints(pkgDir).filter(
      (ep) => !ep.condition.startsWith("@types/"),
    );
    const shouldTryCompanionTypes =
      bundledEntrypoints.length === 0 && countDtsFiles(pkgDir, 5) === 0;

    if (shouldTryCompanionTypes) {
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
      return scoreLocalPackage({
        ...(options?.domain !== undefined && { domain: options.domain }),
        localPath,
        noCache: options?.noCache ?? false,
        pkgJsonPath: localPkgJsonPath,
      });
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

  // Compute result cache key before install (based on spec, not resolved files)
  const tsVersion = getTsVersion();
  const pkgCacheKey = computePackageCacheKey({
    packageSpec: `${packageName}@${packageVersion}`,
    tsVersion,
    typesVersion: options?.typesVersion,
  });
  const resultCacheKeyStr = computeResultCacheKey({
    nodeMajor: parseInt(process.versions.node, 10),
    packageCacheKey: pkgCacheKey,
    scoringConfigHash: getScoringConfigHash(),
  });

  // Check result cache before installing the package
  if (!options?.noCache) {
    const cachedResult = readResultCache<AnalysisResult>(resultCacheKeyStr);
    if (cachedResult) {
      return cachedResult;
    }
  }

  // Use cached install — catch install failures gracefully
  let installed: { installRoot: string; cleanup: () => void } | undefined = undefined;
  try {
    installed = ensureCachedInstall(packageName, packageVersion, {
      noCache: options?.noCache,
      typesVersion: options?.typesVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildDegradedResult({
      category: "install-failure",
      errorMessage: `Package install failed: ${message}`,
      packageName,
      spec: nameOrPath,
      version: packageVersion === "latest" ? null : packageVersion,
    });
  }

  const { installRoot, cleanup } = installed;
  try {
    const pkgDir = join(installRoot, "node_modules", packageName);

    // Pre-flight check: verify the package directory exists and has a package.json
    if (!existsSync(pkgDir) || !existsSync(join(pkgDir, "package.json"))) {
      return buildDegradedResult({
        category: "invalid-package-spec",
        errorMessage: `Package directory or package.json not found for ${packageName}`,
        packageName,
        spec: nameOrPath,
        version: packageVersion === "latest" ? null : packageVersion,
      });
    }

    // Detect types package
    let typesPackageName: string | undefined = undefined;
    let pkgJson: Record<string, unknown> = {};
    pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (!pkgJson["types"] && !pkgJson["typings"] && !pkgJson["exports"]) {
      const candidate = packageName.startsWith("@")
        ? `@types/${packageName.slice(1).replace("/", "__")}`
        : `@types/${packageName}`;
      if (existsSync(join(installRoot, "node_modules", candidate))) {
        typesPackageName = candidate;
      }
    }

    const effectivePkgDir = typesPackageName
      ? join(installRoot, "node_modules", typesPackageName)
      : pkgDir;

    // Verify the effective package directory exists and has declaration files
    if (!existsSync(effectivePkgDir)) {
      return buildDegradedResult({
        category: "missing-declarations",
        errorMessage: `Package directory not found: ${effectivePkgDir}`,
        packageName,
        spec: nameOrPath,
        version: packageVersion === "latest" ? null : packageVersion,
      });
    }

    // Classify the package layout (advisory — does not hard-gate scoring)
    const effectivePkgJsonForLayout = typesPackageName
      ? JSON.parse(readFileSync(join(effectivePkgDir, "package.json"), "utf8"))
      : pkgJson;
    const layout = classifyPackageLayout(effectivePkgDir, effectivePkgJsonForLayout);

    const typesSource: "bundled" | "@types" = typesPackageName ? "@types" : "bundled";

    // Graph-first: resolve entrypoints and walk the declaration graph
    // Before falling back to layout-based degradation (WS1+WS2)
    const graphProject = loadProject(installRoot);
    const graph = buildDeclarationGraph(effectivePkgDir, graphProject, {
      followSiblingTypes: true,
    });
    const graphResolved = graph.filesToAnalyze.length > 0;

    // Unsupported bundler layout — types exist in package.json but need a build step
    if (layout === "unsupported-bundler" && !graphResolved) {
      return buildDegradedResult({
        category: "unsupported-package-layout",
        errorMessage: `Package ${packageName} uses a bundler plugin for type generation — declarations are not available at install time`,
        packageName,
        spec: nameOrPath,
        version: packageVersion === "latest" ? null : packageVersion,
      });
    }

    // Only degrade after BOTH shallow check AND graph resolution fail
    if (layout === "no-declarations" && !graphResolved) {
      // Companion types: if no @types was found and no .d.ts exist, this is a pure JS package
      if (!typesPackageName) {
        // Deep scan: try to find .d.ts files at non-standard locations
        const deepDts = findAnyDtsFile(effectivePkgDir);
        if (!deepDts) {
          // Truly no declarations — pure JS package
          return buildDegradedResult({
            category: "unsupported-package-layout",
            errorMessage: `Package ${packageName} is a pure JavaScript package with no type declarations or @types companion`,
            packageName,
            spec: nameOrPath,
            version: packageVersion === "latest" ? null : packageVersion,
          });
        }
        // Found declarations at non-standard path — fallback analysis
        const fallbackResult = buildNonStandardDeclFallback({
          deepDts,
          domain: options?.domain,
          effectivePkgDir,
          installRoot,
          moduleKind: detectModuleKind(pkgJson),
          nameOrPath,
          noCache: options?.noCache,
          packageName,
          packageVersion,
          resultCacheKeyStr,
          typesSource,
        });
        return fallbackResult;
      }

      return buildDegradedResult({
        category: "missing-declarations",
        errorMessage: `No .d.ts files found in ${packageName}`,
        packageName,
        spec: nameOrPath,
        version: packageVersion === "latest" ? null : packageVersion,
      });
    }

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

    const analyzeOpts: AnalyzeOptions = {
      ...(options?.domain !== undefined && { domain: options.domain }),
      mode: "package",
      packageContext,
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    };
    if (graph.filesToAnalyze.length > 0) {
      analyzeOpts.fileFilter = new Set(graph.filesToAnalyze);
    }

    const result = analyzeProject(installRoot, analyzeOpts);

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

    // Build resolution diagnostics
    const attemptedStrategies: string[] = ["types-field", "exports-map", "main-field"];
    if (typesPackageName) {
      attemptedStrategies.push("@types-companion");
    }
    if (graph.stats.usedFallbackGlob) {
      attemptedStrategies.push("fallback-glob");
    }
    const dtsCount = countDtsFiles(effectivePkgDir);
    result.resolutionDiagnostics = {
      acquisitionStage: "complete",
      attemptedStrategies,
      chosenStrategy: typesPackageName ? "@types-companion" : entrypointStrategy,
      declarationCount: dtsCount,
    };

    // Add caveat for declaration-sparse packages
    if (layout === "declaration-sparse") {
      result.caveats = result.caveats ?? [];
      result.caveats.push(
        "Declaration-sparse package (<3 .d.ts files) — confidence may be lower than usual",
      );
    }

    stampResultStatus(result);

    // Write result to cache
    if (!options?.noCache) {
      writeResultCache(resultCacheKeyStr, result);
    }

    return result;
  } finally {
    cleanup();
  }
}
