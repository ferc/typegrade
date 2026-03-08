# tsguard Testing Guide

How to validate tsguard's scoring against real-world TypeScript packages.

## Testing Methods

### A) Analyze source code

Clone the repo and point tsguard at the source directory. All 11 dimensions contribute, giving the fullest picture:

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/test-zod
tsguard analyze /tmp/test-zod/packages/zod
```

Best for: projects you own or want the complete source+implementation analysis.

### B) Score npm package

Installs the package to a temp directory and analyzes published `.d.ts` declarations:

```bash
tsguard score zod
tsguard score zod@3.24.2
tsguard score express --json
```

Best for: evaluating the published API surface that consumers and AI agents actually see. Uses the declaration graph engine to resolve entrypoints and walk only reachable files.

### C) Analyze local packages

```bash
tsguard score ./path/to/package     # Package mode (declarations only)
tsguard analyze ./path/to/project   # Source mode (all dimensions)
```

## Architecture Overview

### Three Composite Scores

| Composite | Source Mode | Package Mode |
|---|---|---|
| **Agent Readiness** | 65% Consumer API + 35% Implementation | 100% Consumer API |
| **Consumer API** | Weighted average of 8 dimensions | Weighted average of 7 dimensions |
| **Implementation** | Weighted average of 3 dimensions | n/a (disabled) |

### Eleven Dimensions

**Consumer API (published declarations):**

| Dimension | Weight | Key |
|---|---|---|
| API Specificity | 35% | `apiSpecificity` |
| API Safety | 20% | `apiSafety` |
| Semantic Lift | 15% | `semanticLift` |
| Publish Quality | 8% | `publishQuality` |
| Surface Consistency | 5% | `surfaceConsistency` |
| Surface Complexity | 5% | `surfaceComplexity` |
| Agent Usability | 5% | `agentUsability` |
| Declaration Fidelity | 7% | `declarationFidelity` (source-only) |

**Implementation (source only):**

| Dimension | Weight | Key |
|---|---|---|
| Soundness | 45% | `implementationSoundness` |
| Boundary Discipline | 25% | `boundaryDiscipline` |
| Config Discipline | 20% | `configDiscipline` |

## Benchmark Results (Package Scoring)

Scored with `tsguard score` (package mode, published declarations only).

### Elite Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **valibot@1.0.0** | **84** | **B** |
| **ts-pattern@5.6.2** | **74** | **B** |
| **arktype@2.1.0** | **68** | **C** |
| **effect@3.14.8** | **68** | **C** |
| **zod@3.24.2** | **67** | **C** |

### Solid Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **date-fns@4.1.0** | **72** | **B** |
| **remeda@2.21.2** | **71** | **B** |
| **neverthrow@8.2.0** | **64** | **C** |
| **type-fest@4.35.0** | **62** | **C** |
| **drizzle-orm@0.39.3** | **58** | **C** |

### Loose Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **uuid@11.1.0** | **64** | **C** |
| **lodash@4.17.21** | **62** | **C** |
| **express@5.1.0** | **60** | **C** |
| **moment@2.30.1** | **57** | **C** |
| **axios@1.8.4** | **50** | **D** |

### Stretch Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **io-ts@2.2.22** | **78** | **B** |
| **fp-ts@2.16.9** | **77** | **B** |
| **rxjs@7.8.2** | **65** | **C** |
| **hono@4.7.5** | **63** | **C** |
| **@tanstack/react-router@1.114.3** | **58** | **C** |

### Pairwise Assertions

44 pairwise assertions validate relative ordering (16 must-pass, 28 diagnostic). All must-pass assertions pass. Key assertions:

- Elite > Loose: `valibot > express`, `zod > lodash`, `effect > axios (minDelta: 5)`, etc.
- Elite > Solid: `valibot > type-fest`, `valibot > drizzle-orm`
- Coverage: `remeda > express`, `neverthrow > moment`, `type-fest > axios`, `date-fns > uuid`
- Stretch: `fp-ts > express`, `io-ts > axios`, `rxjs > moment`, `hono > express`

Run the full assertion suite:

```bash
pnpm benchmark
```

## Calibration Notes

### Package Mode

In package mode, 4 of 11 dimensions are disabled (Declaration Fidelity + all 3 implementation dimensions). The 7 active consumer dimensions produce meaningful differentiation:

- **API Specificity** (35% weight) is the primary differentiator — measures type narrowness with per-position feature-model scoring
- **API Safety** (20%) catches `any` and `unknown` leakage in exported APIs
- **Semantic Lift** (15%) rewards advanced type features with per-feature scaling (discriminated unions, branded types, etc.)
- **Publish Quality** (8%) measures explicit return types, JSDoc, and entrypoint clarity
- **Surface Consistency** (5%) checks naming, nullability, and overload conventions
- **Surface Complexity** (5%) penalizes excessive nesting, wide unions, and declaration sprawl
- **Agent Usability** (5%) measures AI agent friendliness (named exports, discriminated errors, correlated generics)

### Source Mode

Source analysis uses all 11 dimensions. Key differences from package mode:

1. **Declaration Fidelity** checks that emitted `.d.ts` preserves source types, generic parameters, and constraints
2. **Implementation Soundness** penalizes `as any`, non-null assertions, `@ts-ignore`
3. **Boundary Discipline** checks I/O validation at fetch/JSON.parse/file-read sites
4. **Config Discipline** checks strict tsconfig flags
5. **Source-mode fallback** — if declaration emit fails, consumer analysis uses raw source files with all confidences capped at 0.6

### Domain Detection

tsguard detects 9 library domains and adjusts scoring:

- **Validation** (zod, valibot, arktype, etc.): `unknown` param warnings suppressed in API Safety
- **Result** (neverthrow, effect, fp-ts): Recognized for discriminated union patterns
- **Stream** (rxjs, xstate, most): Higher-order generic signatures accepted in Surface Complexity
- **Schema/Utility** (type-fest, ts-toolbelt): High generic density expected in API Specificity
- **Router** (express, fastify, hono): Route/handler/middleware pattern detection
- **ORM** (drizzle-orm, prisma): Model/schema/table pattern detection
- **Frontend** (react, preact, vue, svelte): Package name matching

### Known Limitations

1. **`void` scores 60**: Functions returning `void` score moderately. This is intentional — `void` is meaningful but not as precise as a concrete return type.

2. **Zod source vs package**: Zod source scores lower than its package because internal `as any` assertions penalize Implementation Soundness. The published `.d.ts` hides this, which is correct — consumers see a type-safe API.

3. **Express and lodash**: These JS-origin libraries score in the 60-62 range in package mode. Their `.d.ts` types (from DefinitelyTyped) contain `any` leakage and wide primitives.

4. **type-fest complexity**: type-fest scores lower than expected (62) due to surfaceComplexity penalties from declaration sprawl and deep type nesting — inherent to its nature as a type utility collection.

## Running Benchmarks

```bash
# Full benchmark suite (20 packages + assertions)
pnpm benchmark

# Calibration analysis (concordance, ties, weight sensitivity, delta histogram)
npx tsx benchmarks/calibrate.ts

# Score individual packages
tsguard score <package-name> --json
tsguard score <package-name>@<version> --verbose

# Compare packages
for pkg in zod valibot arktype effect; do
  echo -n "$pkg: "
  tsguard score "$pkg" --json | jq '.composites[] | select(.key == "consumerApi") | .score'
done
```
