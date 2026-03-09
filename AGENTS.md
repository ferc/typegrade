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

## Documentation Freshness

All agents must maintain documentation accuracy as part of every code change.

### Mandatory Review

Before finalizing any change that affects public behavior or positioning, agents must:
- Review `README.md` and the relevant file(s) under `docs/`
- Update docs in the same change when behavior, commands, outputs, scoring logic, benchmark workflows, or config semantics changed
- If no docs change is needed, explicitly state why in the final summary

### Stale Claims Prohibited

The following are prohibited in documentation:
- Outdated version or model descriptions
- Stale benchmark corpus claims (package counts, assertion counts)
- Stale CLI examples that don't match actual commands
- Stale API examples that don't match actual exports
- Benchmark numbers without date stamps

### Docs Checklist

For every substantial change, verify:
- [ ] Did the CLI change? → Update README CLI section + `docs/how-it-works.md`
- [ ] Did JSON output change? → Update README JSON examples
- [ ] Did scoring semantics change? → Update `docs/scoring-contract.md`
- [ ] Did confidence/coverage logic change? → Update `docs/confidence-model.md`
- [ ] Did benchmark commands or interpretation change? → Update `docs/benchmarks.md` + `docs/benchmark-policy.md`
- [ ] Did README positioning need adjustment?
- [ ] Did a docs file become stale because of this change?

### Docs File Mapping

| Subsystem | Documentation File |
|-----------|-------------------|
| CLI commands, flags, output | `README.md` |
| Scoring dimensions, weights, composites | `docs/scoring-contract.md` |
| Confidence, coverage, undersampling | `docs/confidence-model.md` |
| Benchmark commands, corpus, assertions | `docs/benchmarks.md` |
| Benchmark governance, quarantine | `docs/benchmark-policy.md` |
| Architecture, analysis pipeline | `docs/how-it-works.md` |
| Config file format | `README.md` |
| Boundary analysis | `docs/how-it-works.md` |
| Agent/fix-plan output | `README.md` |

### Benchmark Number Rule

Any benchmark number included in README or docs must include the date it was measured. Example: "24 train packages (as of 2026-03-09)".

### Source of Truth

Docs should prefer current repo truth over roadmap or history files. If a doc references a count, version, or capability, verify it against the actual codebase.

## Skill Freshness

This project ships TanStack Intent skills in `skills/`. Skills are treated
like documentation: stale claims are prohibited.

### Mandatory Skill Impact Review

Any change affecting CLI behavior, JSON output, scoring semantics, docs, or
benchmark workflows must trigger a skill impact review. Agents must:

- Update the relevant skill source or shipped SKILL.md in the same change
  when behavior changed
- Run or account for:
  - `pnpm intent:validate` — structural correctness
  - `pnpm intent:stale` — source drift detection
- If no skill change is needed, explicitly state why in the final summary

### Skill-to-Code Mapping

| Change area | Affected skills |
|---|---|
| CLI commands or flags | `analyze-project`, `score-package`, `compare-packages`, `quality-gate` |
| JSON output shape or fields | `consume-json` |
| Scoring dimensions or weights | `analyze-project`, `score-package`, `consume-json` |
| Confidence or coverage logic | `score-package`, `consume-json`, `quality-gate` |
| Self-analyze or agent output | `self-analyze` |
| Domain detection or scenarios | `score-package`, `consume-json` |
| Profile system | `analyze-project`, `quality-gate` |
| Benchmark or CI workflows | `quality-gate`, `maintain-skills` |
| Docs or positioning changes | Review all affected skills |

### Validation Commands

```bash
pnpm intent:validate   # Structural correctness of SKILL.md files
pnpm intent:stale      # Check library_version drift against npm
pnpm intent:list       # Verify skill discoverability
pnpm intent:smoke      # Verify skills are in the publish tarball
```
