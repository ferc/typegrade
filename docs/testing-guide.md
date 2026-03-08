# tsguard Testing Guide

How to validate tsguard's scoring against real-world TypeScript packages.

## Testing Methods

### A) Analyze source code

Clone the repo and point tsguard at the source directory. All 9 dimensions contribute, giving the fullest picture:

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
| **Consumer API** | Weighted average of 6 dimensions | Weighted average of 5 dimensions |
| **Implementation** | Weighted average of 3 dimensions | n/a (disabled) |

### Nine Dimensions

**Consumer API (published declarations):**

| Dimension | Weight | Key |
|---|---|---|
| API Specificity | 40% | `apiSpecificity` |
| API Safety | 20% | `apiSafety` |
| Semantic Lift | 15% | `semanticLift` |
| Publish Quality | 10% | `publishQuality` |
| Surface Coherence | 5% | `surfaceCoherence` |
| Declaration Fidelity | 10% | `declarationFidelity` (source-only) |

**Implementation (source only):**

| Dimension | Weight | Key |
|---|---|---|
| Soundness | 45% | `implementationSoundness` |
| Boundary Discipline | 25% | `boundaryDiscipline` |
| Config Discipline | 20% | `configDiscipline` |

## Benchmark Results (Package Scoring)

Scored with `tsguard score` (package mode, published declarations only).

### Elite Tier

| Package | ConsumerAPI | Grade | Specificity | Safety | Lift | Quality | Coherence |
|---|---|---|---|---|---|---|---|
| **valibot@1.0.0** | **90** | **A** | — | — | — | — | — |
| **effect@3.14.8** | **77** | **B** | — | — | — | — | — |
| **ts-pattern@5.6.2** | **74** | **B** | — | — | — | — | — |
| **arktype@2.1.0** | **73** | **B** | — | — | — | — | — |
| **zod@3.24.2** | **71** | **B** | — | — | — | — | — |

### Solid Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **date-fns@4.1.0** | **74** | **B** |
| **remeda@2.21.2** | **72** | **B** |
| **type-fest@4.35.0** | **71** | **B** |
| **drizzle-orm@0.39.3** | **63** | **C** |
| **neverthrow@8.2.0** | **61** | **C** |

### Loose Tier

| Package | ConsumerAPI | Grade |
|---|---|---|
| **lodash@4.17.21** | **61** | **C** |
| **uuid@11.1.0** | **61** | **C** |
| **moment@2.30.1** | **57** | **C** |
| **axios@1.8.4** | **50** | **D** |
| **express@5.1.0** | **46** | **D** |

### Pairwise Assertions

38 pairwise assertions validate relative ordering. All pass. Key assertions:

- Elite > Loose: `valibot > express`, `zod > lodash`, `effect > axios`, etc.
- Elite > Solid: `valibot > type-fest`, `valibot > drizzle-orm`
- Intra-tier: `valibot > zod`, `effect > remeda`, `remeda > lodash`

Run the full assertion suite:

```bash
pnpm benchmark
```

## Calibration Notes

### Package Mode

In package mode, 4 of 9 dimensions are disabled (Declaration Fidelity + all 3 implementation dimensions). The 5 active consumer dimensions produce meaningful differentiation:

- **API Specificity** (40% weight) is the primary differentiator — measures type narrowness across all exported positions
- **API Safety** (20%) catches `any` leakage in exported APIs
- **Semantic Lift** (15%) rewards advanced type features (branded types, discriminated unions, mapped types)
- **Publish Quality** (10%) measures explicit return types and JSDoc
- **Surface Coherence** (5%) checks API consistency

### Source Mode

Source analysis uses all 9 dimensions. Key differences from package mode:

1. **Declaration Fidelity** checks that emitted `.d.ts` preserves source types, generic parameters, and constraints
2. **Implementation Soundness** penalizes `as any`, non-null assertions, `@ts-ignore`
3. **Boundary Discipline** checks I/O validation at fetch/JSON.parse/file-read sites
4. **Config Discipline** checks strict tsconfig flags

### Domain Detection

tsguard detects library domains and adjusts scoring:

- **Validation libraries** (zod, valibot, etc.): `unknown` params suppressed in API Safety
- **Result libraries** (neverthrow, effect): Recognized for discriminated union patterns

### Known Limitations

1. **`void` scores 60**: Functions returning `void` score moderately. This is intentional — `void` is meaningful but not as precise as a concrete return type.

2. **Zod source vs package**: Zod source scores lower than its package because ~477 internal `as any` assertions penalize Implementation Soundness. The published `.d.ts` hides this, which is correct — consumers see a type-safe API.

3. **Express and lodash**: These JS-origin libraries score in the 46-61 range in package mode. Their `.d.ts` types (from DefinitelyTyped) contain `any` leakage and wide primitives.

## Running Benchmarks

```bash
# Full benchmark suite (15 packages + assertions)
pnpm benchmark

# Calibration analysis
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
