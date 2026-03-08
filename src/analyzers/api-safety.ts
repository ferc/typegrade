import type { DimensionResult, Issue } from "../types.js";
import type { PublicSurface, SurfacePosition } from "../surface/index.js";
import { DIMENSION_CONFIGS } from "../constants.js";
import { analyzePrecision } from "../utils/type-utils.js";
import { detectDomain } from "../domain.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiSafety")!;

export function analyzeApiSafety(surface: PublicSurface, packageName?: string): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  // Domain-aware suppression for validation libraries
  const domain = detectDomain(surface, packageName);
  const suppressUnknownParams = domain.domain === "validation" && domain.confidence >= 0.5;

  let totalPositions = 0;
  let anyPositions = 0;
  let unknownPositions = 0;

  for (const decl of surface.declarations) {
    // Enums have no positions and are not safety-checked
    if (decl.kind === "enum") {
      continue;
    }

    for (const pos of decl.positions) {
      totalPositions++;
      const result = analyzePrecision(pos.type);

      if (result.containsAny) {
        anyPositions++;
        pushAnyIssue(pos, issues);
      } else if (result.containsUnknown) {
        // Suppress unknown warnings for function params in validation libraries
        if (suppressUnknownParams && pos.role === "param" && pos.declarationKind === "function") {
          continue;
        }
        unknownPositions++;
        pushUnknownIssue(pos, issues);
      }
    }
  }

  if (totalPositions === 0) {
    return {
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: { anyPositions: 0, totalPositions: 0, unknownPositions: 0 },
      negatives: [],
      positives: ["No exported positions to check"],
      score: 100,
      weights: CONFIG.weights,
    };
  }

  const anyDensity = anyPositions / totalPositions;
  const unknownDensity = unknownPositions / totalPositions;
  const score = Math.max(0, Math.min(100, Math.round(100 - anyDensity * 80 - unknownDensity * 20)));

  if (anyPositions === 0) {
    positives.push("No 'any' leakage in exported API");
  }
  if (anyPositions > 0) {
    negatives.push(`${anyPositions}/${totalPositions} positions leak 'any'`);
  }
  if (unknownPositions > 0) {
    negatives.push(`${unknownPositions}/${totalPositions} positions contain 'unknown'`);
  }

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: { anyDensity, anyPositions, totalPositions, unknownDensity, unknownPositions },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

/**
 * Issue generation matches original behavior per declaration kind:
 * - Function params: any → error, unknown → warning
 * - Function returns: any → error only
 * - Interface/type-alias/variable: any → error only
 * - Class positions: no issues (just counted)
 */
function pushAnyIssue(pos: SurfacePosition, issues: Issue[]): void {
  // Class positions don't generate issues
  if (pos.declarationKind === "class") {
    return;
  }

  let message: string = undefined as unknown as string;
  if (pos.role === "param" && pos.declarationKind === "function") {
    message = `parameter '${pos.name}' in ${pos.declarationName}() leaks 'any'`;
  } else if (pos.role === "return") {
    message = `${pos.declarationName}() return type leaks 'any'`;
  } else if (pos.role === "property") {
    message = `property '${pos.name}' in ${pos.declarationName} leaks 'any'`;
  } else if (pos.role === "type-body") {
    message = `type '${pos.declarationName}' leaks 'any'`;
  } else if (pos.role === "variable") {
    message = `exported '${pos.name}' leaks 'any'`;
  } else {
    return;
  }

  issues.push({
    column: pos.column,
    dimension: CONFIG.label,
    file: pos.filePath,
    line: pos.line,
    message,
    severity: "error",
  });
}

function pushUnknownIssue(pos: SurfacePosition, issues: Issue[]): void {
  // Only function params generate unknown warnings
  if (pos.role === "param" && pos.declarationKind === "function") {
    issues.push({
      column: pos.column,
      dimension: CONFIG.label,
      file: pos.filePath,
      line: pos.line,
      message: `parameter '${pos.name}' in ${pos.declarationName}() contains 'unknown'`,
      severity: "warning",
    });
  }
}
