# Benchmark Policy

This document describes the governance rules for the tsguard benchmark suite.

## Corpus

The benchmark corpus consists of real npm packages across four tiers:

| Tier | Packages | Expected Behavior |
|------|----------|-------------------|
| Elite | valibot, effect, ts-pattern, arktype, zod | Highest consumer API scores |
| Solid | date-fns, remeda, type-fest, drizzle-orm, neverthrow | Mid-range scores |
| Loose | lodash, express, axios, uuid, moment | Lowest consumer API scores |
| Stretch | fp-ts, io-ts, rxjs, hono, @tanstack/react-router | Extended validation |

## Assertion Classes

Each pairwise assertion has a class:

### must-pass

Tier-boundary assertions that encode fundamental ranking correctness. If a must-pass assertion fails, the benchmark suite exits with code 1.

**Properties:**
- `minDelta`: Minimum score difference required (typically 3-5 for tier boundaries)
- `reason`: Ground-truth rationale for the assertion
- `ambiguity`: Confidence level (low/medium/high)

**Examples:**
- `zod > express (minDelta: 3)` — elite must beat loose
- `arktype > axios (minDelta: 5)` — elite must beat loose with margin
- `neverthrow > moment (minDelta: 2)` — solid must beat loose

### diagnostic

Intra-tier and nuanced cross-tier assertions. Failures are reported as warnings but do not cause benchmark failure.

**Examples:**
- `valibot > zod` — intra-elite ordering
- `remeda > axios` — solid vs loose
- `fp-ts > express` — stretch vs loose

## MinDelta Enforcement

Must-pass assertions can specify a `minDelta` — the minimum score difference required for the assertion to pass. A must-pass assertion with `minDelta: 3` fails if:
- The higher package scores lower than the lower package, OR
- The delta is less than 3 (reported as "MARGIN" failure)

## Running Benchmarks

```bash
pnpm benchmark        # Score all packages, evaluate assertions
npx tsx benchmarks/calibrate.ts  # Analyze rankings and suggest adjustments
```

## Adding New Assertions

1. Determine the expected ranking relationship
2. Classify as `must-pass` (tier boundary) or `diagnostic` (intra-tier)
3. Add `minDelta` for must-pass assertions (typically 3-5)
4. Add `reason` string explaining the ground-truth basis
5. Add to `benchmarks/assertions.ts`
6. Run the benchmark to verify

## Calibration

The calibration tool (`benchmarks/calibrate.ts`) provides:

- Sorted scores by consumerApi
- Per-assertion pass/fail with deltas and minDelta enforcement
- Ranking loss calculation: `failed / evaluated`
- **Per-dimension concordance analysis** — how well each dimension individually predicts assertion outcomes
- **Tie analysis** — packages with near-identical scores (delta < 2)
- **Margin analysis** — must-pass assertions with uncomfortably small deltas (< 5)
- **Weight sensitivity analysis** — simulates ±20% weight perturbation, reports how many assertions flip
- **Delta histogram** — with must-pass/diagnostic class breakdown
- Weight adjustment suggestions when ranking loss > 10%

## Benchmark Artifacts

Each benchmark run saves:
- Per-package dimension scores, confidence, and graph stats
- Domain inference with signals
- Assertion results with deltas and minDelta outcomes
- Caveats from analysis

## Policy Rules

1. **Must-pass assertions must always pass** including minDelta requirements. If a code change causes a must-pass failure, the change needs investigation.
2. **Diagnostic assertions are aspirational.** They guide scoring improvements but don't block releases.
3. **New packages require at least 2 pairwise assertions** — one must-pass (vs different tier) and one diagnostic.
4. **Weight changes require full benchmark run** with all must-pass assertions passing.
5. **Ranking loss target: < 10%.** Above this threshold, calibration suggests weight adjustments.
6. **Must-pass assertions require `reason` and `minDelta`** to ensure they encode durable, defensible truths.
7. **Every package must appear in at least one must-pass assertion** to ensure meaningful validation.
