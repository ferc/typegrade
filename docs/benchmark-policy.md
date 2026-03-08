# Benchmark Policy

This document describes the governance rules for the typegrade benchmark suite.

## Corpus

The benchmark corpus consists of real npm packages across five tiers:

| Tier | Packages | Expected Behavior |
|------|----------|-------------------|
| Elite | valibot, effect, ts-pattern, arktype, zod | Highest consumer API scores |
| Solid | date-fns, remeda, type-fest, drizzle-orm, neverthrow | Mid-range scores |
| Loose | lodash, express, axios, uuid, moment | Lowest consumer API scores |
| Stretch | fp-ts, io-ts, rxjs, hono, @tanstack/react-router | Extended validation |
| Stretch-2 | kysely, xstate, superstruct, runtypes | Hard AI-agent and type-safety cases |

## Assertion Classes

Each pairwise assertion has a class:

### must-pass

Tier-boundary assertions that encode fundamental ranking correctness. If a must-pass assertion fails, the benchmark suite exits with code 1.

**Properties:**
- `minDelta`: Minimum score difference required (typically 3-5 for tier boundaries)
- `reason`: Ground-truth rationale for the assertion
- `introducedAt`: Version when the assertion was added

**Examples:**
- `zod > express (minDelta: 3)` — elite must beat loose
- `arktype > axios (minDelta: 5)` — elite must beat loose with margin
- `neverthrow > moment (minDelta: 2)` — solid must beat loose

### hard-diagnostic

Assertions that do not block the benchmark run, but fail the calibration targets. These represent important cross-composite ranking expectations.

**Examples:**
- `zod > fp-ts` on agentReadiness — Zod should be more agent-friendly
- `zod > express` on typeSafety — validation library must score higher

### diagnostic

Intra-tier and nuanced cross-tier assertions. Failures are reported as warnings but do not cause benchmark failure.

**Examples:**
- `valibot > zod` — intra-elite ordering
- `remeda > axios` — solid vs loose
- `fp-ts > express` — stretch vs loose

### ambiguous

Assertions where the expected outcome is genuinely unclear. Tracked but not counted in loss metrics.

### regression-watch

Assertions that watch for specific regression patterns (e.g., `drizzle-orm` clustering with loose-tier).

## MinDelta Enforcement

Must-pass assertions can specify a `minDelta` — the minimum score difference required for the assertion to pass. A must-pass assertion with `minDelta: 3` fails if:
- The higher package scores lower than the lower package, OR
- The delta is less than 3 (reported as "MARGIN" failure)

## Assertion Metadata

Each assertion carries:
- `reason`: Ground-truth basis for the expected ranking
- `introducedAt`: Version when added (for traceability)
- `owner`: Optional — who added this assertion
- `expectedFailureUntil`: Optional — deadline for fixing known failures

**Removal policy:** No assertion may be removed without a replacement or a written rationale entry in this document.

## Running Benchmarks

```bash
pnpm benchmark        # Score all packages, evaluate assertions
npx tsx benchmarks/calibrate.ts  # Analyze rankings and suggest adjustments
```

## Adding New Assertions

1. Determine the expected ranking relationship
2. Classify as `must-pass`, `hard-diagnostic`, `diagnostic`, `ambiguous`, or `regression-watch`
3. Add `minDelta` for must-pass assertions (typically 3-5)
4. Add `reason` and `introducedAt` strings
5. Add to `benchmarks/assertions.ts`
6. Run the benchmark to verify

## Calibration

The calibration tool (`benchmarks/calibrate.ts`) provides:

- Sorted scores by consumerApi, agentReadiness, and typeSafety
- Per-assertion pass/fail with deltas and minDelta enforcement
- Ranking loss calculation: `failed / evaluated`
- **Per-dimension concordance analysis** — how well each dimension individually predicts assertion outcomes
- **Tie analysis** — packages with near-identical scores (delta < 2)
- **False equivalence analysis** — packages from different tiers with near-identical scores (delta < 3, tier gap >= 2)
- **Margin analysis** — must-pass assertions with uncomfortably small deltas (< 5)
- **Weight sensitivity analysis** — simulates +/-20% weight perturbation, reports how many assertions flip
- **Delta histogram** — with must-pass/hard-diagnostic/diagnostic class breakdown
- **Top misranked packages** — packages that appear most frequently in failed assertions
- Weight adjustment suggestions when ranking loss > 10%

## Benchmark Artifacts

Each benchmark run saves:
- Per-package dimension scores, confidence, and metrics
- Graph stats and dedup stats
- Domain inference with signals, falsePositiveRisk, matchedRules
- Top issues per package
- Explainability data (when enabled)
- Assertion results with deltas and minDelta outcomes
- Caveats from analysis

## Policy Rules

1. **Must-pass assertions must always pass** including minDelta requirements. If a code change causes a must-pass failure, the change needs investigation.
2. **Hard-diagnostic failures do not block**, but fail calibration targets. They must be resolved before a release is considered benchmark-grade.
3. **Diagnostic assertions are aspirational.** They guide scoring improvements but don't block releases.
4. **New packages require at least 2 pairwise assertions** — one must-pass (vs different tier) and one diagnostic.
5. **Weight changes require full benchmark run** with all must-pass assertions passing.
6. **Ranking loss target: < 5%.** Above this threshold, calibration suggests weight adjustments.
7. **Must-pass assertions require `reason` and `minDelta`** to ensure they encode durable, defensible truths.
8. **Every package must appear in at least one must-pass assertion** to ensure meaningful validation.
9. **No solid or elite library may tie a loose library** unless the assertion is explicitly marked ambiguous.
10. **`agentReadiness` must meaningfully differ from `consumerApi`** on at least the hard stretch packages.
