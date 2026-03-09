# typegrade

Score your TypeScript on **type precision** — how narrow, specific, and useful your types actually are for humans and AI agents.

AI coding agents generate better code when they operate within tight static boundaries. Broad types, `any` leaks, and unclear API surfaces cause wrong suggestions, invalid payloads, and brittle edits — whether the consumer is a human or an agent. `typegrade` makes that quality measurable.

Even if you are not using AI agents today, precise types improve editor autocomplete, catch bugs earlier, and make your API surface self-documenting.

## Who it is for

- **Library and package authors** — validate that your published declarations are precise and consumer-friendly before releasing.
- **App teams with internal platforms or SDKs** — enforce type quality standards across shared code.
- **Teams using AI agents** — in CI, refactors, and code generation — ensure the types your agents code against are tight enough to guide correct output.

## What it measures

`typegrade` produces three global scores from up to 12 dimensions:

| Score | What it answers |
|---|---|
| **Consumer API** | How precise and well-structured is your exported API surface? |
| **Agent Readiness** | How well does your API guide AI agents toward correct usage? |
| **Type Safety** | How safe is your code from `any` leaks, unsound casts, and weak boundaries? |

In **source mode** (`typegrade analyze`), all 12 dimensions contribute — 8 consumer-facing plus 4 implementation dimensions (soundness, boundary discipline, config discipline, declaration fidelity).

In **package mode** (`typegrade score`), only the 8 consumer-facing dimensions apply, because published `.d.ts` declarations are all a consumer sees.

Beyond global scores, `typegrade` also computes:
- **Domain-fit scores** — adjusted for validation, router, ORM, stream, and other library categories.
- **Scenario scores** — consumer benchmark tests that measure real downstream DX within a domain.
- **Confidence and coverage diagnostics** — so you know how much evidence supports each score.

## Quickstart

```bash
# Analyze a local TypeScript project (source mode, all 12 dimensions)
npx typegrade analyze .

# Score a published npm package (package mode, 8 consumer dimensions)
npx typegrade score zod
npx typegrade score express@5

# Compare two packages side-by-side
npx typegrade compare zod valibot

# Compare score changes between two packages or versions
npx typegrade diff zod@3.22 zod@3.23

# Analyze boundary trust and validation coverage
npx typegrade boundaries .

# Generate an actionable fix plan with confidence and verification
npx typegrade fix-plan .

# Apply safe, deterministic fixes automatically
npx typegrade apply-fixes . --mode safe

# Self-analyze with closed-loop improvement suggestions
npx typegrade self-analyze .

# Analyze monorepo layering and dependency health
npx typegrade monorepo .

# JSON output for automation
npx typegrade score zod --json

# CI gate: fail if agent readiness score < 70
# Rejects abstained/not-comparable results with a contract-specific reason
npx typegrade --min-score 70

# Detailed per-dimension breakdown
npx typegrade --verbose

# Explainability report — why each score is what it is
npx typegrade --explain
```

Install globally for repeated use:

```bash
npm install -g typegrade
```

## Actual workflows

**Library maintainer checking a release candidate:**

```bash
typegrade analyze ./src --verbose
# Fix issues, re-run until satisfied, then publish
```

**Comparing dependencies before adoption:**

```bash
typegrade compare zod valibot
# Side-by-side global scores, domain scores, and deltas
```

**AI workflow feeding downstream tooling:**

```bash
typegrade score my-sdk --json | jq '.globalScores.agentReadiness'
# Use the score in agent prompts, tool selection, or CI decisions
```

**Agent-driven improvement loop:**

```bash
# Generate a fix plan, apply safe fixes, verify, compare
typegrade fix-plan . --json > plan.json
typegrade apply-fixes . --mode safe
typegrade analyze . --json > after.json
typegrade diff before.json after.json
```

**Boundary audit for application security:**

```bash
typegrade boundaries . --json | jq '.boundarySummary.missingValidationHotspots'
# Find unvalidated I/O boundaries: HTTP, env, filesystem, queue, database, SDK
```

**CI gate for regression prevention:**

```yaml
# In your CI pipeline
- run: npx typegrade --min-score 70
```

## Why AI agents care

AI coding agents work against your exported types, not your intentions. When those types are broad or ambiguous:

- **Wrong function calls** — the agent picks the wrong overload or passes invalid arguments because the types don't narrow the space enough.
- **Hallucinated properties** — `Record<string, any>` gives the agent no signal about what fields exist.
- **Brittle patches** — loose types mean the agent's edits compile but break at runtime.
- **Poor tool autonomy** — agents need discriminated unions, branded types, and tight return types to make confident decisions without human review.

`typegrade` measures exactly these qualities. A higher Agent Readiness score means agents produce fewer errors and need less human correction.

## How it works

1. **Load** a TypeScript project or install/resolve an npm package (supports conditional exports, subpath exports, typesVersions, `@types/*` siblings, and multi-entry packages).
2. **Build** a declaration graph (package mode) or emit in-memory `.d.ts` (source mode) to see what consumers see.
3. **Extract** the public surface — every exported function, type, interface, class, and their type positions.
4. **Run analyzers** over that surface — 12 dimensions covering specificity, safety, semantic lift, specialization, usability, and more.
5. **Compute scores** — global composites, domain-adjusted scores, and scenario benchmarks with subfamily variant selection (e.g., router-server vs router-client, validation-schema vs validation-decoder).
6. **Analyze boundaries** — track data flow from untrusted sources (HTTP, env, filesystem, queue, database, SDK) through assignments and returns to validation sinks.
7. **Build fix plans** — group actionable issues into batches with confidence, expected uplift, verification commands, and rollback notes.
8. **Attach diagnostics** — confidence, coverage classification (complete, compact-complete, compact-partial, undersampled), and coverage failure modes.
9. **Classify trust** — every result is classified as `trusted`, `directional`, or `abstained` based on evidence quality. `trustSummary` indicates whether the result can be compared (`canCompare`) or used in a quality gate (`canGate`).

For a deeper walkthrough, see [How It Works](docs/how-it-works.md).

## How to interpret scores

**Global scores** (`consumerApi`, `agentReadiness`, `typeSafety`) use fixed weights and are comparable across all libraries. Use these for cross-library comparisons and CI gates.

**Domain scores** apply domain-specific weight adjustments (e.g., routers get higher weight on path-param inference). Only comparable within the same domain.

**Scenario scores** come from domain-specific consumer benchmark tests. Only comparable within the same scenario pack.

**Confidence** tells you how much evidence supports the score. Scores with confidence below 0.5 should be treated as indicative only — typically from undersampled packages with few public declarations.

### Grades

| Score | Grade |
|---|---|
| 95+ | A+ |
| 85-94 | A |
| 70-84 | B |
| 55-69 | C |
| 40-54 | D |
| 0-39 | F |

## Improving your score

1. **Use literal unions** instead of `string` for known values: `type Status = 'active' | 'inactive'`
2. **Use branded types** for IDs: `type UserId = string & { __brand: 'UserId' }`
3. **Use discriminated unions** for variants: `type Shape = { kind: 'circle'; r: number } | { kind: 'square'; s: number }`
4. **Add explicit return types** to exported functions
5. **Enable strict tsconfig flags**, especially `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
6. **Validate at I/O boundaries** — use zod/valibot instead of `as` casts on `JSON.parse()`
7. **Replace `@ts-ignore`** with `@ts-expect-error`
8. **Avoid `as any`** and double assertions (`as unknown as X`)

## Benchmark proof

`typegrade` is validated against a corpus of 24 npm packages (as of 2026-03-09) spanning elite, solid, loose, and stretch tiers. The benchmark suite enforces that well-typed libraries (zod, valibot, effect) consistently outscore loosely-typed ones (express, lodash, axios) with stable margins. All 20 train gates pass (as of 2026-03-09) at 100% must-pass, 100% domain accuracy, and 0% fallback glob rate.

Run benchmarks yourself:

```bash
pnpm benchmark:train       # Score train corpus + run assertions
pnpm benchmark:calibrate   # Detailed calibration diagnostics
```

> Benchmark snapshot as of March 2026. These results come from typegrade's current benchmark corpus and are best read as regression-proof and directional evidence, not a universal ranking of all TypeScript packages.

For details on corpus structure, assertion classes, and how to interpret results, see [Benchmarks](docs/benchmarks.md).

## Limits

- **Package mode only sees published declarations.** Internal implementation quality (soundness, boundary discipline, config) is not visible. A package can score well on consumer dimensions while hiding `as any` internally — this is by design, since consumers only see the published surface.
- **Undersampled packages should be read cautiously.** Packages with very few public declarations produce lower-confidence scores. Check the `confidenceSummary` and `coverageDiagnostics` fields in JSON output.
- **Scenario scores are domain-specific.** A high router scenario score says nothing about how the library would perform as a validation tool.
- **Domain detection is heuristic.** It uses package name patterns and API surface analysis. Override with `--domain <domain>` if needed.

## JSON output

```bash
typegrade score zod --json
```

Returns an `AnalysisResult` with:

```jsonc
{
  "analysisSchemaVersion": "0.12.0",
  "status": "complete",
  "scoreValidity": "fully-comparable",
  "mode": "package",
  "scoreProfile": "published-declarations",
  "projectName": "zod",
  "packageIdentity": {
    "displayName": "zod",
    "resolvedSpec": "zod@3.24.2",
    "resolvedVersion": "3.24.2",
    "typesSource": "bundled",
    "moduleKind": "esm",
    "entrypointStrategy": "exports-map"
  },
  "profileInfo": {
    "profile": "package",
    "profileConfidence": 1.0,
    "profileReasons": ["explicit-score-command"]
  },
  "filesAnalyzed": 12,
  "timeMs": 1800,
  "globalScores": {
    "consumerApi": { "score": 67, "grade": "C", "confidence": 0.82 },
    "agentReadiness": { "score": 71, "grade": "B", "confidence": 0.82 },
    "typeSafety": { "score": 65, "grade": "C", "confidence": 0.82 }
  },
  "domainScore": {
    "domain": "validation",
    "score": 72,
    "grade": "B",
    "confidence": 0.9
  },
  "scenarioScore": {
    "scenario": "validation",
    "score": 78,
    "passedScenarios": 3,
    "totalScenarios": 4
  },
  "confidenceSummary": {
    "graphResolution": 0.95,
    "domainInference": 0.9,
    "sampleCoverage": 0.82,
    "scenarioApplicability": 0.9
  },
  "coverageDiagnostics": {
    "typesSource": "bundled",
    "reachableFiles": 12,
    "measuredPositions": 156,
    "undersampled": false
  },
  "evidenceSummary": {
    "totalDeclarations": 45,
    "totalPositions": 156,
    "totalFiles": 12,
    "coverageClass": "complete"
  },
  "trustSummary": {
    "classification": "trusted",
    "canCompare": true,
    "canGate": true,
    "reasons": ["Complete analysis with sufficient coverage"]
  },
  "resolutionDiagnostics": {
    "acquisitionStage": "complete",
    "chosenStrategy": "exports-map",
    "attemptedStrategies": ["types-field", "exports-map"],
    "declarationCount": 15
  },
  "dimensions": [/* 8 dimension results with scores, metrics, issues */],
  "topIssues": [/* top 10 issues by severity */],
  "boundaryHotspots": [/* ranked unvalidated boundary points with risk scores */],
  "recommendations": [/* actionable recommendations by category (source mode) */]
}
```

## Programmatic API

```typescript
import {
  analyzeProject,
  scorePackage,
  comparePackages,
  buildFixPlan,
  computeDiff,
  normalizeResult,
  buildTaintFlowChains,
  analyzeMonorepo,
  loadConfig,
} from 'typegrade';

// Core analysis
const sourceResult = analyzeProject('./src');
const packageResult = scorePackage('zod');
const comparison = comparePackages('zod', 'valibot');

// Fix planning
const plan = buildFixPlan(sourceResult);

// Diff analysis
const diff = computeDiff({ baseline: packageResult, target: scorePackage('zod@next') });

// Monorepo analysis
const mono = analyzeMonorepo({ rootPath: '.' });
```

For performance-sensitive consumers, subpath imports load only what you need:

```typescript
import { analyzeProject } from 'typegrade/analyze';
import { scorePackage } from 'typegrade/score';
import { buildBoundaryGraph } from 'typegrade/boundaries';
import { buildFixPlan } from 'typegrade/fix';
```

## Configuration

Create a `typegrade.config.ts` in your project root:

```typescript
import type { TypegradeConfig } from 'typegrade';

export default {
  domain: 'auto',
  profile: 'library',
  minScore: 70,
  boundaries: {
    trustZones: [
      { name: 'api', paths: ['src/api/**'], trustLevel: 'untrusted-external' },
      { name: 'internal', paths: ['src/core/**'], trustLevel: 'internal-only' },
    ],
    policies: [
      { name: 'validate-http', source: 'network', requiresValidation: true, severity: 'error' },
    ],
  },
} satisfies TypegradeConfig;
```

## Agent skills

typegrade ships versioned skills for AI coding agents via [TanStack Intent](https://tanstack.com/intent/latest). If you use an AI coding agent (Claude Code, Cursor, Copilot, Codex), run:

```bash
npx @tanstack/intent@latest install
```

This discovers typegrade's 7 skills from `node_modules` and writes skill-to-task mappings into your agent config. Skills cover local analysis, package scoring, CI gating, JSON consumption, comparisons, self-improvement, and maintainer workflows.

For details, see [Agent Skills](docs/skills.md).

## Read more

- [How It Works](docs/how-it-works.md) — technical walkthrough of source mode, package mode, the declaration graph, analyzers, and scoring layers.
- [Scoring Contract](docs/scoring-contract.md) — canonical reference for all 12 dimensions, weights, formulas, and grading.
- [Confidence Model](docs/confidence-model.md) — how confidence is computed and what it means.
- [Benchmark Policy](docs/benchmark-policy.md) — governance rules for the benchmark suite.
- [Benchmarks](docs/benchmarks.md) — how to run and interpret benchmarks.
- [Agent Skills](docs/skills.md) — shipped Intent skills for AI coding agents.

## License

MIT
