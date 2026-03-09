import type {
  BoundaryHotspot,
  BoundaryPolicyConfig,
  BoundaryPolicyRule,
  BoundaryPolicyViolation,
  BoundarySummary,
  BoundaryType,
  TrustLevel,
  TrustZoneCrossing,
  TrustZoneDefinition,
} from "../types.js";

// --- Trust level risk ordering ---

/** Numeric risk rank for each trust level (higher = riskier) */
const TRUST_LEVEL_RISK: Record<TrustLevel, number> = {
  "generated-local": 1,
  "internal-only": 0,
  "semi-trusted-external": 3,
  "trusted-local": 2,
  unknown: 5,
  "untrusted-external": 4,
};

/** Base risk scores by boundary type for hotspot computation */
const BOUNDARY_TYPE_BASE_RISK: Record<BoundaryType, number> = {
  IPC: 65,
  "UI-input": 85,
  config: 25,
  database: 70,
  env: 45,
  filesystem: 55,
  network: 90,
  queue: 75,
  sdk: 40,
  serialization: 60,
  "trusted-local": 10,
  unknown: 50,
};

/**
 * Evaluate boundary policies against a boundary summary.
 *
 * Checks each boundary inventory entry against the configured policy rules
 * and returns violations for entries that fail policy requirements.
 *
 * @example
 * ```ts
 * const violations = evaluateBoundaryPolicies({
 *   summary: boundarySummary,
 *   config: { policies: [{ name: "network-validation", source: "network", requiresValidation: true, severity: "error" }] },
 * });
 * ```
 */
export function evaluateBoundaryPolicies(opts: {
  summary: BoundarySummary;
  config: BoundaryPolicyConfig;
}): BoundaryPolicyViolation[] {
  const { summary, config } = opts;
  const violations: BoundaryPolicyViolation[] = [];

  if (!config.policies || config.policies.length === 0) {
    return violations;
  }

  for (const entry of summary.inventory) {
    for (const policy of config.policies) {
      const violation = checkPolicyRule({
        boundaryType: entry.boundaryType,
        description: entry.description,
        file: entry.file,
        hasValidation: entry.hasValidation,
        line: entry.line,
        policy,
      });
      if (violation) {
        violations.push(violation);
      }
    }
  }

  return violations;
}

/**
 * Detect trust zone crossings in the boundary inventory.
 *
 * Compares each boundary entry's file path against configured trust zone definitions
 * to identify data flowing between zones of different trust levels.
 *
 * @example
 * ```ts
 * const crossings = detectTrustZoneCrossings({
 *   summary: boundarySummary,
 *   trustZones: [
 *     { name: "api", paths: ["src/api/**"], trustLevel: "untrusted-external" },
 *     { name: "core", paths: ["src/core/**"], trustLevel: "internal-only" },
 *   ],
 * });
 * ```
 */
export function detectTrustZoneCrossings(opts: {
  summary: BoundarySummary;
  trustZones: TrustZoneDefinition[];
}): TrustZoneCrossing[] {
  const { summary, trustZones } = opts;
  const crossings: TrustZoneCrossing[] = [];

  if (trustZones.length < 2) {
    return crossings;
  }

  for (const entry of summary.inventory) {
    const entryZone = resolveZoneForFile(entry.file, trustZones);
    if (!entryZone) {
      continue;
    }

    // Check taint breaks for cross-zone data flow
    for (const taintBreak of summary.taintBreaks) {
      if (taintBreak.file !== entry.file) {
        continue;
      }

      // Find the zone of the sink
      const sinkZone = resolveZoneForFile(taintBreak.file, trustZones);
      if (!sinkZone || sinkZone.name === entryZone.name) {
        continue;
      }

      // Only flag crossings where data moves from less trusted to more trusted zones
      const sourceRisk = TRUST_LEVEL_RISK[entryZone.trustLevel];
      const sinkRisk = TRUST_LEVEL_RISK[sinkZone.trustLevel];
      if (sourceRisk > sinkRisk) {
        crossings.push({
          dataFlow: `${taintBreak.source} -> ${taintBreak.sink}`,
          file: entry.file,
          fromZone: entryZone.name,
          line: entry.line,
          toZone: sinkZone.name,
        });
      }
    }

    // Also flag unvalidated boundaries crossing into trusted zones
    if (!entry.hasValidation) {
      for (const zone of trustZones) {
        if (zone.name === entryZone.name) {
          continue;
        }

        const entryRisk = TRUST_LEVEL_RISK[entryZone.trustLevel];
        const zoneRisk = TRUST_LEVEL_RISK[zone.trustLevel];

        // Unvalidated data from a risky zone near a trusted zone is suspect
        if (entryRisk > zoneRisk && fileMatchesZonePaths(entry.file, zone.paths)) {
          crossings.push({
            dataFlow: `Unvalidated ${entry.boundaryType} boundary`,
            file: entry.file,
            fromZone: entryZone.name,
            line: entry.line,
            toZone: zone.name,
          });
        }
      }
    }
  }

  return crossings;
}

/**
 * Compute boundary hotspots ranked by risk.
 *
 * Identifies the highest-risk unvalidated boundaries based on boundary type,
 * trust level, and concentration of violations.
 *
 * @example
 * ```ts
 * const hotspots = computeBoundaryHotspots(boundarySummary);
 * // => [{ file: "api.ts", line: 42, boundaryType: "network", riskScore: 92, ... }]
 * ```
 */
export function computeBoundaryHotspots(summary: BoundarySummary): BoundaryHotspot[] {
  const hotspots: BoundaryHotspot[] = [];

  // Count unvalidated boundaries per file for concentration scoring
  const fileViolationCounts = new Map<string, number>();
  for (const entry of summary.inventory) {
    if (!entry.hasValidation) {
      const count = fileViolationCounts.get(entry.file) ?? 0;
      fileViolationCounts.set(entry.file, count + 1);
    }
  }

  for (const entry of summary.inventory) {
    // Only flag unvalidated boundaries as hotspots
    if (entry.hasValidation) {
      continue;
    }

    const riskScore = computeEntryRiskScore({
      boundaryType: entry.boundaryType,
      fileViolationCount: fileViolationCounts.get(entry.file) ?? 1,
      trustLevel: entry.trustLevel,
    });

    hotspots.push({
      boundaryType: entry.boundaryType,
      description: entry.description,
      file: entry.file,
      line: entry.line,
      riskScore,
      trustLevel: entry.trustLevel,
    });
  }

  // Sort by risk score descending
  hotspots.sort((left, right) => right.riskScore - left.riskScore);

  return hotspots;
}

// --- Internal helpers ---

/**
 * Check a single boundary entry against a policy rule.
 */
function checkPolicyRule(opts: {
  file: string;
  line: number;
  boundaryType: BoundaryType;
  hasValidation: boolean;
  description: string;
  policy: BoundaryPolicyRule;
}): BoundaryPolicyViolation | undefined {
  const { file, line, boundaryType, hasValidation, description, policy } = opts;

  // Only apply policy to matching boundary types
  if (policy.source !== boundaryType) {
    return undefined;
  }

  // Check validation requirement
  if (policy.requiresValidation && !hasValidation) {
    return {
      boundaryType,
      description: `Policy "${policy.name}" requires validation for ${boundaryType} boundaries: ${description}`,
      file,
      line,
      policy: policy.name,
      severity: policy.severity,
    };
  }

  return undefined;
}

/**
 * Resolve the trust zone for a file path, returning the first matching zone.
 */
function resolveZoneForFile(
  filePath: string,
  trustZones: TrustZoneDefinition[],
): TrustZoneDefinition | undefined {
  for (const zone of trustZones) {
    if (fileMatchesZonePaths(filePath, zone.paths)) {
      return zone;
    }
  }
  return undefined;
}

/**
 * Check if a file path matches any of the zone path patterns.
 *
 * Supports simple glob-like patterns with ** for directory matching.
 */
function fileMatchesZonePaths(filePath: string, zonePaths: string[]): boolean {
  for (const pattern of zonePaths) {
    if (matchSimpleGlob(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Simple glob matching for zone path patterns.
 *
 * Handles ** for multi-directory matching and * for single-segment matching.
 */
function matchSimpleGlob(filePath: string, pattern: string): boolean {
  // Exact prefix match (without trailing **)
  const prefix = pattern.replace(/\*\*.*$/, "").replace(/\*.*$/, "");
  if (prefix && filePath.includes(prefix)) {
    return true;
  }

  // Direct substring match for simple patterns
  if (!pattern.includes("*") && filePath.includes(pattern)) {
    return true;
  }

  return false;
}

/**
 * Compute the risk score for a single boundary entry.
 */
function computeEntryRiskScore(opts: {
  boundaryType: BoundaryType;
  trustLevel: TrustLevel;
  fileViolationCount: number;
}): number {
  const { boundaryType, trustLevel, fileViolationCount } = opts;

  // Start with base risk from boundary type
  let riskScore = BOUNDARY_TYPE_BASE_RISK[boundaryType] ?? 50;

  // Amplify by trust level (untrusted = higher risk)
  const trustRisk = TRUST_LEVEL_RISK[trustLevel] ?? 3;
  const trustMultiplier = 0.8 + trustRisk * 0.1;
  riskScore = Math.round(riskScore * trustMultiplier);

  // Concentration bonus: files with many violations are riskier
  if (fileViolationCount > 1) {
    const concentrationBonus = Math.min(fileViolationCount * 3, 15);
    riskScore += concentrationBonus;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, riskScore));
}
