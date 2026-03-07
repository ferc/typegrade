# tsguard Testing Guide

How to validate tsguard's scoring against real-world TypeScript packages.

## Testing Method

tsguard installs the package to a sandboxed temp directory and analyzes its published `.d.ts` / `.d.mts` / `.d.cts` type declarations:

```bash
tsguard score <package-name>
# or with JSON output:
tsguard score <package-name> --json
```

This captures the actual type surface that consumers experience — including transitive dependencies and generated declarations — without needing to clone source repos.

For local packages or monorepo paths:

```bash
tsguard score ./path/to/package
tsguard analyze ./path/to/project
```

## Benchmark Results

Scored on 2026-03-07 using tsguard v0.1.0.

### TypeScript-First Libraries

| Package | Files | Score | Grade | Type Precision | Notes |
|---|---|---|---|---|---|
| **valibot** | 2 | 76 | B | 61 | Modular schema lib, `.d.mts` format |
| **zod** | 204 | 71 | B | 54 | Schema validation, branded types, v3+v4 declarations |
| **arktype** | 55 | 68 | C | 52 | TypeScript-native validator |
| **hono** | 185 | 67 | C | 51 | TS-first web framework, literal route types |
| **date-fns** | 2460 | 67 | C | 51 | Large file count, mostly `Date` in/out |
| **ts-pattern** | 36 | 64 | C | 44 | Exhaustive pattern matching |
| **neverthrow** | 1 | 64 | C | 49 | Result<T,E> error handling |
| **type-fest** | 196 | 64 | C | 48 | Utility type collection |
| **drizzle-orm** | 888 | 64 | C | 43 | SQL ORM, massive type surface |
| **remeda** | 2 | 65 | C | 51 | TS-first utility lib |

### JS Libraries with Community/Bundled Types

| Package | Files | Score | Grade | Type Precision | Notes |
|---|---|---|---|---|---|
| **express** | 1 | 68 | C | 55 | @types/express, single index.d.ts |
| **cheerio** | 51 | 68 | C | 52 | HTML parser |
| **moment** | 2 | 65 | C | 49 | Legacy datetime |
| **axios** | 2 | 63 | C | 46 | HTTP client |
| **lodash** | 701 | 62 | C | 48 | Utility lib, many individual .d.ts files |

## Calibration Notes

### Why scores cluster in the 62-76 range

When analyzing `.d.ts` declarations (package scoring mode), several dimensions produce near-identical scores regardless of library quality:

| Dimension | Weight | Typical .d.ts Score | Why |
|---|---|---|---|
| Type Coverage | 20% | 95-100 | `.d.ts` files don't have untyped identifiers |
| Strict Config | 15% | 55 | Measures our temp tsconfig, not the library's |
| Unsoundness | 15% | 99-100 | `.d.ts` files have no type assertions or `@ts-ignore` |
| Export Quality | 10% | 70-85 | Declarations always have explicit return types |
| Runtime Validation | 10% | 0-65 | Detects validation libs in dependencies |
| **Type Precision** | **30%** | **43-61** | **Only dimension with real differentiation** |

**Type Precision is the only meaningful differentiator for package scoring.** The other dimensions are optimized for analyzing source code (`.ts` files), not published declarations.

### Implications

- Package scores are compressed into a narrow band; relative ordering is more meaningful than absolute scores
- For a wider scoring range, analyze source code directly: `tsguard analyze ./src`
- Future work: weight dimensions differently for `.d.ts` vs source analysis, or add `.d.ts`-specific scoring dimensions

### What Type Precision Captures

The Type Precision analyzer classifies each exported type position into a precision level:

| Level | Score | Examples |
|---|---|---|
| `any` | 0 | `any` |
| `unknown` | 25 | `unknown` |
| `wide-primitive` | 35 | `string`, `number`, `boolean`, `void`, `Date` |
| `interface` | 55 | `{ name: string }` |
| `generic-unbound` | 40 | `T` (no constraints) |
| `generic-bound` | 70 | `T extends Foo` |
| `enum` | 65 | `enum Status { ... }` |
| `literal` | 80 | `"GET"`, `42`, `true` |
| `literal-union` | 85 | `"GET" \| "POST"` |
| `template-literal` | 85 | `` `prefix:${string}` `` |
| `branded` | 90 | `string & { __brand: "UserId" }` |
| `discriminated-union` | 95 | `{ type: "a", ... } \| { type: "b", ... }` |

Libraries with more literal types, branded types, and discriminated unions score higher.

## Running Your Own Benchmarks

```bash
# Score any npm package
tsguard score <package-name>

# Compare multiple packages
for pkg in zod valibot arktype io-ts; do
  echo -n "$pkg: "
  tsguard score "$pkg" --json | jq '{score: .overallScore, grade, precision: .dimensions[0].score}'
done

# Analyze a local project's source code (broader scoring range)
tsguard analyze ./src --verbose
```
