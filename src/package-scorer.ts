import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { analyzeProject } from "./analyzer.js";
import type { AnalysisResult } from "./types.js";

export function scorePackage(nameOrPath: string): AnalysisResult {
  // Local path — analyze directly, including .d.ts files
  if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || existsSync(nameOrPath)) {
    return analyzeProject(resolve(nameOrPath), {
      mode: "package",
      sourceFilesOptions: { includeDts: true, includeNodeModules: true },
    });
  }

  // Npm package — install to temp dir
  const tmpDir = join(tmpdir(), `tsguard-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: {
          [nameOrPath]: "latest",
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

    const includePaths: string[] = [
      `node_modules/${nameOrPath}/**/*.d.ts`,
      `node_modules/${nameOrPath}/**/*.d.mts`,
      `node_modules/${nameOrPath}/**/*.d.cts`,
    ];

    const pkgDir = join(tmpDir, "node_modules", nameOrPath);
    if (existsSync(pkgDir)) {
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      if (!pkgJson.types && !pkgJson.typings) {
        const typesName = nameOrPath.startsWith("@")
          ? `@types/${nameOrPath.slice(1).replace("/", "__")}`
          : `@types/${nameOrPath}`;

        try {
          execSync(`npm install ${typesName} --ignore-scripts --no-audit --no-fund`, {
            cwd: tmpDir,
            stdio: "pipe",
            timeout: 30_000,
          });
          includePaths.push(`node_modules/${typesName}/**/*.d.ts`);
        } catch {
          // No @types package available
        }
      }
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

    return analyzeProject(tmpDir, {
      mode: "package",
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
