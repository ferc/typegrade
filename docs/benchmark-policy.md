# Benchmark Policy

This document describes the governance rules for the `typegrade` benchmark suite, including the train/eval split, assertion classes, gate policies, and quarantine boundaries.

## Train/eval split

The benchmark corpus is split into isolated sets to prevent overfitting:

| Set                                         | Purpose                                          | Builder agent access |
| ------------------------------------------- | ------------------------------------------------ | -------------------- |
| **Train** (`manifest.train.json`)           | Tune scoring weights and calibrate               | May read and modify  |
| **Eval-fixed** (`manifest.eval.fixed.json`) | Stable generalization test                       | Must NOT read        |
| **Eval-pool** (`manifest.eval.pool.json`)   | Large stratified pool for statistical validation | Must NOT read        |
| **Holdout** (`manifest.holdout.json`)       | Reserved for final validation                    | Read-only, no tuning |

The `BenchmarkSplit` type covers all four splits: `"train" | "holdout" | "eval-fixed" | "eval-pool"`.

The quarantine policy is enforced by CI and documented in `CLAUDE.md`.

## Assertion classes

Each pairwise assertion has a class:

### must-pass

Tier-boundary assertions that encode fundamental ranking correctness. If a must-pass assertion fails, the gate exits with code 1.

Properties:

- `minDelta`: minimum score difference required (typically 3-5 for tier boundaries).
- `reason`: ground-truth rationale for the assertion.
- `introducedAt`: version when the assertion was added.

A must-pass assertion fails if:

- The higher package scores lower than the lower package, OR
- The delta is less than `minDelta` (reported as a "MARGIN" failure).

### hard-diagnostic

Assertions that do not block the benchmark run but fail calibration targets. These represent important cross-composite ranking expectations.

### diagnostic

Intra-tier and nuanced cross-tier assertions. Failures are reported as warnings but do not cause gate failure.

### ambiguous

Assertions where the expected outcome is genuinely unclear. Tracked but not counted in loss metrics.

### regression-watch

Assertions that watch for specific regression patterns (e.g., a solid-tier library clustering with loose-tier).

## Gate system

Four gates run at different stages:

### Train gate (`pnpm gate:train`)

Runs against the train corpus. Checks:

- All must-pass assertions pass, including `minDelta` requirements.
- Ranking loss is below threshold.

**Runs on every PR.**

### Eval gate (`pnpm gate:eval`)

Runs against the eval corpus. Checks:

- Pareto violations (new regressions not offset by improvements).
- Seed robustness (scores stable across different random seeds).
- Train-eval drift (train performance vs eval performance gap).
- Score compression and domain/scenario overreach.

**Runs on main branch only** — builder agents never see raw eval results.

### Self-analysis-quality gate

Runs typegrade on its own codebase and asserts minimum composite scores:

- `consumerApi` >= 40
- `typeSafety` >= 40

Ensures the tool's own type quality does not regress.

### Holdout gate (`pnpm gate:holdout`)

Runs against the holdout corpus — a reserved set of packages not used for tuning. The holdout gate validates that scoring generalizes beyond the train set.

**Builder agents may run this gate** but must not tune weights to improve holdout results.

### Agent-loop-coherence gate

Validates the `self-analyze` agent report structure. Checks that the report contains the required fields: `issues`, `fixBatches`, `stopConditions`, and `verificationSteps`.

Prevents structural regressions in agent-facing output.

### Shadow gate (`pnpm gate:shadow`)

Reads the saved `benchmarks-output/shadow-summary.json` and checks aggregate metrics against thresholds. Does not re-run the shadow benchmark.

Checks:
- Summary freshness (within 24 hours).
- All saved shadow gates passed.
- Aggregate assertions: degraded rate, comparable rate, domain coverage, scenario coverage.

**Builder-accessible** (reads only aggregate summary). The `benchmark:shadow` command that produces raw results remains judge-only. See [Benchmarks: Shadow validation](benchmarks.md#shadow-validation) for the full metric set.

## Judge system (`pnpm benchmark:judge`)

The judge evaluates eval results and produces a **redacted summary**:

- Emits only aggregate metrics: pass/fail, Pareto violation count, drift magnitude.
- Writes redacted output to `benchmarks-output/eval-summary.json`.
- **Never** emits per-package names, scores, or rankings in builder-visible output.

Raw eval details are only available with the `--audit` flag (explicit audit mode).

## Assertion metadata

Each assertion carries:

- `reason`: ground-truth basis for the expected ranking.
- `introducedAt`: version when added.
- `owner`: optional — who added this assertion.
- `expectedFailureUntil`: optional — deadline for fixing known failures.

**Removal policy**: no assertion may be removed without a replacement or a written rationale.

## Policy rules

1. **Must-pass assertions must always pass**, including `minDelta` requirements.
2. **Hard-diagnostic failures do not block** but fail calibration targets. They must be resolved before a release is considered benchmark-grade.
3. **Diagnostic assertions are aspirational.** They guide scoring improvements but don't block releases.
4. **New packages require at least 2 pairwise assertions** — one must-pass (vs different tier) and one diagnostic.
5. **Weight changes require a full benchmark run** with all must-pass assertions passing.
6. **Ranking loss target: < 5%.** Above this threshold, calibration suggests weight adjustments.
7. **Must-pass assertions require `reason` and `minDelta`** to ensure they encode durable truths.
8. **Every package must appear in at least one must-pass assertion.**
9. **No solid or elite library may tie a loose library** unless the assertion is explicitly marked ambiguous.
10. **`agentReadiness` must meaningfully differ from `consumerApi`** on at least the hard stretch packages.

## Quarantine boundaries

These boundaries are enforced by CI:

1. **Static import test**: calibration/optimizer code must not import or reference eval manifests, eval summaries, or shadow raw output.
2. **Output isolation**: eval commands write to `benchmarks-output/eval-raw/`, shadow commands write to `benchmarks-output/shadow-raw/` — neither writes to `benchmarks/results/`.
3. **Redaction**: `benchmark:judge` emits only `RedactedEvalSummary`, `benchmark:shadow` emits only `RedactedShadowSummary` — no package names, no per-package scores.
4. **Split-specific results**: train results go to `benchmarks/results/train/`, holdout results go to `benchmarks/results/holdout/`. Cross-split result contamination is prevented by directory isolation.

### Builder-forbidden paths

- `benchmarks/manifest.eval.fixed.json`
- `benchmarks/manifest.eval.pool.json`
- `benchmarks-output/eval-raw/`
- `benchmarks-output/shadow-raw/`

### Command access matrix

| Role     | Allowed commands                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Builder  | `benchmark:train`, `benchmark:holdout`, `gate:train`, `gate:holdout`, `gate:shadow`, `benchmark:optimize`, `benchmark:calibrate` |
| Judge/CI | `benchmark:eval`, `benchmark:pool`, `benchmark:judge`, `benchmark:shadow`, `gate:eval`                                           |

## Aggregate assertions

Holdout and shadow tracks use aggregate assertions (`AggregateAssertion` type) rather than per-package pairwise assertions. This preserves quarantine compliance: aggregate assertions check only rates and proportions, never referencing individual package names or scores.

- **`HOLDOUT_ASSERTIONS`**: strict, zero-tolerance (zero degraded, zero fallback, 100% comparable).
- **`SHADOW_ASSERTIONS`**: relaxed thresholds for random npm packages (degraded < 10%, comparable > 40%, domain coverage > 70%, scenario coverage > 35%).

Aggregate assertions are defined in `benchmarks/types.ts` and checked in `benchmarks/gate.ts`.

## Schema versioning

Both `RedactedEvalSummary` and `RedactedShadowSummary` include an `analysisSchemaVersion` field that tracks which analysis schema version produced the benchmark results. This enables:

- Detecting stale benchmark results produced with an older schema.
- Correlating score changes with schema evolution.
- Validating that benchmark evidence matches the current codebase.

The schema version is sourced from `ANALYSIS_SCHEMA_VERSION` in `src/types.ts`.

## Adding new assertions

1. Determine the expected ranking relationship.
2. Classify as `must-pass`, `hard-diagnostic`, `diagnostic`, `ambiguous`, or `regression-watch`.
3. Add `minDelta` for must-pass assertions (typically 3-5).
4. Add `reason` and `introducedAt` strings.
5. Add to `benchmarks/assertions.ts`.
6. Run `pnpm benchmark:train` to verify.

## CI integration

The CI workflow (`.github/workflows/ci.yml`) runs:

- **Quality job** (all PRs): lint, format check, build, test.
- **Train gate job** (all PRs): `pnpm gate:train`.
- **Holdout gate job** (all PRs): `pnpm gate:holdout`.
- **Eval gate job** (main only): `pnpm gate:eval`.
- **Shadow gate job** (main only): `pnpm gate:shadow`.
