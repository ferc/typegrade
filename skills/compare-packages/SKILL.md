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
library_version: "0.15.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:src/cli.ts"
  - "ferc/typegrade:src/compare.ts"
  - "ferc/typegrade:src/fit-compare.ts"
---

# typegrade — Compare Packages

Run `typegrade` with two package names to compare them side-by-side on type
precision. Both packages are scored in package mode (8 consumer dimensions)
and displayed with a recommendation and deltas.

## Setup

```bash
npx typegrade zod valibot
```

Scores both packages and prints a recommendation, global scores, and caveats.
The smart root command auto-detects two package names and runs comparison mode.

## Core Patterns

### Basic comparison

```bash
npx typegrade zod valibot
```

Output leads with a trust badge, headline recommendation, confidence level,
and key reasons. The comparison engine considers consumerApi, agentReadiness,
typeSafety, declarationFidelity, and boundaryDiscipline.

### Codebase-aware fit comparison

```bash
npx typegrade zod valibot --against .
```

Adds `--against` to compare how well each package fits your specific codebase.
Produces a fit assessment with migration risk, domain compatibility, and
first migration steps.

### JSON comparison for automation

```bash
npx typegrade zod valibot --json
```

Returns a `SmartCliResult` with `mode: "package-compare"`. The `primary`
field contains a `SmartComparePayload` with the full comparison data
including `evidenceQualityA`, `evidenceQualityB`, and
`comparisonEligibilityReason`.

### Domain override

```bash
npx typegrade zod valibot --domain validation
```

Forces both packages to be scored under the validation domain weights.
Without this, domain is auto-detected per package.

### Skip cache for fresh comparison

```bash
npx typegrade zod valibot --no-cache
```

Forces fresh install and analysis of both packages.

## Programmatic API

```typescript
import { runSmart, comparePackages } from "typegrade";

// Smart dispatch (recommended)
const { result } = await runSmart(["zod", "valibot"], { json: true });
// result.mode === "package-compare"

// Direct API
const comparison = comparePackages("zod", "valibot");
// comparison.first: AnalysisResult
// comparison.second: AnalysisResult
// comparison.deltas: per-composite score differences
```

## Common Mistakes

### HIGH — Comparing packages from different domains on domain scores

Wrong:

```bash
npx typegrade zod express
# Domain scores show zod=72 (validation), express=48 (router)
# "zod is 24 points better" — misleading
```

Correct:

```bash
npx typegrade zod express
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
npx typegrade lib-a lib-b
# Agent Readiness: 68 vs 66, delta +2
# "lib-a is better" — premature conclusion
```

Correct:

```bash
npx typegrade lib-a lib-b --json | jq '.primary.decision.decisionConfidence'
# If confidence is low, a 2-point delta is noise
```

Small deltas (under 5 points) are often within confidence margins. Check
`confidenceSummary.sampleCoverage` and `status` for both packages before
acting on narrow differences. In 0.14.0, also check `evidenceQualityA` and
`evidenceQualityB` on the comparison object — low evidence quality on either
side weakens the comparison.

### MEDIUM — Using compare for source-vs-package evaluation

Wrong:

```bash
# Trying to compare local project against a published package
npx typegrade ./src zod
# Smart dispatch requires two targets of the same kind for comparison
```

Correct:

```bash
# Score each separately
npx typegrade ./src --json > local.json
npx typegrade zod --json > zod.json
# Compare JSON output manually, noting the mode difference
```

The smart root command requires two package names for comparison.
To compare a local project against a published package, score each
separately and compare the overlapping 8 consumer dimensions.

For version-to-version comparison of the same package, use `typegrade diff`:

```bash
npx typegrade diff my-lib@1.0 my-lib@2.0
```

`diff` produces per-composite and per-dimension deltas with direction indicators.

## Codebase-Aware Fit Comparison

For choosing which library fits a specific codebase better:

```bash
npx typegrade zod valibot --against .
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
npx typegrade zod valibot --against . --json
```

Returns a `SmartCliResult` with `mode: "fit-compare"`. The `primary`
field contains a `FitCompareResult` with `candidateA`, `candidateB`,
`codebase`, `adoptionDecision`, and `firstMigrationBatches`.

### Programmatic API

```typescript
import { fitCompare } from "typegrade";
const result = fitCompare("zod", "valibot", { codebasePath: "./my-app" });
console.log(result.adoptionDecision.outcome, result.adoptionDecision.winner);
```
