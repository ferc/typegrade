import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AnalysisResult, PackageAnalysisContext } from "./types.js";
import { analyzeProject } from "./analyzer.js";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { buildDeclarationGraph, resolveEntrypoints } from "./graph/index.js";
import { loadProject } from "./utils/project-loader.js";

function scoreLocalPackage(localPath: string, pkgJsonPath: string): AnalysisResult {
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const packageName = pkgJson.name ?? "local-package";

  // Check if there are declaration entry fields
  const hasTypeEntries = Boolean(pkgJson.types || pkgJson.typings || pkgJson.exports);

  if (!hasTypeEntries) {
    // No type entrypoints — fall back to analyzing all files
    return analyzeProject(localPath, {
      mode: "package",
      packageContext: {
        packageJsonPath: pkgJsonPath,
        packageName,
        packageRoot: localPath,
        typesEntrypoint: null,
      },
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
  }

  // Write broad tsconfig for ts-morph resolution
  const tsconfigPath = join(localPath, "tsconfig.json");
  const hadTsconfig = existsSync(tsconfigPath);
  let originalTsconfig: string | undefined;

  if (hadTsconfig) {
    originalTsconfig = readFileSync(tsconfigPath, "utf8");
  }

  // Build declaration graph using the package's own structure
  const graphProject = loadProject(localPath);
  const graph = buildDeclarationGraph(localPath, graphProject);

  let fileFilter: Set<string> | undefined;
  let graphUsed = false;

  if (graph.filesToAnalyze.length > 0) {
    fileFilter = new Set(graph.filesToAnalyze);
    graphUsed = true;
  }

  const entrypoints = resolveEntrypoints(localPath);
  const packageContext: PackageAnalysisContext = {
    graphStats: graphUsed ? graph.stats : undefined,
    packageJsonPath: pkgJsonPath,
    packageName,
    packageRoot: localPath,
    typesEntrypoint: entrypoints[0]?.filePath
      ? entrypoints[0].filePath.replace(localPath + "/", "")
      : null,
  };

  return analyzeProject(localPath, {
    fileFilter,
    mode: "package",
    packageContext,
    sourceFilesOptions: { includeDts: true, includeNodeModules: true },
  });
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

export interface ScorePackageOptions {
  typesVersion?: string;
}

export function scorePackage(nameOrPath: string, options?: ScorePackageOptions): AnalysisResult {
  // Local path — analyze directly, including .d.ts files
  if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || existsSync(nameOrPath)) {
    const localPath = resolve(nameOrPath);
    const localPkgJsonPath = join(localPath, "package.json");

    // If local path has a package.json, use declaration graph for proper entrypoint resolution
    if (existsSync(localPkgJsonPath)) {
      return scoreLocalPackage(localPath, localPkgJsonPath);
    }

    return analyzeProject(localPath, {
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

    // Resolve the actual package directory to use for declarations
    const effectivePkgDir = typesPackageName
      ? join(tmpDir, "node_modules", typesPackageName)
      : pkgDir;
    const effectivePkgName = typesPackageName ?? packageName;

    // Write a broad tsconfig so ts-morph can resolve all imports within the package
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

    // Build declaration graph: resolve entrypoints → walk imports → deduplicate
    const graphProject = loadProject(tmpDir);
    const graph = buildDeclarationGraph(effectivePkgDir, graphProject);

    // Determine files to analyze
    let fileFilter: Set<string> | undefined;
    let graphUsed = false;

    if (graph.filesToAnalyze.length > 0) {
      fileFilter = new Set(graph.filesToAnalyze);
      graphUsed = true;
    } else if (graph.stats.usedFallbackGlob || graph.entrypoints.length === 0) {
      // No entrypoints found — fall back to analyzing all declaration files
      // (fileFilter remains undefined, so all files from tsconfig are analyzed)
    }

    // Resolve first entrypoint for context
    const entrypoints = resolveEntrypoints(effectivePkgDir);

    // Build package context
    const targetPkgJsonPath = join(effectivePkgDir, "package.json");
    const packageContext: PackageAnalysisContext = {
      graphStats: graphUsed ? graph.stats : undefined,
      packageJsonPath: targetPkgJsonPath,
      packageName,
      packageRoot: effectivePkgDir,
      typesEntrypoint: entrypoints[0]?.filePath
        ? entrypoints[0].filePath.replace(effectivePkgDir + "/", "")
        : null,
    };

    return analyzeProject(tmpDir, {
      fileFilter,
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
