# typegrade Skill Specification

## Library Overview

typegrade is a TypeScript type-safety and precision analyzer. It scores
TypeScript projects and published npm packages on how narrow, specific,
and useful their types are for humans and AI agents.

## Skill Catalog

### Consumer Skills (6)

1. **analyze-project** — Local codebase analysis with `typegrade analyze`.
   Source mode, all 12 dimensions, profile selection, verbose/explain output.

2. **score-package** — Published package evaluation with `typegrade score`.
   Package mode, 8 consumer dimensions, cache control, domain overrides.

3. **compare-packages** — Side-by-side comparison with `typegrade compare`.
   Global score deltas, domain fit, confidence-aware interpretation.

4. **quality-gate** — CI integration with `--min-score`.
   Exit codes, JSON output, handling low-confidence and undersampled results.

5. **consume-json** — Programmatic JSON consumption.
   Stable AnalysisResult fields, confidence handling, undersampling detection.

6. **self-analyze** — Closed-loop improvement with `typegrade self-analyze`.
   Fix batches, risk levels, suppression breakdown, iterative workflows.

### Maintainer Skills (1)

7. **maintain-skills** — Skill maintenance lifecycle.
   Intent validation, stale checks, code-to-skill mapping, version bumps.

## Key Failure Modes

- Low-confidence overreaction: treating scores with confidence < 0.5 as definitive
- Package-vs-source confusion: comparing 8-dimension and 12-dimension scores
- Cross-domain comparison: comparing domain-fit scores across different domains
- Undersampled trust: trusting high scores from packages with few declarations
- Scenario misapplication: using scenario scores outside their domain context

## Source References

- CLI: `src/cli.ts`
- Public API: `src/index.ts`
- Types: `src/types.ts`
- Docs: `docs/how-it-works.md`, `docs/scoring-contract.md`, `docs/confidence-model.md`
