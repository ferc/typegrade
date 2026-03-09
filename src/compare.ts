import { type ScorePackageOptions, scorePackage } from "./package-scorer.js";
import type { AnalysisResult } from "./types.js";

export interface CompareOptions extends ScorePackageOptions {
  /** If true, include rendered text comparison in the result */
  render?: boolean;
}

export interface CompareResult {
  resultA: AnalysisResult;
  resultB: AnalysisResult;
  rendered?: string;
}

/**
 * Compare two packages side-by-side on type precision quality.
 *
 * @example
 * ```ts
 * import { comparePackages } from "typegrade";
 * const { resultA, resultB } = comparePackages("zod", "yup");
 * ```
 */
export function comparePackages(
  pkgA: string,
  pkgB: string,
  options?: CompareOptions,
): CompareResult {
  const scoreOpts: ScorePackageOptions = {};
  if (options?.domain !== undefined) {
    scoreOpts.domain = options.domain;
  }
  if (options?.typesVersion !== undefined) {
    scoreOpts.typesVersion = options.typesVersion;
  }
  if (options?.noCache !== undefined) {
    scoreOpts.noCache = options.noCache;
  }
  const resultA = scorePackage(pkgA, scoreOpts);
  const resultB = scorePackage(pkgB, scoreOpts);

  const result: CompareResult = { resultA, resultB };

  if (options?.render) {
    result.rendered = renderTextComparison({ nameA: pkgA, nameB: pkgB, resultA, resultB });
  }

  return result;
}

interface ComparisonInput {
  nameA: string;
  nameB: string;
  resultA: AnalysisResult;
  resultB: AnalysisResult;
}

function renderTextComparison(input: ComparisonInput): string {
  const { nameA, nameB, resultA, resultB } = input;
  const lines: string[] = [
    "",
    "  typegrade comparison",
    "",
    `  ${"".padEnd(22)}${nameA.padEnd(16)}${nameB.padEnd(16)}${"Delta"}`,
    `  ${"─".repeat(60)}`,
  ];

  const compositeKeys = ["consumerApi", "agentReadiness", "typeSafety"] as const;
  const labels: Record<string, string> = {
    agentReadiness: "Agent Readiness",
    consumerApi: "Consumer API",
    typeSafety: "Type Safety",
  };

  for (const key of compositeKeys) {
    const scoreA = resultA.composites.find((comp) => comp.key === key)?.score ?? 0;
    const scoreB = resultB.composites.find((comp) => comp.key === key)?.score ?? 0;
    const delta = scoreA - scoreB;
    let deltaStr = "0";
    if (delta > 0) {
      deltaStr = `+${delta}`;
    } else if (delta < 0) {
      deltaStr = `${delta}`;
    }
    const label = (labels[key] ?? key).padEnd(22);
    lines.push(`  ${label}${String(scoreA).padEnd(16)}${String(scoreB).padEnd(16)}${deltaStr}`);
  }

  // Domain scores if available
  if (resultA.domainScore || resultB.domainScore) {
    lines.push("");
    const domA = resultA.domainScore?.score ?? "n/a";
    const domB = resultB.domainScore?.score ?? "n/a";
    const domainLabel =
      `Domain Fit (${resultA.domainScore?.domain ?? resultB.domainScore?.domain ?? "?"})`.padEnd(
        22,
      );
    lines.push(`  ${domainLabel}${String(domA).padEnd(16)}${String(domB).padEnd(16)}`);
  }

  lines.push("");
  return lines.join("\n");
}
