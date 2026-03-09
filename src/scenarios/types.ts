import type {
  DomainKey,
  Grade,
  ScenarioApplicabilityStatus,
  ScenarioResult,
  ScenarioScore,
  ScenarioVariant,
} from "../types.js";
import type { PublicSurface } from "../surface/index.js";

/** A single scenario test within a domain pack */
export interface ScenarioTest {
  name: string;
  description: string;
  /** Run the scenario against the public surface, return pass/fail + score */
  evaluate: (surface: PublicSurface, packageName?: string) => ScenarioResult;
}

/** A domain scenario pack */
export interface ScenarioPack {
  domain: DomainKey;
  name: string;
  description: string;
  scenarios: ScenarioTest[];
  /** Scenario variant for subfamily selection */
  variant?: ScenarioVariant;
  /** Optional applicability check — if provided, the pack will only run if this returns true */
  isApplicable?: (
    surface: PublicSurface,
    packageName?: string,
  ) => { applicable: boolean; reason: string };
}

/** Check if a scenario pack is applicable to the given surface */
export function isScenarioApplicable(
  pack: ScenarioPack,
  surface: PublicSurface,
  packageName?: string,
): { applicable: boolean; reason: string } {
  if (!pack.isApplicable) {
    return { applicable: true, reason: "No applicability check defined" };
  }
  return pack.isApplicable(surface, packageName);
}

/** Evaluate a scenario pack against a surface */
export function evaluateScenarioPack(
  pack: ScenarioPack,
  surface: PublicSurface,
  packageName?: string,
): ScenarioScore {
  const results: ScenarioResult[] = [];
  let totalScore = 0;
  let passedCount = 0;
  let applicableCount = 0;

  for (const scenario of pack.scenarios) {
    const result = scenario.evaluate(surface, packageName);

    // Derive outcome if not set by the scenario
    if (!result.outcome) {
      result.outcome = result.passed ? "passed" : "failed";
    }

    results.push(result);

    // Only count applicable results in score aggregation
    if (result.outcome !== "not_applicable" && result.outcome !== "insufficient_evidence") {
      totalScore += result.score;
      applicableCount++;
      if (result.passed) {
        passedCount++;
      }
    }
  }

  const avgScore = applicableCount > 0 ? Math.round(totalScore / applicableCount) : 0;

  let grade: Grade = "F";
  if (avgScore >= 95) {
    grade = "A+";
  } else if (avgScore >= 85) {
    grade = "A";
  } else if (avgScore >= 70) {
    grade = "B";
  } else if (avgScore >= 55) {
    grade = "C";
  } else if (avgScore >= 40) {
    grade = "D";
  }

  // Determine pack-level applicability from individual results
  const insufficientCount = results.filter((rr) => rr.outcome === "insufficient_evidence").length;
  const notApplicableCount = results.filter((rr) => rr.outcome === "not_applicable").length;

  const scenarioApplicability = deriveApplicability({
    applicableCount,
    insufficientCount,
    notApplicableCount,
    totalCount: results.length,
  });

  return {
    comparability: "scenario",
    domain: pack.domain,
    grade,
    passedScenarios: passedCount,
    results,
    scenario: pack.name,
    ...(scenarioApplicability ? { scenarioApplicability } : {}),
    ...(pack.variant ? { scenarioVariant: pack.variant } : {}),
    score: avgScore,
    totalScenarios: pack.scenarios.length,
  };
}

/** Derive pack-level applicability from individual scenario outcomes. */
function deriveApplicability(opts: {
  notApplicableCount: number;
  insufficientCount: number;
  applicableCount: number;
  totalCount: number;
}): ScenarioApplicabilityStatus | undefined {
  if (opts.notApplicableCount === opts.totalCount) {
    return "not_applicable";
  }
  if (opts.insufficientCount > opts.totalCount / 2) {
    return "insufficient_evidence";
  }
  if (opts.insufficientCount > 0 || opts.applicableCount < opts.totalCount) {
    return "applicable_but_weak";
  }
  return undefined;
}
