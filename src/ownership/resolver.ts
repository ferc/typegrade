import type { OwnershipClass } from "../types.js";
import type { OwnershipResolution } from "./types.js";

const GENERATED_FILE_PATTERNS = [
  /\.generated\./,
  /\.gen\./,
  /\.auto\./,
  /\bgraphql\b.*\.ts$/,
  /\bprisma\b.*client/,
  /\b__generated__\b/,
  /\.d\.ts$.*node_modules/,
  /\.pb\.ts$/,
  /\.swagger\./,
  /openapi.*\.ts$/i,
];

const NODE_MODULES_PATTERN = /[/\\]node_modules[/\\]/;
const TYPES_PACKAGE_PATTERN = /[/\\]node_modules[/\\]@types[/\\]/;

/**
 * Resolve ownership of a file path.
 */
export function resolveFileOwnership(filePath: string, projectRoot: string): OwnershipResolution {
  // Standard library
  if (filePath.includes("typescript/lib/") || filePath.includes("/lib.")) {
    return {
      confidence: 0.95,
      ownershipClass: "standard-library-owned",
      reason: "TypeScript standard library",
    };
  }

  // Dependency-owned
  if (NODE_MODULES_PATTERN.test(filePath)) {
    const depName = extractDependencyName(filePath);
    const isTypesPackage = TYPES_PACKAGE_PATTERN.test(filePath);
    return {
      confidence: 0.9,
      dependencyPackage: depName,
      ownershipClass: "dependency-owned",
      reason: isTypesPackage ? `@types package: ${depName}` : `Dependency: ${depName}`,
    };
  }

  // Generated files
  for (const pattern of GENERATED_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        confidence: 0.8,
        ownershipClass: "generated",
        reason: `Generated file pattern: ${pattern.source}`,
      };
    }
  }

  // Source-owned: file is under project root and not in node_modules
  if (filePath.startsWith(projectRoot)) {
    return {
      confidence: 0.9,
      ownershipClass: "source-owned",
      reason: "Under project root",
    };
  }

  return {
    confidence: 0.3,
    ownershipClass: "unresolved",
    reason: "Could not determine ownership",
  };
}

/**
 * Resolve ownership for a type that may originate from a dependency.
 *
 * Checks if the type text references known dependency patterns
 * (import paths, known library types).
 */
export function resolveTypeOwnership(
  typeText: string,
  sourceFile: string,
  projectRoot: string,
): OwnershipResolution {
  // If the source file itself is dependency-owned, the type is too
  const fileOwnership = resolveFileOwnership(sourceFile, projectRoot);
  if (fileOwnership.ownershipClass === "dependency-owned") {
    return fileOwnership;
  }

  // Check if the type looks like it comes from a known library
  // This is a heuristic — full resolution would require symbol tracing
  const dependencyTypePatterns = [
    { name: "ts-morph", pattern: /\b(SourceFile|Node|Project|Type|Symbol)\b/ },
    { name: "express", pattern: /\b(Request|Response|NextFunction|Router)\b/ },
    { name: "react", pattern: /\b(ReactNode|ReactElement|FC|JSX\.Element)\b/ },
    { name: "zod", pattern: /\b(ZodType|ZodSchema|ZodObject|ZodString)\b/ },
  ];

  for (const dep of dependencyTypePatterns) {
    if (dep.pattern.test(typeText)) {
      return {
        confidence: 0.6,
        dependencyPackage: dep.name,
        ownershipClass: "dependency-owned",
        reason: `Type matches ${dep.name} pattern`,
      };
    }
  }

  return fileOwnership;
}

/**
 * Classify the overall ownership of a set of issues.
 */
export function classifyBulkOwnership(resolutions: OwnershipResolution[]): OwnershipClass {
  if (resolutions.length === 0) {
    return "unresolved";
  }

  const counts = new Map<OwnershipClass, number>();
  for (const res of resolutions) {
    counts.set(res.ownershipClass, (counts.get(res.ownershipClass) ?? 0) + 1);
  }

  // If all same class, return that
  if (counts.size === 1) {
    return resolutions[0]!.ownershipClass;
  }

  // If majority source-owned, classify as source-owned
  const sourceCount = counts.get("source-owned") ?? 0;
  if (sourceCount > resolutions.length / 2) {
    return "source-owned";
  }

  // Mixed
  return "mixed";
}

function extractDependencyName(filePath: string): string {
  const nmIdx = filePath.lastIndexOf("node_modules/");
  if (nmIdx === -1) {
    return "unknown";
  }
  const afterNm = filePath.slice(nmIdx + "node_modules/".length);
  // Scoped package
  if (afterNm.startsWith("@")) {
    const parts = afterNm.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }
  // Regular package
  const slashIdx = afterNm.indexOf("/");
  return slashIdx > 0 ? afterNm.slice(0, slashIdx) : afterNm;
}
