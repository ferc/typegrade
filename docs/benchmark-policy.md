# Benchmark Policy

This document describes the governance rules for the tsguard benchmark suite.

## Corpus

The benchmark corpus consists of real npm packages across three tiers:

| Tier | Packages | Expected Behavior |
|------|----------|-------------------|
| Elite | valibot, effect, ts-pattern, arktype, zod | Highest consumer API scores |
| Solid | date-fns, remeda, type-fest, drizzle-orm, neverthrow | Mid-range scores |
| Loose | lodash, express, axios, uuid, moment | Lowest consumer API scores |
| Stretch | fp-ts, io-ts, rxjs, hono | Extended validation |

## Assertion Classes

Each pairwise assertion has a class:

### must-pass

Tier-boundary assertions that encode fundamental ranking correctness. If a must-pass assertion fails, the benchmark suite exits with code 1.

**Examples:**
- `zod > express` — elite must beat loose
- `date-fns > lodash` — solid must beat loose
- `effect > axios` — elite must beat loose

### diagnostic

Intra-tier and nuanced cross-tier assertions. Failures are reported as warnings but do not cause benchmark failure.

**Examples:**
- `valibot > zod` — intra-elite ordering
- `remeda > axios` — solid vs loose

## Running Benchmarks

```bash
pnpm benchmark        # Score all packages, evaluate assertions
npx tsx benchmarks/calibrate.ts  # Analyze rankings and suggest adjustments
```

## Adding New Assertions

1. Determine the expected ranking relationship
2. Classify as `must-pass` (tier boundary) or `diagnostic` (intra-tier)
3. Add to `benchmarks/assertions.ts`
4. Run the benchmark to verify

## Calibration

The calibration tool (`benchmarks/calibrate.ts`) provides:

- Sorted scores by consumerApi
- Per-assertion pass/fail with deltas
- Ranking loss calculation: `failed / evaluated`
- Per-dimension concordance analysis
- Weight sensitivity analysis (perturb ±0.05)
- Weight adjustment suggestions when ranking loss > 10%

## Policy Rules

1. **Must-pass assertions must always pass.** If a code change causes a must-pass failure, the change needs investigation.
2. **Diagnostic assertions are aspirational.** They guide scoring improvements but don't block releases.
3. **New packages require at least 2 pairwise assertions** — one must-pass (vs different tier) and one diagnostic.
4. **Weight changes require full benchmark run** with all must-pass assertions passing.
5. **Ranking loss target: < 10%.** Above this threshold, calibration suggests weight adjustments.
