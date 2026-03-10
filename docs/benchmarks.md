# Benchmarks

This document explains how to run and interpret `typegrade` benchmarks.

## Running benchmarks

### Train benchmarks

Score all packages in the train corpus and evaluate assertions:

```bash
pnpm benchmark:train
```

This scores every package in `benchmarks/manifest.train.json`, runs pairwise assertions from `benchmarks/assertions.ts`, and reports pass/fail results.

### Holdout benchmarks

Score the holdout corpus (reserved packages not used for tuning):

```bash
pnpm benchmark:holdout
```

### Calibration analysis

Run the calibration tool for detailed diagnostics:

```bash
pnpm benchmark:calibrate
```

This produces:

- Sorted scores by `consumerApi`, `agentReadiness`, and `typeSafety`.
- Per-assertion pass/fail with deltas and `minDelta` enforcement.
- Ranking loss calculation: `failed / evaluated`.
- Per-dimension concordance analysis.
- Tie analysis (packages with delta < 2).
- False equivalence analysis (different-tier packages with delta < 3).
- Margin analysis (must-pass assertions with delta < 5).
- Weight sensitivity analysis (simulates +/-20% perturbation).
- Delta histogram by assertion class.
- Top misranked packages.

### Weight optimization

Search for better weights using train data only:

```bash
pnpm benchmark:optimize
```

### Gate commands

```bash
pnpm gate:train    # Run train gate (must-pass assertions + ranking loss)
pnpm gate:holdout  # Run holdout gate (reserved validation set)
pnpm gate:eval     # Run eval gate (main branch only — Pareto, seed robustness, drift)
pnpm gate:shadow   # Run shadow gate (judge-only — random npm package generalization)
```

## Corpus structure

The benchmark corpus is split to prevent overfitting:

- **Train**: packages used for weight tuning and calibration. Builder agents may read and modify.
- **Eval-fixed**: stable set for generalization testing. Builder agents must NOT read.
- **Eval-pool**: large pool for stratified sampling. Builder agents must NOT read.
- **Holdout**: reserved for final validation. Builder agents may read results but must not tune against them.

See [Benchmark Policy](benchmark-policy.md) for quarantine rules.

### Split-specific result directories

Benchmark results are stored in split-specific subdirectories to prevent cross-contamination:

- **Train results**: `benchmarks/results/train/`
- **Holdout results**: `benchmarks/results/holdout/`
- **Eval results**: `benchmarks-output/eval-raw/` (judge-only, never in `benchmarks/results/`)
- **Shadow results**: `benchmarks-output/shadow-raw/` (judge-only, never in `benchmarks/results/`)

## Interpreting results

### Assertion results

Each assertion is a pairwise ranking claim: "package A should score higher than package B on composite X."

- **PASS**: the assertion holds, with delta meeting any `minDelta` requirement.
- **FAIL**: the higher-expected package scored lower.
- **MARGIN**: the assertion direction is correct, but delta is below `minDelta`.

### Ranking loss

```
ranking loss = failed assertions / evaluated assertions
```

Target: < 5%. Above this, calibration will suggest weight adjustments.

### What benchmarks prove and don't prove

**Benchmarks can show:**

- Relative ranking correctness (does a type-safe library outscore a loosely-typed one?).
- Weight stability (do small weight changes flip important assertions?).
- Cross-version consistency (does a library's score track expected improvements?).

**Benchmarks cannot show:**

- Absolute quality (a score of 70 does not mean "70% good").
- Future performance (scores depend on the current analyzer implementations).
- Universal ordering (different composites may rank the same libraries differently, and that's correct).

### Confidence and undersampling

Some benchmark packages may be undersampled (few public declarations, fallback glob resolution). Check `coverageDiagnostics` and `confidenceSummary` in benchmark output:

- **Undersampled packages** get confidence caps and should not be used as strong ranking anchors.
- **Fallback glob packages** have confidence capped at 0.55.

## Self-referential gates

Two additional gates validate typegrade's own output quality:

### self-analysis-quality

Runs typegrade on its own codebase and checks that minimum scores are met:

- `consumerApi` >= 40
- `typeSafety` >= 40

This ensures the tool's own type quality does not regress below acceptable thresholds.

### agent-loop-coherence

Validates that the `self-analyze` agent report has a consistent structure. Checks that the report contains:

- `issues` — detected type quality issues
- `fixBatches` — grouped fix recommendations
- `stopConditions` — criteria for halting the agent loop
- `verificationSteps` — steps to verify applied fixes

This gate prevents structural regressions in the agent-facing output format.

## Shadow validation

The shadow validation track (`pnpm benchmark:shadow` / `pnpm gate:shadow`) measures generalization on random npm packages sampled from the eval pool. It is a **judge-only** command: raw per-package results are written to `benchmarks-output/shadow-raw/`, and only a `RedactedShadowSummary` is builder-visible.

### What shadow validation checks

Shadow validation scores a random sample of npm packages and measures aggregate trust contract behavior:

| Metric                      | Description                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| `comparableRate`            | Proportion of packages producing comparable (trusted or directional) results      |
| `abstentionCorrectnessRate` | Proportion of packages where abstention (degraded/not-comparable) was appropriate |
| `falseAuthoritativeRate`    | Proportion of packages that received trusted classification despite poor data     |
| `installFailureRate`        | Proportion of packages that failed to install                                     |
| `fallbackGlobRate`          | Proportion of packages that fell back to glob resolution                          |
| `domainOverreachRate`       | Proportion of domain inferences on packages without clear domain signals          |
| `scenarioOverreachRate`     | Proportion of scenario scores on packages without matching domain                 |
| `scoreCompressionRate`      | Proportion of scores clustering in a narrow band                                  |
| `crossRunStability`         | Stability coefficient across repeated runs (1.0 = perfectly stable)               |

The `RedactedShadowSummary` also includes 99% confidence bounds for key metrics and stratification breakdowns by types source, size band, and module kind. No package names or per-package scores are included.

### Shadow gates

The `pnpm gate:shadow` command reads the saved `benchmarks-output/shadow-summary.json` and checks it against gate thresholds. It does not re-run the shadow benchmark — it validates the most recent summary. Gate results are emitted as pass/fail with aggregate metrics only.

Checks include:
- Summary freshness (must be within 24 hours).
- All shadow gates from the saved summary passed.
- Aggregate assertions: degraded rate, comparable rate, domain coverage, and scenario coverage.

## Aggregate assertions

Holdout and shadow tracks use aggregate assertions (`AggregateAssertion` in `benchmarks/types.ts`) instead of per-package pairwise assertions. These are quarantine-compliant: they check only aggregate rates (degraded rate, fallback rate, comparable rate, domain/scenario coverage) with no package-specific logic.

- **Holdout assertions** (`HOLDOUT_ASSERTIONS`): strict, zero-tolerance — all holdout packages must produce complete, non-degraded, non-fallback, fully-comparable results.
- **Shadow assertions** (`SHADOW_ASSERTIONS`): relaxed thresholds for random npm packages — degraded rate below 10%, comparable rate above 40%, domain coverage above 70%, scenario coverage above 35%.

## Schema versioning

Both `RedactedEvalSummary` and `RedactedShadowSummary` include an optional `analysisSchemaVersion` field that records which version of the analysis schema was used for the benchmark run. This enables tracking score changes across schema versions and detecting when benchmark results were produced with an outdated schema.

## Benchmark artifacts

Each benchmark run saves per-package results to split-specific subdirectories under `benchmarks/results/`. Each result includes:

- Dimension scores, confidence, and metrics.
- Graph stats and dedup stats.
- Domain inference with signals and matched rules.
- Top issues.
- Coverage diagnostics.

## Commands reference

| Command                    | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `pnpm benchmark:train`     | Score train corpus, run assertions                           |
| `pnpm benchmark:holdout`   | Score holdout corpus                                         |
| `pnpm benchmark:eval`      | Score eval corpus (CI/judge only)                            |
| `pnpm benchmark:pool`      | Score eval pool with stratified sampling (CI/judge only)     |
| `pnpm benchmark:calibrate` | Detailed calibration diagnostics                             |
| `pnpm benchmark:optimize`  | Weight search on train data                                  |
| `pnpm benchmark:judge`     | Evaluate eval results, emit redacted summary (CI/judge only) |
| `pnpm benchmark:shadow`    | Shadow validation on random npm packages (CI/judge only)     |
| `pnpm gate:train`          | Train gate check                                             |
| `pnpm gate:holdout`        | Holdout gate check                                           |
| `pnpm gate:eval`           | Eval gate check (CI/judge only)                              |
| `pnpm gate:shadow`         | Shadow gate check (reads saved summary, builder-accessible)  |
| `pnpm perf`                | Run all performance benchmarks                               |
| `pnpm perf:cli`            | Measure CLI cold-start (`--version`, `--help`)               |
| `pnpm perf:score`          | Measure `analyze`, `boundaries`, `fix-plan` latency          |
| `pnpm perf:benchmark`      | Measure full train benchmark throughput                      |
| `pnpm perf:ci`             | Run all perf benchmarks with regression checks               |

## Performance benchmarks

The performance harness (`perf/run.ts`) measures built artifacts directly via `node dist/bin.js` subprocess spawning.

### Performance targets (as of 2026-03-09)

| Command                                 | Target (p50) |
| --------------------------------------- | ------------ |
| `typegrade --version`                   | ≤ 40ms       |
| `typegrade --help`                      | ≤ 80ms       |
| `typegrade analyze <fixture> --json`    | ≤ 450ms      |
| `typegrade boundaries <fixture> --json` | ≤ 250ms      |
| `typegrade fix-plan <fixture> --json`   | ≤ 450ms      |

### CI mode

`pnpm perf:ci` compares current measurements against the most recent baseline in `benchmarks-output/perf/` and fails if:

- Any measurement regresses by more than 20% from the previous baseline.
- Any measurement exceeds its target threshold.

Results are written to `benchmarks-output/perf/perf-<timestamp>.json`.
