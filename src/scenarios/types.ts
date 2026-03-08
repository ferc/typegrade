import type { DomainKey, ScenarioResult, ScenarioScore } from "../types.js";
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

  const gradeMap: Record<string, import("../types.js").Grade> = {};
  if (avgScore >= 95) {
    gradeMap.g = "A+";
  } else if (avgScore >= 85) {
    gradeMap.g = "A";
  } else if (avgScore >= 70) {
    gradeMap.g = "B";
  } else if (avgScore >= 55) {
    gradeMap.g = "C";
  } else if (avgScore >= 40) {
    gradeMap.g = "D";
  } else {
    gradeMap.g = "F";
  }

  return {
    domain: pack.domain,
    grade: gradeMap.g!,
    passedScenarios: passedCount,
    results,
    scenario: pack.name,
    score: avgScore,
    totalScenarios: pack.scenarios.length,
  };
}
