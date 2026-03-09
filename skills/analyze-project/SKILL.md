---
name: analyze-project
description: >
  Analyze a local TypeScript project with typegrade analyze. Source mode
  runs all 12 dimensions (8 consumer + 4 implementation). Covers profile
  selection (library, application, autofix-agent), verbose and explain
  flags, domain overrides, confidence interpretation, and reading
  undersampled results. Use when running typegrade on a local codebase.
type: core
library: typegrade
library_version: "0.13.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:docs/how-it-works.md"
  - "ferc/typegrade:docs/scoring-contract.md"
  - "ferc/typegrade:src/cli.ts"
---

# typegrade — Analyze a Local Project

Use `typegrade analyze` to score a local TypeScript project on type precision.
Source mode sees your full source and runs all 12 dimensions.

## Setup

```bash
npx typegrade analyze .
```

This analyzes the current directory. It emits `.d.ts` in memory to see what
consumers see, then scores the public surface plus 4 implementation dimensions
(soundness, boundary discipline, config discipline, declaration fidelity).

## Core Patterns

### Basic analysis with human-readable output

```bash
npx typegrade analyze ./src
```

Prints a summary with a trust label (Trusted, Directional, or Abstained),
global scores (Consumer API, Agent Readiness, Type Safety), domain score
if detected, and top issues.

### Verbose per-dimension breakdown

```bash
npx typegrade analyze . --verbose
```

Adds a table showing all 12 dimension scores with metrics and confidence.

### Explainability report

```bash
npx typegrade analyze . --explain
```

Shows why each score is what it is — which signals contributed, what dragged
scores down, and what would improve them.

### Profile selection

```bash
# Application profile: boosts boundaryDiscipline and configDiscipline
npx typegrade analyze . --profile application

# Library profile (default): balanced consumer-facing weights
npx typegrade analyze . --profile library

# Agent profile: boosts agentUsability, apiSpecificity, surfaceComplexity
npx typegrade analyze . --profile autofix-agent
```

Profiles adjust dimension weights. An application profile downweights
publishQuality (0.3x) because apps rarely publish. The agent profile boosts
dimensions that help AI agents generate correct code.

### Domain override

```bash
# Force validation domain (affects domain-fit scoring weights)
npx typegrade analyze . --domain validation

# Disable domain detection entirely
npx typegrade analyze . --domain off
```

Domain auto-detection uses package name patterns and API surface analysis.
Override when the heuristic misclassifies. Valid domains: `validation`,
`router`, `orm`, `result`, `schema`, `stream`, `state`, `testing`, `cli`,
`frontend`, `utility`, `general`.

### JSON output for automation

```bash
npx typegrade analyze . --json
```

Returns an `AnalysisResult` object with mandatory envelope fields: `status`,
`scoreValidity`, `analysisSchemaVersion`, `globalScores`, `profileInfo`,
`packageIdentity`, and `degradedCategory` (when degraded). Results include a
`trustSummary` with classification (`"trusted"`, `"directional"`, or
`"abstained"`), `canCompare`, and `canGate` flags. A `resolutionDiagnostics`
field traces the acquisition pipeline stages. See the `consume-json` skill
for full field details.

### Include generated issues

```bash
npx typegrade analyze . --include-generated
```

By default, issues from generated files (dist/, build output) are excluded from
`topIssues`. Use `--include-generated` to restore them in the output.

### Agent-optimized output

```bash
npx typegrade analyze . --agent
```

Emits precision-first JSON with fix batches, designed for downstream agent
consumption in iterative improvement workflows.

### Agent control flags

```bash
# Include indirectly fixable issues in the report
npx typegrade analyze . --include-indirect

# Limit actionable issues to N
npx typegrade analyze . --budget 10

# Strict agent mode (lower budget, higher confidence threshold)
npx typegrade analyze . --strict-agent
```

`--include-indirect` adds issues with `fixability: "indirect"` to the output.
`--budget` caps the number of actionable issues (default: 25 in source mode,
50 otherwise). `--strict-agent` enforces conservative filtering with a
`minConfidence` of 0.8 on the agent report.

### Boundary analysis

```bash
npx typegrade boundaries .
```

Analyzes I/O boundary trust and validation coverage — network, filesystem,
env, config, serialization, IPC, database, SDK, and queue boundaries. Shows
a boundary quality score, ranked hotspots with risk scores, recommended fixes,
and taint breaks. In source mode, boundary hotspots and up to 3
recommendations (soundness, boundary, public-surface) are also attached to
the main `AnalysisResult`.

### Fix planning and application

```bash
# Generate a fix plan with confidence and dependency ordering
npx typegrade fix-plan . --json

# Apply safe deterministic fixes
npx typegrade apply-fixes . --mode safe

# Review mode: includes fixes that need human review
npx typegrade apply-fixes . --mode review
```

`fix-plan` produces a `FixPlan` with ordered batches, expected uplift, and
verification commands. `apply-fixes` executes safe fixes and reports
before/after scores.

### Diff two analysis snapshots

```bash
npx typegrade diff my-lib@1.0 my-lib@2.0 --json
```

Compares two package versions and shows per-composite and per-dimension
score deltas.

### Monorepo workspace analysis

```bash
npx typegrade monorepo .
npx typegrade monorepo . --json
```

Analyzes monorepo workspace health: discovers workspace packages, classifies
them into layers (app, domain, infra, ui, data, shared, tooling), detects
layer violations (forbidden cross-layer dependencies, infra bypass, unstable
leaks, trust-zone crossings), and computes a health score.

## Common Mistakes

### HIGH — Comparing source-mode and package-mode scores directly

Wrong:

```bash
npx typegrade analyze .         # Source mode: 12 dimensions, score 72
npx typegrade score my-package  # Package mode: 8 dimensions, score 68
# "We lost 4 points after publishing" — incorrect conclusion
```

Correct:

```bash
# Compare like-for-like:
npx typegrade analyze .         # Source mode: 12 dimensions
npx typegrade analyze .         # Same mode for before/after comparisons

# Or compare package-to-package:
npx typegrade score my-package@1.0  # Package mode
npx typegrade score my-package@2.0  # Same mode
```

Source mode includes 4 implementation dimensions (soundness, boundary
discipline, config discipline, declaration fidelity) that package mode
cannot see. The scores are structurally different and not comparable.

### HIGH — Acting on low-confidence scores without checking confidence

Wrong:

```typescript
const result = JSON.parse(execSync("npx typegrade analyze . --json").toString());
if (result.composites[0].score < 60) {
  throw new Error("Type quality too low");
}
```

Correct:

```typescript
const result = JSON.parse(execSync("npx typegrade analyze . --json").toString());
if (result.status !== "complete") {
  console.warn(`Analysis degraded: ${result.degradedReason}`);
}
const composite = result.globalScores.consumerApi;
if (composite.score < 60 && (result.confidenceSummary?.sampleCoverage ?? 0) >= 0.5) {
  throw new Error("Type quality too low");
}
// If sampleCoverage < 0.5, the score is indicative only
```

Scores with confidence below 0.5 come from undersampled projects with few
public declarations. They should not trigger blocking decisions.

### MEDIUM — Ignoring the profile for non-library projects

Wrong:

```bash
# Analyzing a Next.js app with default (library) profile
npx typegrade analyze .
# Gets penalized on publishQuality even though the app never publishes
```

Correct:

```bash
# Use application profile for apps
npx typegrade analyze . --profile application
```

The default library profile weights publishQuality highly. Applications should
use `--profile application` which downweights publishQuality (0.3x) and boosts
boundaryDiscipline (1.5x) and configDiscipline (1.3x).
