---
name: score-package
description: >
  Score a published npm package with typegrade score. Package mode analyzes
  published .d.ts declarations (8 consumer dimensions only). Covers
  package specifiers, cache control, domain overrides, interpreting
  confidence and coverage diagnostics, and undersampled packages.
  Use when evaluating an npm dependency.
type: core
library: typegrade
library_version: "0.14.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:docs/how-it-works.md"
  - "ferc/typegrade:docs/confidence-model.md"
  - "ferc/typegrade:src/cli.ts"
  - "ferc/typegrade:src/package-scorer.ts"
---

# typegrade — Score a Published Package

Run `typegrade` with an npm package name to evaluate it on type precision.
Package mode installs the package and analyzes its published `.d.ts`
declarations — the 8 consumer-facing dimensions only.

## Setup

```bash
npx typegrade zod
```

This resolves, installs, and analyzes the `zod` package. Results are cached
by default for repeated runs. The smart root command auto-detects that `zod`
is a package name (not a local path) and runs package mode.

## Core Patterns

### Score with a specific version

```bash
npx typegrade express@5
npx typegrade @tanstack/react-query@5.62.0
```

Uses standard npm specifiers. Scoped packages work as expected.

### Force fresh install (skip cache)

```bash
npx typegrade zod --no-cache
```

Disables the content-addressed cache at `$XDG_CACHE_HOME/typegrade/`.
Use after a new version is published but the cache still holds the old one.

### Verbose dimension breakdown

```bash
npx typegrade score zod --verbose
```

Shows all 8 consumer dimensions with individual scores, metrics, and confidence.
(Use the `score` subcommand for the verbose flag.)

### JSON output

```bash
npx typegrade zod --json
```

Returns a `SmartCliResult` envelope wrapping the full `AnalysisResult`.
See the `consume-json` skill for stable field details.

### Domain override

```bash
npx typegrade zod --domain validation
```

Forces domain classification. Auto-detection is usually correct for
well-known packages, but override when needed. Valid domains: `validation`,
`router`, `orm`, `result`, `schema`, `stream`, `state`, `testing`, `cli`,
`frontend`, `utility`, `general`.

## Interpreting Results

### Global scores

| Score           | What it answers                                                |
| --------------- | -------------------------------------------------------------- |
| Consumer API    | How precise and well-structured is the exported API surface?   |
| Agent Readiness | How well does the API guide AI agents toward correct usage?    |
| Type Safety     | How safe from `any` leaks, unsound casts, and weak boundaries? |

### Grades

| Score | Grade |
| ----- | ----- |
| 95+   | A+    |
| 85-94 | A     |
| 70-84 | B     |
| 55-69 | C     |
| 40-54 | D     |
| 0-39  | F     |

### Trust classification

The CLI displays a trust label after scoring:

- **Trusted** — high confidence, result is comparable and gateable.
- **Directional** — reduced confidence; scores are indicative but not firm.
- **Abstained** — result cannot be meaningfully scored. `--min-score` rejects
  abstained results automatically.

In JSON output, check `trustSummary.classification` (`"trusted"`,
`"directional"`, or `"abstained"`), `trustSummary.canCompare`, and
`trustSummary.canGate` to decide how to act on the result programmatically.

### Status and coverage diagnostics

Check `status` and `coverageDiagnostics` in JSON output:

- `status: "degraded"` means some dimensions could not be scored. Check
  `degradedReason` for details. Degraded results no longer emit fake zeros.
- `coverageDiagnostics.undersampled: true` means very few public declarations
  were found. Scores are capped at 65 and confidence is low.
- `packageIdentity.typesSource` (always present): `"bundled"` means types
  ship with the package. `"@types"` means they come from `@types/`.
  `"mixed"` or `"unknown"` for other layouts.
- `packageIdentity.entrypointStrategy` (always present): `"exports-map"`,
  `"types-field"`, `"main-field"`, `"fallback-glob"`, or `"unknown"`.

## Common Mistakes

### HIGH — Trusting high scores from undersampled packages

Wrong:

```typescript
const result = JSON.parse(execSync("npx typegrade score tiny-lib --json").toString());
// Score is 64, looks decent — adopt it
```

Correct:

```typescript
const result = JSON.parse(execSync("npx typegrade score tiny-lib --json").toString());
if (result.status === "degraded") {
  console.warn(`Degraded: ${result.degradedReason}`);
}
if (result.coverageDiagnostics?.undersampled) {
  // Score is capped at 65, confidence is low — treat as indicative only
  console.warn("Undersampled package, score is unreliable");
}
```

Packages with very few public declarations produce unreliable scores.
The system caps undersampled scores at 65 and flags `undersampled: true`.
Do not use these scores for blocking decisions.

### HIGH — Comparing package-mode scores across domains

Wrong:

```bash
npx typegrade zod          # Domain: validation, score 72
npx typegrade express      # Domain: router, score 55
# "zod is 17 points better than express" — misleading
```

Correct:

```bash
npx typegrade zod          # Domain: validation
npx typegrade valibot      # Domain: validation (same domain)
# Domain scores are comparable because both are validation libraries
```

Global scores (consumerApi, agentReadiness, typeSafety) are comparable
across all libraries. Domain-fit scores use domain-specific weight
adjustments and are only meaningful within the same domain.

### MEDIUM — Ignoring the confidence summary

Wrong:

```typescript
const result = JSON.parse(execSync("npx typegrade score old-lib --json").toString());
const score = result.globalScores.agentReadiness.score;
// Use score directly in automated decisions
```

Correct:

```typescript
const result = JSON.parse(execSync("npx typegrade score old-lib --json").toString());
const ar = result.globalScores.agentReadiness;
if (ar.confidence < 0.5) {
  console.warn(`Agent readiness score ${ar.score} has low confidence (${ar.confidence})`);
}
```

Every composite score carries a confidence value. When confidence is below
0.5, the score comes from limited evidence and should be treated as directional
guidance rather than a firm number.
