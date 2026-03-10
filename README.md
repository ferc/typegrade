# typegrade

Score your TypeScript on **type precision** — how narrow, specific, and useful your types actually are for humans and AI agents. One command, many modes.

## Quickstart

```bash
# Audit a local project (source mode, all 12 dimensions)
npx typegrade .

# Score a published npm package
npx typegrade zod

# Compare two packages side-by-side
npx typegrade zod valibot

# Choose the best fit for your codebase
npx typegrade zod valibot --against .

# Get improvement suggestions (agent-ready JSON)
npx typegrade . --improve --json
```

Install globally for repeated use:

```bash
npm install -g typegrade
```

## How to think about it

- **One target** = inspect it. Local path audits your project; package name scores a library.
- **Two targets** = compare them. Side-by-side global scores, confidence, and a recommendation.
- **`--against`** = choose for your codebase. Fit comparison with migration risk and first steps.
- **`--improve`** = next fixes. Ordered batches with agent instructions, rollback hints, and verification.

`typegrade` detects what you're pointing at — workspace root, source project, local package surface, or npm package — and runs the right analysis automatically.

## What you get back

Three global scores from up to 12 dimensions:

| Score               | What it answers                                                              |
| ------------------- | ---------------------------------------------------------------------------- |
| **Consumer API**    | How precise and well-structured is your exported API surface?                |
| **Agent Readiness** | How well does your API guide AI agents toward correct usage?                 |
| **Type Safety**     | How safe is your code from `any` leaks, unsound casts, and weak boundaries? |

Plus:

- **Trust classification** — every result is `trusted`, `directional`, or `abstained` based on evidence quality.
- **Domain-fit scores** — adjusted for validation, router, ORM, stream, and other library categories.
- **Scenario scores** — consumer benchmark tests that measure real downstream DX.
- **Confidence and coverage diagnostics** — so you know how much evidence supports each score.
- **Next best action** — what to fix first, with files and verification.

### With `--json`

The root command returns a `SmartCliResult`:

```jsonc
{
  "resultKind": "smart-cli",
  "mode": "repo-audit",           // or "package-score", "package-compare", "fit-compare"
  "targetKind": "repo",           // or "workspace", "package", "pair"
  "summary": {
    "headline": "my-app: good type quality",
    "verdict": "good",            // "good", "needs-work", "poor", "degraded", "abstained"
    "scorecard": [ /* consumerApi, agentReadiness, typeSafety */ ],
    "topReasons": [ /* strengths */ ],
    "topRisks": [ /* concerns */ ]
  },
  "trust": { "classification": "trusted", "canCompare": true, "canGate": true },
  "primary": { /* full AnalysisResult, CompareResult, or FitCompareResult */ },
  "supplements": { /* agentReport, boundaries, monorepo — when available */ },
  "nextAction": { "kind": "fix", "title": "...", "files": [...], "verification": "..." },
  "executionDiagnostics": { /* phase timings, resource warnings */ }
}
```

### Grades

| Score | Grade |
| ----- | ----- |
| 95+   | A+    |
| 85-94 | A     |
| 70-84 | B     |
| 55-69 | C     |
| 40-54 | D     |
| 0-39  | F     |

## Common workflows

**CI gate:**

```yaml
- run: npx typegrade . --min-score 70
```

**Agent-driven improvement loop:**

```bash
typegrade . --improve --json > plan.json
# Agent reads plan.json, applies batches, verifies
typegrade .
```

**Comparing dependencies before adoption:**

```bash
typegrade zod valibot
typegrade zod valibot --against .
```

**Feeding downstream AI tooling:**

```bash
typegrade zod --json | jq '.primary.globalScores.agentReadiness'
```

## Limits

- **Package mode only sees published declarations.** Internal implementation quality is not visible — a package can score well while hiding `as any` internally. This is by design.
- **Undersampled packages should be read cautiously.** Check `confidenceSummary` and `coverageDiagnostics` in JSON output.
- **Scenario scores are domain-specific.** A high router score says nothing about validation quality.
- **Domain detection is heuristic.** Override with `--domain <domain>` if needed.

## Improving your score

1. **Use literal unions** instead of `string` for known values
2. **Use branded types** for IDs
3. **Use discriminated unions** for variants
4. **Add explicit return types** to exported functions
5. **Enable strict tsconfig flags** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
6. **Validate at I/O boundaries** — use zod/valibot instead of `as` casts
7. **Replace `@ts-ignore`** with `@ts-expect-error`
8. **Avoid `as any`** and double assertions

## Why AI agents care

AI coding agents work against your exported types, not your intentions. Broad types cause wrong function calls, hallucinated properties, and brittle patches. A higher Agent Readiness score means agents produce fewer errors and need less human correction.

## How it works

1. **Load** a TypeScript project or resolve an npm package (conditional exports, subpath exports, `@types/*` siblings, multi-entry).
2. **Build** a declaration graph (package mode) or emit in-memory `.d.ts` (source mode).
3. **Extract** the public surface — every exported function, type, interface, class.
4. **Run analyzers** — 12 dimensions covering specificity, safety, semantic lift, usability, and more.
5. **Compute scores** — global composites, domain-adjusted scores, scenario benchmarks.
6. **Analyze boundaries** — track data flow from untrusted sources through to validation sinks.
7. **Build fix plans** — batches with confidence, uplift, verification, rollback, and agent instructions.
8. **Classify trust** — `trusted`, `directional`, or `abstained` based on evidence quality.

For a deeper walkthrough, see [How It Works](docs/how-it-works.md).

## Programmatic API

```typescript
import {
  analyzeProject,
  scorePackage,
  comparePackages,
  fitCompare,
  buildFixPlan,
  runSmart,
} from "typegrade";

// Smart dispatch (same as the CLI)
const { result } = await runSmart(["zod", "valibot"], { json: true });

// Direct APIs
const sourceResult = analyzeProject("./src");
const packageResult = scorePackage("zod");
const comparison = comparePackages("zod", "valibot");
const fit = fitCompare("zod", "valibot", { codebasePath: "." });
const plan = buildFixPlan(sourceResult);
```

Subpath imports for smaller bundles:

```typescript
import { analyzeProject } from "typegrade/analyze";
import { scorePackage } from "typegrade/score";
import { buildBoundaryGraph } from "typegrade/boundaries";
import { buildFixPlan } from "typegrade/fix";
```

## Configuration

Create a `typegrade.config.ts` in your project root:

```typescript
import type { TypegradeConfig } from "typegrade";

export default {
  domain: "auto",
  profile: "library",
  minScore: 70,
  boundaries: {
    trustZones: [
      { name: "api", paths: ["src/api/**"], trustLevel: "untrusted-external" },
      { name: "internal", paths: ["src/core/**"], trustLevel: "internal-only" },
    ],
  },
} satisfies TypegradeConfig;
```

## Agent skills

typegrade ships versioned skills for AI coding agents via [TanStack Intent](https://tanstack.com/intent/latest):

```bash
npx @tanstack/intent@latest install
```

Skills cover analysis, scoring, CI gating, JSON consumption, comparisons, self-improvement, and maintainer workflows. See [Agent Skills](docs/skills.md).

## Benchmark proof

Validated against 24 npm packages (as of 2026-03-10) spanning elite, solid, loose, and stretch tiers. 20/20 train gates pass at 100% must-pass, 100% domain accuracy, 0% fallback glob (as of 2026-03-10).

```bash
pnpm benchmark:train
```

See [Benchmarks](docs/benchmarks.md) for details.

## Advanced commands

These commands are still available for specialized use cases. Run `typegrade <command> --help` for details.

| Command | Purpose |
| --- | --- |
| `analyze [path]` | Source analysis with full options |
| `score <package>` | Score an npm package directly |
| `compare <a> <b>` | Side-by-side comparison |
| `fit-compare <a> <b>` | Codebase-aware fit comparison |
| `boundaries [path]` | Boundary trust analysis |
| `monorepo [path]` | Workspace health and layer violations |
| `self-analyze [path]` | Closed-loop self-improvement |
| `fix-plan [path]` | Generate actionable fix plan |
| `apply-fixes [path]` | Apply safe deterministic fixes |
| `diff <base> <target>` | Compare two snapshots |

## Read more

- [How It Works](docs/how-it-works.md) — source mode, package mode, declaration graph, analyzers, scoring layers.
- [Scoring Contract](docs/scoring-contract.md) — all 12 dimensions, weights, formulas, grading.
- [Confidence Model](docs/confidence-model.md) — how confidence works.
- [Benchmark Policy](docs/benchmark-policy.md) — benchmark governance.
- [Benchmarks](docs/benchmarks.md) — running and interpreting benchmarks.
- [Agent Skills](docs/skills.md) — shipped Intent skills for AI agents.

## License

MIT
