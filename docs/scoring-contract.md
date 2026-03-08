# Scoring Contract

This document specifies the complete scoring model: dimensions, formulas, weights, and grading.

## Composites

tsguard produces three composite scores:

| Composite | Key | Description |
|-----------|-----|-------------|
| Consumer API | `consumerApi` | Quality of the public API for downstream consumers |
| Implementation Quality | `implementationQuality` | Internal implementation soundness (source mode only) |
| Agent Readiness | `agentReadiness` | Combined readiness for AI agent consumption |

### Agent Readiness Formula

- **Source mode:** `0.65 × consumerApi + 0.35 × implementationQuality`
- **Package mode:** `1.0 × consumerApi`

### Grading Scale

| Grade | Score Range |
|-------|------------|
| A+    | ≥ 95       |
| A     | ≥ 85       |
| B     | ≥ 70       |
| C     | ≥ 55       |
| D     | ≥ 40       |
| F     | < 40       |
| N/A   | null (no data) |

## Dimensions

### Consumer Dimensions (11 total, 7 consumer + 4 source-only)

#### apiSpecificity (weight: 0.35)

Measures how precise exported type positions are, using per-position feature-model scoring.

**Formula:**
```
positionScore = clamp(0, 100, basePrecision + Σ featureBonus)
score = weightedAverage(positionScores) + densityBonus - anyPenalty - recordLikePenalty
```

**Feature bonuses (per-position):**
| Feature | Bonus |
|---------|-------|
| branded | +8 |
| constraint-strong | +8 |
| discriminated-union | +6 |
| constrained-generic | +5 |
| constraint-structural | +5 |
| mapped-type | +5 |
| template-literal | +5 |
| conditional-type | +4 |
| constraint-basic | +3 |

**Density bonus:** If >50% of positions have features, `+round((density - 0.5) × 10)`.

**Confidence:** `min(1, sampleCount / 20)`

#### apiSafety (weight: 0.20)

Measures `any` and `unknown` leakage in the public API.

**Formula:**
```
score = 100 - anyDensity × 80 - unknownDensity × 20
```

- `any` positions → severity "error"
- `unknown` in function params → severity "warning"
- Domain-aware: validation libraries suppress `unknown` param warnings

#### semanticLift (weight: 0.15)

Measures type-level sophistication above a widened baseline.

**Formula:**
```
lift(position) = max(0, precisionScore - widenedBaseline(features))
score = featureRatio × 40 + meanLift × 0.6 + correlationBonus
```

**Per-feature widened baselines:**
| Feature | Baseline |
|---------|----------|
| constrained-generic, constraint-* | 35 |
| branded, literal-union, template-literal, mapped-type, conditional-type, discriminated-union, indexed-access, infer, tuple | 40 |

**Correlation bonus:** `min(correlationCount × 8, 20)` — rewards generic params that flow from input to output.

**Confidence:** `min(1, totalPositions / 20)`

#### publishQuality (weight: 0.08)

Measures publish-readiness of the package.

**Formula:**
```
score = returnTypeScore(35%) + paramTypeScore(20%) + entrypointClarity(15+10) + jsDocCoverage(15) + docsDensityBonus(5)
```

- Entrypoint clarity: +15 for `types`/`typings` field, +10 for `exports` with `types` conditions
- Docs density: +5 if ≥80% of functions have JSDoc

**Confidence:** 1.0 if package.json resolved, 0.7 otherwise

#### surfaceConsistency (weight: 0.05)

Measures API surface consistency. Starts at 100, penalties applied.

**Checks:**
- Overload density: penalty if ratio > 3.0 (`-min(25, (ratio-3)×10)`)
- Return type explicitness: penalty if <80% explicit (`-min(20, (80-pct)/4)`)
- Naming consistency: -5 if mixed camelCase/PascalCase
- Nullability convention: -5 if mixed null/undefined usage

#### surfaceComplexity (weight: 0.05)

Measures API surface complexity. Starts at 100, penalties applied.

**Checks:**
- Non-conventional generic names: -10 if any
- Type nesting depth: -3 per deeply nested type (>3 levels, max -15)
- Wide union/intersection: -2 per type with >8 union or >5 intersection members (max -10)

#### agentUsability (weight: 0.02)

Measures AI agent friendliness. Starts at 50.

**Signals:**
- Named exports (≥90%: +15, ≥70%: +8, majority default: -10)
- Discriminated error unions: +10
- Generic Error returns: -5
- @example JSDoc coverage (≥50%: +10, ≥20%: +5, <20% with ≥5 functions: -5)
- Effective overloads: +5
- Readable generic names (≥90%): +5

### Source-Only Dimensions

#### declarationFidelity (weight: 0.10, consumerApi)

Checks that emitted `.d.ts` declarations preserve generics and constraints from source.

#### implementationSoundness (weight: 0.45, implementationQuality)

Detects type assertion abuse, double casts, and unsound patterns in source code.

#### boundaryDiscipline (weight: 0.25, implementationQuality)

Checks that I/O boundaries (fetch, fs, etc.) validate incoming data. Disabled when no I/O boundaries detected.

#### configDiscipline (weight: 0.20, implementationQuality)

Scores TypeScript compiler strictness flags.

## Composite Confidence

Composite confidence = `min(dimension confidences)` across contributing dimensions.

Default dimension confidence is 0.8 when not explicitly set.

## Zero-File Behavior

When no source files are found:
- `filesAnalyzed = 0`
- All composites get score 0, grade "N/A"
- `dimensions` array is empty
