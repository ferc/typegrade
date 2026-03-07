# tsguard

A fast CLI tool that scores TypeScript projects on **type precision quality** — not just "do you have types?" but "how narrow, specific, and useful are your types?"

AI coding agents produce better output when operating within tighter static boundaries. This tool measures how tight those boundaries are.

## Install

```bash
npx tsguard
```

Or install globally:

```bash
npm install -g tsguard
```

## Usage

```bash
# Analyze current directory
tsguard

# Analyze specific path
tsguard analyze ./src

# Score an npm package
tsguard score zod

# Score a local package
tsguard score ./node_modules/@tanstack/router-core

# JSON output
tsguard --json

# CI gate: fail if score < 70
tsguard --min-score 70

# Verbose per-dimension details
tsguard --verbose
```

## Output

```
  tsguard v0.1.0

  Project: my-project
  Files: 42 analyzed in 1.2s

  ╔═══════════════════════════════════════════╗
  ║  Score: 78/100 (B)                        ║
  ║  AI Agent Readiness: MODERATE             ║
  ╚═══════════════════════════════════════════╝

  Type Precision      ████████████░░░░░░░░  61% ← most impactful
  Type Coverage       ████████████████░░░░  82%
  Strict Config       ██████████████████░░  90%
  Unsoundness         ██████████████████░░  88%
  Export Quality      ████████████████░░░░  79%
  Runtime Validation  ████████████░░░░░░░░  58%

  Top issues:
   ⚠  src/api.ts:23 — exported getUser() has return type `any`
   ⚠  src/handlers.ts:45 — JSON.parse() without runtime validation
   ⚠  src/utils.ts:12 — double type assertion (as unknown as X)
   ℹ  tsconfig.json — enable noUncheckedIndexedAccess for +12 strict score
```

## Scoring Methodology

tsguard analyzes 6 dimensions, each scored 0-100, then combines them with weighted averages:

| Dimension | Weight | What it measures |
|---|---|---|
| **Type Precision** | 30% | How narrow and specific are your exported types? Branded types > literal unions > interfaces > wide primitives > any |
| **Type Coverage** | 15% | What percentage of identifiers avoid `any`? |
| **Strict Config** | 15% | How many strict tsconfig flags are enabled? |
| **Unsoundness** | 15% | How many type assertions, non-null assertions, and @ts-ignore comments? |
| **Export Quality** | 15% | Do exported functions have explicit return types, typed params, and JSDoc? |
| **Runtime Validation** | 10% | Are validation libraries (zod, valibot, etc.) used at I/O boundaries? |

### Type Precision Hierarchy

From lowest to highest precision:

| Level | Score | Example |
|---|---|---|
| `any` | 0 | `any` |
| `unknown` | 20 | `unknown` |
| `wide-primitive` | 35 | `string`, `number`, `boolean` |
| `generic-unbound` | 40 | `<T>` |
| `primitive-union` | 45 | `string \| number` |
| `interface` | 55 | `{ name: string; age: number }` |
| `enum` | 65 | `enum Role { Admin, User }` |
| `generic-bound` | 70 | `<T extends string>` |
| `literal` | 80 | `'active'`, `42` |
| `template-literal` | 82 | `` `/api/${string}` `` |
| `literal-union` | 85 | `'a' \| 'b' \| 'c'` |
| `never` | 90 | `never` (exhaustiveness) |
| `branded` | 95 | `string & { __brand: 'UserId' }` |
| `discriminated-union` | 95 | `{ kind: 'circle' } \| { kind: 'square' }` |

### Grades

| Score | Grade | AI Readiness |
|---|---|---|
| 95+ | A+ | HIGH |
| 85-94 | A | HIGH |
| 70-84 | B | MODERATE |
| 55-69 | C | MODERATE |
| 40-54 | D | LOW |
| 0-39 | F | POOR |

## How to Improve Your Score

1. **Use literal unions** instead of `string` for known values: `type Status = 'active' | 'inactive'`
2. **Use branded types** for IDs: `type UserId = string & { __brand: 'UserId' }`
3. **Use discriminated unions** for variants: `type Shape = { kind: 'circle'; r: number } | { kind: 'square'; s: number }`
4. **Enable strict tsconfig flags**, especially `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
5. **Add explicit return types** to exported functions
6. **Use zod/valibot** at I/O boundaries instead of `as` type assertions
7. **Replace `@ts-ignore`** with `@ts-expect-error`
8. **Avoid `as any`** and double assertions (`as unknown as X`)

## License

MIT
