import { Project } from "ts-morph";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
      strict: true,
      target: 2 /* ES2015 */,
      module: 99 /* ESNext */,
      moduleResolution: 100 /* Bundler */,
      esModuleInterop: true,
      skipLibCheck: true,
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
    if (!includeNodeModules && path.includes("node_modules")) {return false;}
    if (!includeDts && /\.d\.[mc]?ts$/.test(path)) {return false;}
    if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) {return false;}
    return true;
  });
}
