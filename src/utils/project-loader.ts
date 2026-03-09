import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget, type SourceFile } from "ts-morph";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

export function loadProject(projectPath: string): Project {
  const absolutePath = resolve(projectPath);
  const tsconfigPath = join(absolutePath, "tsconfig.json");

  if (existsSync(tsconfigPath)) {
    return new Project({
      skipAddingFilesFromTsConfig: false,
      tsConfigFilePath: tsconfigPath,
    });
  }

  // No tsconfig — create a project with strict defaults
  const project = new Project({
    compilerOptions: {
      esModuleInterop: true,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      strict: true,
      target: ScriptTarget.ES2015,
    },
  });

  project.addSourceFilesAtPaths(join(absolutePath, "**/*.{ts,tsx}"));
  return project;
}

function normalizeScope(scopeRoot: string | undefined): string | undefined {
  if (!scopeRoot) {
    return undefined;
  }
  return scopeRoot.endsWith("/") ? scopeRoot : `${scopeRoot}/`;
}

export interface GetSourceFilesOptions {
  includeDts?: boolean;
  includeNodeModules?: boolean;
}

/**
 * Load a project with minimal overhead — skips lib files and dependency resolution.
 * Suitable for AST-only analysis (boundary detection, pattern matching) that
 * does not require type resolution or type-checker queries.
 */
export function loadProjectLightweight(projectPath: string): Project {
  const absolutePath = resolve(projectPath);
  const tsconfigPath = join(absolutePath, "tsconfig.json");

  if (existsSync(tsconfigPath)) {
    return new Project({
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      tsConfigFilePath: tsconfigPath,
    });
  }

  const project = new Project({
    compilerOptions: {
      esModuleInterop: true,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      strict: true,
      target: ScriptTarget.ES2015,
    },
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });

  project.addSourceFilesAtPaths(join(absolutePath, "**/*.{ts,tsx}"));
  return project;
}

export function getSourceFiles(
  project: Project,
  options?: GetSourceFilesOptions,
  /** When provided, only files whose path starts with this directory are included */
  scopeRoot?: string,
): SourceFile[] {
  const { includeDts = false, includeNodeModules = false } = options ?? {};
  const normalizedScope = normalizeScope(scopeRoot);

  return project.getSourceFiles().filter((sf) => {
    const path = sf.getFilePath();
    if (normalizedScope && !path.startsWith(normalizedScope)) {
      return false;
    }
    if (!includeNodeModules && path.includes("node_modules")) {
      return false;
    }
    if (!includeDts && /\.d\.[mc]?ts$/.test(path)) {
      return false;
    }
    if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) {
      return false;
    }
    return true;
  });
}
