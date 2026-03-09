import type { AnalysisProfile, ProfileInfo } from "../types.js";
import { existsSync, readFileSync } from "node:fs";
import type { ProfileSignals } from "./types.js";
import { join } from "node:path";

const CLI_FRAMEWORKS = ["commander", "yargs", "cac", "meow", "oclif", "citty", "cleye"];
const NETWORK_FRAMEWORKS = [
  "express",
  "fastify",
  "hono",
  "koa",
  "hapi",
  "restify",
  "next",
  "nuxt",
  "remix",
  "@nestjs/core",
];
const TEST_FRAMEWORKS = ["vitest", "jest", "mocha", "ava", "tap"];

/**
 * Gather profile signals from the project directory.
 */
export function gatherProfileSignals(
  projectPath: string,
  opts: { isPackageMode: boolean; sourceFileCount: number; declarationFileRatio: number },
): ProfileSignals {
  const signals: ProfileSignals = {
    declarationFileRatio: opts.declarationFileRatio,
    emitsDeclarations: false,
    entryPointCount: 0,
    hasBinOrScripts: false,
    hasCliFrameworks: false,
    hasNetworkFrameworks: false,
    hasPublishableTypes: false,
    hasTestFrameworkDeps: false,
    isPackageMode: opts.isPackageMode,
    sourceFileCount: opts.sourceFileCount,
  };

  // Read package.json
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      signals.hasPublishableTypes = Boolean(pkg.types || pkg.typings || pkg.exports);
      signals.hasBinOrScripts = Boolean(pkg.bin);

      const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
      const allDeps = { ...deps, ...pkg.devDependencies };

      signals.hasNetworkFrameworks = NETWORK_FRAMEWORKS.some((fw) => allDeps[fw] !== undefined);
      signals.hasCliFrameworks = CLI_FRAMEWORKS.some((fw) => allDeps[fw] !== undefined);
      signals.hasTestFrameworkDeps = TEST_FRAMEWORKS.some((fw) => deps[fw] !== undefined);

      if (pkg.exports && typeof pkg.exports === "object") {
        signals.entryPointCount = Object.keys(pkg.exports).length;
      } else if (signals.hasPublishableTypes) {
        signals.entryPointCount = 1;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Read tsconfig.json for declaration emission
  const tsconfigPath = join(projectPath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      signals.emitsDeclarations = Boolean(tsconfig.compilerOptions?.declaration);
    } catch {
      // Ignore parse errors
    }
  }

  return signals;
}

/**
 * Detect the analysis profile from project signals.
 *
 * Priority:
 * 1. Package mode (npm install) → "package"
 * 2. Publishable types + declarations → "library"
 * 3. Network/CLI frameworks + bin → "application"
 * 4. Default → "library" (conservative, treats as library)
 */
export function detectProfile(signals: ProfileSignals): ProfileInfo {
  const reasons: string[] = [];
  let profile: AnalysisProfile = "library";
  let confidence = 0.5;

  // Package mode is definitive
  if (signals.isPackageMode) {
    return {
      profile: "package",
      profileConfidence: 0.95,
      profileReasons: ["Analyzing installed package declarations"],
    };
  }

  // Library detection
  const libraryScore = computeLibraryScore(signals, reasons);

  // Application detection
  const applicationScore = computeApplicationScore(signals, reasons);

  if (libraryScore > applicationScore && libraryScore > 0.4) {
    profile = "library";
    confidence = Math.min(0.95, libraryScore);
  } else if (applicationScore > libraryScore && applicationScore > 0.4) {
    profile = "application";
    confidence = Math.min(0.95, applicationScore);
  } else {
    // Low confidence — default to library
    profile = "library";
    confidence = 0.4;
    reasons.push("Low confidence: defaulting to library profile");
  }

  return {
    profile,
    profileConfidence: Math.round(confidence * 100) / 100,
    profileReasons: reasons,
  };
}

function computeLibraryScore(signals: ProfileSignals, reasons: string[]): number {
  let score = 0;

  if (signals.hasPublishableTypes) {
    score += 0.35;
    reasons.push("Has publishable type entries (types/typings/exports)");
  }
  if (signals.emitsDeclarations) {
    score += 0.2;
    reasons.push("Emits declaration files");
  }
  if (signals.entryPointCount > 0) {
    score += 0.15;
    reasons.push(`${signals.entryPointCount} export entry point(s)`);
  }
  if (signals.declarationFileRatio > 0.3) {
    score += 0.1;
    reasons.push("High declaration file ratio");
  }
  if (!signals.hasBinOrScripts && !signals.hasNetworkFrameworks) {
    score += 0.1;
    reasons.push("No bin/app entry points");
  }

  return score;
}

function computeApplicationScore(signals: ProfileSignals, reasons: string[]): number {
  let score = 0;

  if (signals.hasBinOrScripts) {
    score += 0.25;
    reasons.push("Has bin entries");
  }
  if (signals.hasNetworkFrameworks) {
    score += 0.3;
    reasons.push("Uses network/server frameworks");
  }
  if (signals.hasCliFrameworks) {
    score += 0.2;
    reasons.push("Uses CLI frameworks");
  }
  if (!signals.hasPublishableTypes && !signals.emitsDeclarations) {
    score += 0.15;
    reasons.push("No publishable types");
  }

  return score;
}

/**
 * Resolve the effective profile, considering explicit override.
 */
export function resolveProfile(detected: ProfileInfo, explicit?: AnalysisProfile): ProfileInfo {
  if (explicit) {
    return {
      profile: explicit,
      profileConfidence: 1,
      profileReasons: [`Explicitly set to '${explicit}' profile`],
    };
  }
  return detected;
}
