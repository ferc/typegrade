import type { DomainKey, Grade, ScenarioResult, ScenarioScore } from "../types.js";
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

  for (const scenario of pack.scenarios) {
    const result = scenario.evaluate(surface, packageName);
    results.push(result);
    totalScore += result.score;
    if (result.passed) {
      passedCount++;
    }
  }

  const avgScore = pack.scenarios.length > 0 ? Math.round(totalScore / pack.scenarios.length) : 0;

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

  return {
    comparability: "scenario",
    domain: pack.domain,
    grade,
    passedScenarios: passedCount,
    results,
    scenario: pack.name,
    score: avgScore,
    totalScenarios: pack.scenarios.length,
  };
}
