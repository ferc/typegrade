import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { analyzeProject } from "./analyzer.js";
import type { AnalysisResult } from "./types.js";

export function scorePackage(nameOrPath: string): AnalysisResult {
  // Local path — analyze directly
  if (
    nameOrPath.startsWith(".") ||
    nameOrPath.startsWith("/") ||
    existsSync(nameOrPath)
  ) {
    return analyzeProject(resolve(nameOrPath));
  }

  // npm package — install to temp dir
  const tmpDir = join(tmpdir(), `tsguard-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    // Write minimal package.json
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "tsguard-tmp",
        version: "0.0.0",
        dependencies: {
          [nameOrPath]: "latest",
        },
      }),
    );

    // Install
    execSync("npm install --ignore-scripts --no-audit --no-fund", {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 60000,
    });

    // Determine which directories contain type declarations
    const includePaths: string[] = [
      `node_modules/${nameOrPath}/**/*.d.ts`,
      `node_modules/${nameOrPath}/**/*.d.mts`,
      `node_modules/${nameOrPath}/**/*.d.cts`,
    ];

    // Check if @types package is needed
    const pkgDir = join(tmpDir, "node_modules", nameOrPath);
    if (existsSync(pkgDir)) {
      const pkgJson = JSON.parse(
        readFileSync(join(pkgDir, "package.json"), "utf-8"),
      );
      if (!pkgJson.types && !pkgJson.typings) {
        // Try installing @types package
        const typesName = nameOrPath.startsWith("@")
          ? `@types/${nameOrPath.slice(1).replace("/", "__")}`
          : `@types/${nameOrPath}`;

        try {
          execSync(`npm install ${typesName} --ignore-scripts --no-audit --no-fund`, {
            cwd: tmpDir,
            stdio: "pipe",
            timeout: 30000,
          });
          // Include @types declarations
          includePaths.push(`node_modules/${typesName}/**/*.d.ts`);
        } catch {
          // No @types package available
        }
      }
    }

    // Write strict tsconfig.json (after install so we know which paths to include)
    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          skipLibCheck: false,
        },
        include: includePaths,
      }),
    );

    return analyzeProject(tmpDir, undefined, { includeDts: true, includeNodeModules: true });
  } finally {
    // Cleanup
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
