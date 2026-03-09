import type { FileOrigin } from "../types.js";

// Dist/build output patterns — match at path start or after separator
const DIST_PATTERNS = [
  /(?:^|[/\\])dist[/\\]/,
  /(?:^|[/\\])build[/\\]/,
  /(?:^|[/\\])out[/\\]/,
  /\.compiled\./,
];

// Generated artifact patterns (codegen, protobuf, OpenAPI, Prisma, etc.)
const GENERATED_PATTERNS = [
  /\.generated\./,
  /\.gen\./,
  /\.auto\./,
  /\bgraphql\b.*\.ts$/,
  /\bprisma\b.*client/,
  /(?:^|[/\\])__generated__[/\\]/,
  /\.pb\.ts$/,
  /\.swagger\./,
  /openapi.*\.ts$/i,
  /\.output\./,
  /\.trpc\./,
];

// Vendor/third-party patterns
const VENDOR_PATTERNS = [
  /(?:^|[/\\])vendor[/\\]/,
  /(?:^|[/\\])third-party[/\\]/,
  /(?:^|[/\\])third_party[/\\]/,
];

// Test patterns
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /(?:^|[/\\])__tests__[/\\]/,
  /(?:^|[/\\])__mocks__[/\\]/,
  /(?:^|[/\\])__snapshots__[/\\]/,
  /(?:^|[/\\])test[/\\]/,
  /(?:^|[/\\])tests[/\\]/,
];

// Config patterns — match at path start or after separator
const CONFIG_PATTERNS = [
  /(?:^|[/\\])[^/\\]+\.config\.[jt]sx?$/,
  /(?:^|[/\\])tsconfig[^/\\]*\.json$/,
  /(?:^|[/\\])\.eslintrc/,
  /(?:^|[/\\])eslint\.config\./,
];

/**
 * Classify a file path's origin for signal hygiene filtering.
 *
 * The classification determines whether issues from this file should
 * appear in ranked findings by default.
 */
export function classifyFileOrigin(filePath: string): FileOrigin {
  for (const pattern of DIST_PATTERNS) {
    if (pattern.test(filePath)) {
      return "dist";
    }
  }

  for (const pattern of GENERATED_PATTERNS) {
    if (pattern.test(filePath)) {
      return "generated";
    }
  }

  for (const pattern of VENDOR_PATTERNS) {
    if (pattern.test(filePath)) {
      return "vendor";
    }
  }

  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(filePath)) {
      return "test";
    }
  }

  for (const pattern of CONFIG_PATTERNS) {
    if (pattern.test(filePath)) {
      return "config";
    }
  }

  return "source";
}
