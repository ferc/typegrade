import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
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

export interface GetSourceFilesOptions {
  includeDts?: boolean;
  includeNodeModules?: boolean;
}

export function getSourceFiles(project: Project, options?: GetSourceFilesOptions) {
  const { includeDts = false, includeNodeModules = false } = options ?? {};

  return project.getSourceFiles().filter((sf) => {
    const path = sf.getFilePath();
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
