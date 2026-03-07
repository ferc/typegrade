# tsguard Testing Guide

How to validate tsguard's scoring against real-world TypeScript packages.

## Testing Methods

### A) Analyze source code (recommended for accuracy)

Clone the repo and point tsguard at the source directory. This gives the fullest picture because all 6 dimensions can differentiate:

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/test-zod
tsguard analyze /tmp/test-zod/packages/zod
```

Best for: zod, effect, ts-pattern, neverthrow, hono, drizzle-orm, valibot, date-fns, remeda

### B) Score npm package (for .d.ts analysis)

Installs the package to a temp directory and analyzes published declarations:

```bash
tsguard score <package-name>
tsguard score <package-name> --json
```

Best for: testing the published API surface consumers actually see. Scores are compressed into a narrow band (see [Calibration Notes](#calibration-notes-for-package-scoring)).

### C) Analyze local packages

```bash
tsguard score ./path/to/package
tsguard analyze ./path/to/project
```

## Benchmark Results: Source Code Analysis

Scored on 2026-03-07 using tsguard v0.1.0. Libraries cloned at HEAD and analyzed with `tsguard analyze`.

### TypeScript-First Libraries

| Library | Repo Path | Files | Score | Grade | TP | TC | SC | US | EQ | RV |
|---|---|---|---|---|---|---|---|---|---|---|
| **valibot** | `library/` | 778 | **77** | **B** | 61 | 99 | 70 | 98 | 97 | 40 |
| **date-fns** | `src/` | 1488 | **65** | **C** | 51 | 97 | 55 | 93 | 75 | 20 |
| **ts-pattern** | root | 18 | **63** | **C** | 43 | 92 | 55 | 91 | 85 | 20 |
| **neverthrow** | root | 5 | **60** | **C** | 45 | 93 | 40 | 90 | 86 | 0 |
| **zod** | `packages/zod/` | 118 | **58** | **C** | 54 | 96 | 86 | 6 | 83 | 10 |

Dimension abbreviations: TP = Type Precision, TC = Type Coverage, SC = Strict Config, US = Unsoundness, EQ = Export Quality, RV = Runtime Validation

### Benchmark Results: Package Scoring (.d.ts)

| Package | Files | Score | Grade | TP | TC | SC | US | EQ | RV |
|---|---|---|---|---|---|---|---|---|---|
| **valibot** | 2 | **76** | **B** | 61 | 99+ | 55 | 100 | 85 | 0 |
| **express** | 1 | **68** | **C** | 55 | 100 | 55 | 100 | 85 | 0 |
| **neverthrow** | 1 | **64** | **C** | 49 | 99 | 55 | 100 | 72 | 0 |
| **lodash** | 701 | **62** | **C** | 48 | 95 | 55 | 100 | 70 | 0 |

### Test Fixtures (internal)

| Fixture | Score | Grade |
|---|---|---|
| high-precision | 83 | B |
| tanstack-style | 66 | C |
| medium-precision | 63 | C |
| low-precision | 47 | D |
| unsound | 44 | D |

## Predicted vs Actual Scores

| Library | Predicted | Actual (analyze) | Actual (score) | Delta |
|---|---|---|---|---|
| **zod** | A (85+) | C (58) | B (71)* | -27 / -14 |
| **ts-pattern** | A (85+) | C (63) | C (64) | -22 / -21 |
| **neverthrow** | A (85+) | C (60) | C (64) | -25 / -21 |
| **valibot** | A (85+) | B (77) | B (76) | -8 / -9 |
| **date-fns** | B/C (50-75) | C (65) | C (67) | on target |
| **express** | D/F (<40) | n/a | C (68) | +28 |
| **lodash** | D/F (<40) | n/a | C (62) | +22 |

*zod `score` result from earlier session with slightly different run.

### Key Findings

1. **Type Precision scores are systematically lower than expected (43-61)**. The classifier penalizes `void` return types (classified as wide-primitive), which every side-effecting function has. Complex resolved generic types (e.g. `Chainable<OptionalP<...>>`) resolve to object types scoring only 55 (`interface`), not the higher precision levels.

2. **Zod's source analysis scores lowest (58) despite excellent public types**. The culprit: 477 internal `as any` assertions drive its Unsoundness score to 6. This is an implementation detail hidden from consumers — the `.d.ts` analysis scores zod higher because declarations have no assertions.

3. **Package scoring compresses scores into a narrow band (62-76)**. Five of six dimensions produce near-identical scores for all packages (see calibration notes below). Only Type Precision differentiates.

4. **Express and lodash score higher than expected** in package mode because `.d.ts` files inherently have high coverage, no unsoundness, and good export quality — dimensions that would reveal weakness only in source analysis.

## Calibration Notes for Package Scoring

In package mode (`tsguard score`), Strict Config and Runtime Validation dimensions are zeroed out (weight=0) since they measure the temp workspace, not the target package. The remaining four dimensions are renormalized.

| Dimension | Effective Weight | Typical .d.ts Score | Why |
|---|---|---|---|
| Type Coverage | ~20% | 95-100 | `.d.ts` files don't have untyped identifiers |
| Strict Config | **0%** | n/a | Zeroed out — measures temp tsconfig, not the library's |
| Unsoundness | ~20% | 99-100 | `.d.ts` files have no type assertions or `@ts-ignore` |
| Export Quality | ~20% | 70-85 | Declarations always have explicit return types |
| Runtime Validation | **0%** | n/a | Zeroed out — not detectable from `.d.ts` alone |
| **Type Precision** | **~40%** | **43-61** | **Primary differentiator** |

**Type Precision is the only meaningful differentiator for package scoring.** Relative ordering is more meaningful than absolute scores.

## Calibration Notes for Source Analysis

Source analysis uses all 6 dimensions effectively but has known limitations:

1. **`void` as wide-primitive**: Functions returning `void` score 35 (wide-primitive), which drags down the precision average. However, `void` returns no longer generate issue warnings — only `any` and `unknown` produce actionable warnings.

2. **Unsoundness penalizes implementation assertions**: Libraries like zod use `as any` internally for implementation flexibility while maintaining a perfectly type-safe public API. The analyzer doesn't distinguish between internal and public-facing unsoundness. Nested double assertions (`as unknown as X`) are now correctly counted once, not double-counted.

3. **Runtime Validation detects usage of external validation**: Libraries that *are* validation libraries (zod, valibot) don't validate their own inputs with another validation library, so they score low on this dimension. This is expected and correct behavior, but unintuitive. The `fetchWithoutValidationCount` path is not yet implemented.

4. **Strict Config depends on tsconfig availability**: Libraries with project references (date-fns) or monorepo structures need to be pointed at the correct sub-project with its own tsconfig.

5. **Zero files returns 0/N/A**: If no source files are found (e.g., pointing at a `dist/` directory with `analyze` instead of `score`), tsguard returns score 0, grade "N/A" instead of manufacturing a plausible score.

## What Type Precision Captures

| Level | Score | Examples |
|---|---|---|
| `any` | 0 | `any` |
| `unknown` | 25 | `unknown` |
| `wide-primitive` | 35 | `string`, `number`, `boolean`, `void`, `Date` |
| `generic-unbound` | 40 | `T` (no constraints) |
| `interface` | 55 | `{ name: string }`, resolved generic objects |
| `enum` | 65 | `enum Status { ... }` |
| `generic-bound` | 70 | `T extends Foo` |
| `literal` | 80 | `"GET"`, `42`, `true` |
| `literal-union` | 85 | `"GET" \| "POST"` |
| `template-literal` | 85 | `` `prefix:${string}` `` |
| `branded` | 90 | `string & { __brand: "UserId" }` |
| `discriminated-union` | 95 | `{ type: "a", ... } \| { type: "b", ... }` |

## Recommended Test Libraries

### For validating high scores

| Library | Repo | Source Path | Why |
|---|---|---|---|
| **valibot** | fabian-hiller/valibot | `library/` | Modular, TS-first, consistent patterns |
| **zod** | colinhacks/zod | `packages/zod/` | TS-first schema validation (note: internal assertions lower score) |
| **ts-pattern** | gvergnaud/ts-pattern | root | Exhaustive pattern matching |
| **neverthrow** | supermacro/neverthrow | root | Type-safe Result<T, E> |
| **effect** | Effect-TS/effect | `packages/effect/src/` | Full effect system, branded types |
| **hono** | honojs/hono | `src/` | TS-first web framework |
| **arktype** | arktypeio/arktype | `packages/arktype/` | TS-native validator |
| **drizzle-orm** | drizzle-team/drizzle-orm | `drizzle-orm/src/` | TS-first SQL ORM |

### For validating medium scores

| Library | Repo | Source Path | Why |
|---|---|---|---|
| **date-fns** | date-fns/date-fns | `src/` | Rewritten in TS, but `Date` in/out (wide primitive) |
| **remeda** | remeda/remeda | `src/` | TS-first utility lib |

### For validating low scores (use `tsguard score`)

| Package | Why |
|---|---|
| **express** | JS library, community types, `any` in req/res bodies |
| **lodash** | JS library, wide generics, `any` fallbacks |
| **moment** | Legacy, wide primitives |

## Running Your Own Benchmarks

```bash
# Score any npm package
tsguard score <package-name>

# Compare multiple packages
for pkg in zod valibot arktype io-ts; do
  echo -n "$pkg: "
  tsguard score "$pkg" --json | jq '{score: .overallScore, grade, precision: .dimensions[0].score}'
done

# Analyze cloned source code (broader scoring range)
git clone --depth 1 <repo-url> /tmp/test-lib
tsguard analyze /tmp/test-lib/src --verbose

# JSON output for scripting
tsguard analyze ./src --json | jq '.dimensions[] | {name, score}'
```
