/**
 * Statistical utilities for benchmark gates and shadow validation.
 *
 * Provides Wilson score confidence intervals for binomial proportions,
 * used to replace point-threshold gates with statistically rigorous bounds.
 */

/** Z-scores for common confidence levels */
const Z_SCORES = {
  90: 1.645,
  95: 1.96,
  99: 2.576,
} as const;

type ConfidenceLevel = keyof typeof Z_SCORES;

/**
 * Wilson score interval lower bound.
 * Returns the lower bound of the confidence interval for a binomial proportion.
 *
 * Use for lower-bound gates: "success rate is at least X with Y% confidence"
 * Example: wilsonLowerBound(48, 50, 99) → lower bound for 96% success rate at 99% CI
 */
export function wilsonLowerBound(
  successes: number,
  total: number,
  confidence: ConfidenceLevel = 99,
): number {
  if (total === 0) return 0;
  const zz = Z_SCORES[confidence];
  const pHat = successes / total;
  const denominator = 1 + (zz * zz) / total;
  const center = pHat + (zz * zz) / (2 * total);
  const spread = zz * Math.sqrt((pHat * (1 - pHat) + (zz * zz) / (4 * total)) / total);
  return Math.max(0, (center - spread) / denominator);
}

/**
 * Wilson score interval upper bound.
 * Returns the upper bound of the confidence interval for a binomial proportion.
 *
 * Use for upper-bound gates: "failure rate is at most X with Y% confidence"
 * Example: wilsonUpperBound(2, 50, 99) → upper bound for 4% failure rate at 99% CI
 */
export function wilsonUpperBound(
  failures: number,
  total: number,
  confidence: ConfidenceLevel = 99,
): number {
  if (total === 0) return 1;
  const zz = Z_SCORES[confidence];
  const pHat = failures / total;
  const denominator = 1 + (zz * zz) / total;
  const center = pHat + (zz * zz) / (2 * total);
  const spread = zz * Math.sqrt((pHat * (1 - pHat) + (zz * zz) / (4 * total)) / total);
  return Math.min(1, (center + spread) / denominator);
}

/**
 * Minimum sample size needed to bound a rate below a target with the given confidence,
 * assuming zero observed failures.
 *
 * Based on the rule: n >= ln(1 - confidence) / ln(1 - target)
 *
 * Examples:
 *   minSampleForBound(0.01, 0.99) → 459  (need 459 to claim <1% at 99% CI)
 *   minSampleForBound(0.005, 0.99) → 919 (need 919 to claim <0.5% at 99% CI)
 *   minSampleForBound(0.05, 0.99) → 90   (need 90 to claim <5% at 99% CI)
 */
export function minSampleForBound(targetRate: number, confidenceLevel: number = 0.99): number {
  return Math.ceil(Math.log(1 - confidenceLevel) / Math.log(1 - targetRate));
}

/**
 * Format a Wilson CI gate result with bounds for human-readable output.
 *
 * Example: formatCIDetail(2, 50, 0.04, 0.156, 0.05)
 *   → "4.0% (2/50), 99% CI upper: 15.6%, threshold: <5.0%"
 */
export function formatCIDetail(
  failures: number,
  total: number,
  pointRate: number,
  upperBound: number,
  threshold: number,
  confidence: ConfidenceLevel = 99,
): string {
  return `${(pointRate * 100).toFixed(1)}% (${failures}/${total}), ${confidence}%CI upper: ${(upperBound * 100).toFixed(1)}%, threshold: <${(threshold * 100).toFixed(1)}%`;
}

/**
 * Format a Wilson CI lower-bound gate result.
 *
 * Example: formatCILowerDetail(48, 50, 0.96, 0.856, 0.80)
 *   → "96.0% (48/50), 99% CI lower: 85.6%, threshold: >80.0%"
 */
export function formatCILowerDetail(
  successes: number,
  total: number,
  pointRate: number,
  lowerBound: number,
  threshold: number,
  confidence: ConfidenceLevel = 99,
): string {
  return `${(pointRate * 100).toFixed(1)}% (${successes}/${total}), ${confidence}%CI lower: ${(lowerBound * 100).toFixed(1)}%, threshold: >${(threshold * 100).toFixed(1)}%`;
}
