export type { AnalysisProfile, ProfileInfo } from "../types.js";

/** Signals used to detect the analysis profile */
export interface ProfileSignals {
  /** Has package.json with types/typings/exports fields */
  hasPublishableTypes: boolean;
  /** Has bin or scripts indicating app/tooling */
  hasBinOrScripts: boolean;
  /** Has HTTP/network frameworks (express, fastify, etc.) */
  hasNetworkFrameworks: boolean;
  /** Has CLI frameworks (commander, yargs, etc.) */
  hasCliFrameworks: boolean;
  /** Has test frameworks as primary deps (not devDeps) */
  hasTestFrameworkDeps: boolean;
  /** Number of entry points in package.json exports */
  entryPointCount: number;
  /** Ratio of .d.ts files to total analyzed files */
  declarationFileRatio: number;
  /** Has tsconfig with declaration: true */
  emitsDeclarations: boolean;
  /** Source file count */
  sourceFileCount: number;
  /** Whether we're in package (npm install) mode */
  isPackageMode: boolean;
}
