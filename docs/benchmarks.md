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
pnpm gate:train   # Run train gate (must-pass assertions + ranking loss)
pnpm gate:eval    # Run eval gate (main branch only — Pareto, seed robustness, drift)
```

## Corpus structure

The benchmark corpus is split to prevent overfitting:

- **Train**: packages used for weight tuning and calibration. Builder agents may read and modify.
- **Eval-fixed**: stable set for generalization testing. Builder agents must NOT read.
- **Eval-pool**: large pool for stratified sampling. Builder agents must NOT read.
- **Holdout**: reserved for final validation.

See [Benchmark Policy](benchmark-policy.md) for quarantine rules.

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

## Benchmark artifacts

Each benchmark run saves per-package results to `benchmarks/results/`. Each result includes:
- Dimension scores, confidence, and metrics.
- Graph stats and dedup stats.
- Domain inference with signals and matched rules.
- Top issues.
- Coverage diagnostics.

## Commands reference

| Command | What it does |
|---|---|
| `pnpm benchmark:train` | Score train corpus, run assertions |
| `pnpm benchmark:holdout` | Score holdout corpus |
| `pnpm benchmark:eval` | Score eval corpus (CI/judge only) |
| `pnpm benchmark:pool` | Score eval pool with stratified sampling (CI/judge only) |
| `pnpm benchmark:calibrate` | Detailed calibration diagnostics |
| `pnpm benchmark:optimize` | Weight search on train data |
| `pnpm benchmark:judge` | Evaluate eval results, emit redacted summary (CI/judge only) |
| `pnpm gate:train` | Train gate check |
| `pnpm gate:eval` | Eval gate check (CI/judge only) |
