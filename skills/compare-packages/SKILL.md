---
name: compare-packages
description: >
  Compare two npm packages side-by-side with typegrade compare. Shows global
  score deltas, domain fit, and confidence for both packages. Covers reading
  comparison output, understanding deltas, and avoiding cross-domain or
  cross-mode comparison mistakes. Use when choosing between alternative
  dependencies.
type: core
library: typegrade
library_version: "0.13.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:src/cli.ts"
  - "ferc/typegrade:src/compare.ts"
  - "ferc/typegrade:src/fit-compare.ts"
---

# typegrade — Compare Packages

Use `typegrade compare` to evaluate two npm packages side-by-side on type
precision. Both packages are scored in package mode (8 consumer dimensions)
and displayed with deltas.

## Setup

```bash
npx typegrade compare zod valibot
```

Scores both packages and prints global scores, domain scores, and deltas.

## Core Patterns

### Basic comparison

```bash
npx typegrade compare zod valibot
```

Output leads with a decision report showing the recommendation (clear-winner,
marginal-winner, equivalent, incomparable, or abstained), confidence level,
key decision factors, and any blockers. Below that, Consumer API, Agent
Readiness, and Type Safety scores for both packages are shown with signed
deltas (positive means the first package scores higher). The comparison
engine considers 5 metrics: consumerApi, agentReadiness, typeSafety,
declarationFidelity, and boundaryDiscipline.

### JSON comparison for automation

```bash
npx typegrade compare zod valibot --json
```

Returns `{ "comparison": { "first": AnalysisResult, "second": AnalysisResult } }`.
Each result is a full `AnalysisResult` object.

### Domain override

```bash
npx typegrade compare zod valibot --domain validation
```

Forces both packages to be scored under the validation domain weights.
Without this, domain is auto-detected per package.

### Skip cache for fresh comparison

```bash
npx typegrade compare zod valibot --no-cache
```

Forces fresh install and analysis of both packages.

## Reading the Output

The comparison table shows:

```
                      zod             valibot         Delta
────────────────────────────────────────────────────────────
Consumer API          67              71              -4
Agent Readiness       71              74              -3
Type Safety           65              69              -4

Domain Fit (validation) 72           75
```

- **Positive delta** means the first package scores higher.
- **Negative delta** means the second package scores higher.
- Domain fit only appears when both packages resolve to the same domain
  or when a domain override is specified.

## Programmatic API

```typescript
import { comparePackages } from "typegrade";

const comparison = comparePackages("zod", "valibot");
// comparison.first: AnalysisResult
// comparison.second: AnalysisResult
// comparison.deltas: per-composite score differences
```

## Common Mistakes

### HIGH — Comparing packages from different domains on domain scores

Wrong:

```bash
npx typegrade compare zod express
# Domain scores show zod=72 (validation), express=48 (router)
# "zod is 24 points better" — misleading
```

Correct:

```bash
npx typegrade compare zod express
# Only compare global scores (consumerApi, agentReadiness, typeSafety)
# Domain scores use different weight schemes and are not cross-comparable
```

Global scores use fixed weights and are comparable across all libraries.
Domain-fit scores use domain-specific adjustments (routers weight path-param
inference differently than validators weight schema precision). Only compare
domain scores between libraries in the same domain.

### MEDIUM — Ignoring confidence when deltas are small

Wrong:

```bash
npx typegrade compare lib-a lib-b
# Agent Readiness: 68 vs 66, delta +2
# "lib-a is better" — premature conclusion
```

Correct:

```bash
npx typegrade compare lib-a lib-b --json | jq '.comparison | {
  first_confidence: .first.confidenceSummary.sampleCoverage // 0,
  second_confidence: .second.confidenceSummary.sampleCoverage // 0,
  first_status: .first.status,
  second_status: .second.status
}'
# If either has low confidence or degraded status, a 2-point delta is noise
```

Small deltas (under 5 points) are often within confidence margins. Check
`confidenceSummary.sampleCoverage` and `status` for both packages before
acting on narrow differences.

### MEDIUM — Using compare for source-vs-package evaluation

Wrong:

```bash
# Trying to compare local project against a published package
npx typegrade compare ./src zod
# compare only works with two package specifiers
```

Correct:

```bash
# Score each separately with the appropriate command
npx typegrade analyze ./src --json > local.json
npx typegrade score zod --json > zod.json
# Compare JSON output manually, noting the mode difference
```

`typegrade compare` only accepts npm package specifiers. To compare a local
project against a published package, run `analyze` and `score` separately
and compare the overlapping 8 consumer dimensions.

For version-to-version comparison of the same package, use `typegrade diff`:

```bash
npx typegrade diff my-lib@1.0 my-lib@2.0
```

`diff` produces per-composite and per-dimension deltas with direction indicators.

## Codebase-Aware Comparison (fit-compare)

For choosing which library fits a specific codebase better:

```bash
npx typegrade fit-compare zod valibot --against ./my-app
```

This scores both packages and also analyzes the local codebase, then produces
a fit assessment considering:

- Package quality (decision score)
- Domain compatibility with the codebase
- Type safety alignment
- Boundary discipline compatibility
- Migration risk (API mismatch, typing, boundary)

The output includes migration risk levels and first migration steps.

### JSON output

```bash
npx typegrade fit-compare zod valibot --against . --json
```

Returns a `FitCompareResult` with `candidateA`, `candidateB`, `codebase`,
`adoptionDecision`, and `firstMigrationBatches`.

### Programmatic API

```typescript
import { fitCompare } from "typegrade";
const result = fitCompare("zod", "valibot", { codebasePath: "./my-app" });
console.log(result.adoptionDecision.outcome, result.adoptionDecision.winner);
```
