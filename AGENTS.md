# typegrade Agent Rules

## Train/Eval Quarantine

This project enforces a hard separation between training data and evaluation data
to prevent overfitting. The quarantine rules below are mandatory for all agents.

### Builder Agent Rules

The builder agent (the agent that modifies scoring code, weights, and calibration):

**MAY:**
- Read and modify all scoring code under `src/`
- Read and modify train manifests: `benchmarks/manifest.json`, `benchmarks/manifest.train.json`
- Read and modify train assertions: `benchmarks/assertions.ts`
- Read train results: `benchmarks/results/`
- Run: `pnpm benchmark:train`, `pnpm gate:train`, `pnpm benchmark:optimize`, `pnpm benchmark:calibrate`
- React to **aggregate** eval metrics from redacted summaries (pass/fail + aggregate numbers only)

**MUST NOT:**
- Open or read `benchmarks/manifest.eval.fixed.json`
- Open or read `benchmarks/manifest.eval.pool.json`
- Open or read any raw eval artifact under `benchmarks-output/eval-raw/`
- Run `pnpm benchmark:eval`, `pnpm benchmark:pool`, `pnpm benchmark:judge`, or `pnpm gate:eval`
- Reference eval package names or per-package eval scores in any code change rationale

### Judge Agent / CI Rules

The judge agent (or CI pipeline) runs evaluation and produces redacted summaries:

**MAY:**
- Run: `pnpm benchmark:eval`, `pnpm benchmark:pool`, `pnpm benchmark:judge`, `pnpm gate:eval`
- Read eval manifests and raw eval output
- Emit aggregate metrics and gate pass/fail results

**MUST NOT:**
- Modify scoring code (`src/`), calibration weights (`src/constants.ts`), or train assertions
- Emit per-package eval rankings or scores in builder-visible output (unless explicit audit mode)

### Quarantine Boundaries (enforced by CI)

1. **Static import test**: Calibration/optimizer code (`benchmarks/calibrate.ts`, `benchmarks/optimize.ts`)
   must not import or reference eval manifests or eval summary paths.
2. **Output isolation**: Eval commands must write raw results to `benchmarks-output/eval-raw/`,
   never to `benchmarks/results/` (which is train-only).
3. **Redaction**: `benchmark:judge` emits only `RedactedEvalSummary` to
   `benchmarks-output/eval-summary.json` — no package names, no per-package scores.

### Failure Output Visibility

- Builder-visible failure output contains only gate names and aggregate metrics.
- Raw eval details are available only in explicit audit mode (`--audit` flag on judge commands).
