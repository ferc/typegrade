# typegrade

A fast CLI tool that scores TypeScript projects on **type precision quality** — not just "do you have types?" but "how narrow, specific, and useful are your types?"

AI coding agents produce better output when operating within tighter static boundaries. This tool measures how tight those boundaries are.

## Install

```bash
npx typegrade
```

Or install globally:

```bash
npm install -g typegrade
```

## Usage

```bash
# Analyze current directory
typegrade

# Analyze specific path
typegrade analyze ./src

# Score an npm package's published declarations
typegrade score zod
typegrade score zod@3.24.2

# Score a local package
typegrade score ./node_modules/@tanstack/router-core

# JSON output
typegrade --json

# CI gate: fail if score < 70
typegrade --min-score 70

# Verbose per-dimension details
typegrade --verbose

# Explainability report
typegrade --explain
```

## Output

```
  typegrade v0.4.0

  Project: my-project (source analysis)
  Files: 42 analyzed in 1.2s

  ╔═══════════════════════════════════════════╗
  ║  Agent Readiness:    78/100 (B)           ║
  ║  Consumer API:       82/100 (B)           ║
  ║  Implementation:     71/100 (B)           ║
  ╚═══════════════════════════════════════════╝

  Consumer API Dimensions:
  API Specificity       ████████████░░░░░░░░  61%
  API Safety            ████████████████████  99%
  Semantic Lift         ██████████████░░░░░░  68%
  Publish Quality       ████████████████░░░░  82%
  Surface Consistency   ██████████████████░░  90%
  Surface Complexity    ████████████████████  95%
  Agent Usability       ████████████████░░░░  80%
  Declaration Fidelity  ████████████████████  95%

  Implementation Dimensions:
  Soundness             ██████████████████░░  88%
  Boundary Discipline   ████████████░░░░░░░░  58%
  Config Discipline     ██████████████████░░  90%

  Top issues:
   ✖  src/api.ts:23 — parameter 'data' in processInput() leaks 'any'
   ⚠  src/handlers.ts:45 — JSON.parse() without runtime validation
   ℹ  tsconfig.json — enable noUncheckedIndexedAccess for stricter indexing
```

## Scoring Architecture

typegrade produces three composite scores from eleven dimensions:

### Composite Scores

| Composite | Source Mode | Package Mode |
|---|---|---|
| **Agent Readiness** | 65% Consumer API + 35% Implementation | 100% Consumer API |
| **Consumer API** | Weighted average of 8 consumer dimensions | Weighted average of 7 consumer dimensions |
| **Implementation** | Weighted average of 3 implementation dimensions | n/a (disabled) |

### Consumer API Dimensions

These measure the quality of your **published API surface** — what downstream consumers and AI agents see:

| Dimension | Weight | What it measures |
|---|---|---|
| **API Specificity** | 35% | How narrow and specific are your exported types? Per-position feature-model scoring with 16 feature bonuses. |
| **API Safety** | 20% | How much `any` leaks into your public API? Domain-aware: suppresses false positives for validation libraries. |
| **Semantic Lift** | 15% | How much do advanced type features lift your API above baseline? Per-feature scaling rewards discriminated unions, branded types, etc. |
| **Publish Quality** | 8% | Do exported functions have explicit return types, typed parameters, JSDoc, and proper entrypoint clarity? |
| **Surface Consistency** | 5% | Is your API consistent? Checks overload density, naming conventions, nullability, generic naming, and result shape consistency. |
| **Surface Complexity** | 5% | Is your API approachable? Penalizes deep nesting, wide unions, overload explosion, and declaration sprawl. |
| **Agent Usability** | 5% | Is your API AI-agent-friendly? Checks named exports, discriminated errors, correlated generics, overload clarity. |
| **Declaration Fidelity** | 7% | Do emitted `.d.ts` declarations preserve the source types? Checks generic parameters and constraints. Source-only. |

### Implementation Dimensions (source mode only)

| Dimension | Weight | What it measures |
|---|---|---|
| **Soundness** | 45% | Type assertions (`as any`, `as unknown as X`), non-null assertions, `@ts-ignore` usage |
| **Boundary Discipline** | 25% | Runtime validation at I/O boundaries (JSON.parse, fetch, file reads) |
| **Config Discipline** | 20% | TypeScript strict mode flags (`strictNullChecks`, `noUncheckedIndexedAccess`, etc.) |

### Type Precision Hierarchy

From lowest to highest precision:

| Level | Score | Example |
|---|---|---|
| `any` | 0 | `any` |
| `unknown` | 20 | `unknown` |
| `wide-primitive` | 40 | `string`, `number`, `boolean` |
| `interface` | 55 | `{ name: string; age: number }` |
| `void` | 60 | `void` |
| `enum` | 65 | `enum Role { Admin, User }` |
| `generic-bound` | 70 | `<T extends string>` |
| `literal` | 80 | `'active'`, `42` |
| `template-literal` | 82 | `` `/api/${string}` `` |
| `literal-union` | 85 | `'a' \| 'b' \| 'c'` |
| `branded` | 90 | `string & { __brand: 'UserId' }` |
| `discriminated-union` | 95 | `{ kind: 'circle' } \| { kind: 'square' }` |

### Grades

| Score | Grade |
|---|---|
| 95+ | A+ |
| 85-94 | A |
| 70-84 | B |
| 55-69 | C |
| 40-54 | D |
| 0-39 | F |

## Source vs Package Mode

**Source mode** (`typegrade analyze`) examines your TypeScript source files directly. All 11 dimensions contribute. Best for analyzing projects you own.

**Package mode** (`typegrade score`) analyzes published `.d.ts` declarations — what consumers actually import. Only the 7 consumer-facing dimensions apply (Declaration Fidelity and all 3 implementation dimensions are disabled). Best for evaluating npm packages.

In source mode, typegrade emits declarations in-memory via `ts-morph` to build a "consumer view" of your API, then scores both the source (implementation dimensions) and the emitted declarations (consumer dimensions).

## Domain Detection

typegrade detects library domains and adjusts scoring accordingly:

- **Validation** (zod, valibot, arktype, etc.): `unknown` parameters suppressed in API Safety
- **Result** (neverthrow, effect, fp-ts): Recognized for discriminated union patterns
- **Stream** (rxjs, xstate, most): Higher-order generic signatures accepted
- **Schema/Utility** (type-fest, ts-toolbelt): High generic density expected
- **Router** (express, fastify, hono): Route/handler/middleware pattern detection
- **ORM** (drizzle-orm, prisma): Model/schema/table pattern detection
- **Frontend** (react, preact, vue, svelte): Package name matching

Domain is inferred from package name patterns and API surface analysis.

## Declaration Graph Engine

For package scoring, typegrade builds a declaration import graph rather than analyzing all `.d.ts` files in a package:

1. **Resolve entrypoints** from `types`, `typings`, and `exports` fields in `package.json`
2. **Walk imports** via BFS following `import`/`export` statements and `/// <reference path>` directives
3. **Deduplicate** ESM/CJS twins (`.d.ts` vs `.d.mts`/`.d.cts`), symbol-identical files, and same-subpath condition variants

This ensures only reachable, consumer-visible declarations are scored.

## How to Improve Your Score

1. **Use literal unions** instead of `string` for known values: `type Status = 'active' | 'inactive'`
2. **Use branded types** for IDs: `type UserId = string & { __brand: 'UserId' }`
3. **Use discriminated unions** for variants: `type Shape = { kind: 'circle'; r: number } | { kind: 'square'; s: number }`
4. **Add explicit return types** to exported functions
5. **Enable strict tsconfig flags**, especially `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
6. **Use zod/valibot** at I/O boundaries instead of `as` type assertions
7. **Replace `@ts-ignore`** with `@ts-expect-error`
8. **Avoid `as any`** and double assertions (`as unknown as X`)

## JSON Output

```bash
typegrade --json
```

Returns an `AnalysisResult` object with:

```jsonc
{
  "mode": "source",                    // "source" | "package"
  "scoreProfile": "source-project",   // scoring profile used
  "projectName": "my-project",
  "filesAnalyzed": 42,
  "timeMs": 1200,
  "composites": [
    {
      "key": "agentReadiness",
      "score": 78,
      "grade": "B",
      "rationale": ["65% Consumer API (82) + 35% Implementation (71)"],
      "confidence": 0.82
    }
    // ... consumerApi, implementationQuality
  ],
  "dimensions": [
    {
      "key": "apiSpecificity",
      "label": "API Specificity",
      "enabled": true,
      "score": 61,
      "weights": { "consumerApi": 0.35 },
      "metrics": { /* dimension-specific */ },
      "positives": ["Strong use of discriminated unions"],
      "negatives": ["42% of positions are wide primitives"],
      "issues": [/* file-level issues */],
      "confidence": 0.85
    }
    // ... 10 more dimensions
  ],
  "domainInference": {
    "domain": "validation",
    "confidence": 0.9,
    "signals": ["Package name matches validation pattern"]
  },
  "caveats": [],
  "topIssues": [/* top 10 issues by severity */]
}
```

## Benchmarks

typegrade ships with a benchmark suite of 20 npm packages across four tiers:

| Tier | Packages | Score Range |
|---|---|---|
| Elite | valibot (84), ts-pattern (74), arktype (68), effect (68), zod (67) | 67-84 |
| Solid | date-fns (72), remeda (71), neverthrow (64), type-fest (62), drizzle-orm (58) | 58-72 |
| Loose | uuid (64), lodash (62), express (60), moment (57), axios (50) | 50-64 |
| Stretch | io-ts (78), fp-ts (77), rxjs (65), hono (63), @tanstack/react-router (58) | 58-78 |

Run benchmarks:

```bash
pnpm benchmark                      # Score all 20 packages + run assertions
npx tsx benchmarks/calibrate.ts     # Evaluate assertions + calibration analysis
```

## License

MIT
