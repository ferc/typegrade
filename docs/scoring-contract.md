# Scoring Contract

This document specifies the complete scoring model: dimensions, formulas, weights, and grading.

## Composites

typegrade produces four composite scores:

| Composite | Key | Description |
|-----------|-----|-------------|
| Consumer API | `consumerApi` | Quality of the public API for downstream consumers |
| Agent Readiness | `agentReadiness` | Downstream usefulness for AI-assisted coding |
| Type Safety | `typeSafety` | Public safety and unsoundness risk |
| Implementation Quality | `implementationQuality` | Internal implementation soundness (source mode only) |

### Composite Weight Model

Each composite is computed as a weighted average of its contributing dimensions. Unlike the previous version, `agentReadiness` is no longer derived from `consumerApi` — it has its own independent dimension weights.

#### Package Mode Weights

| Dimension | consumerApi | agentReadiness | typeSafety |
|-----------|------------|----------------|------------|
| apiSpecificity | 0.30 | 0.20 | 0.25 |
| apiSafety | 0.20 | 0.15 | 0.55 |
| semanticLift | 0.15 | 0.15 | 0.10 |
| publishQuality | 0.10 | 0.05 | 0.10 |
| surfaceConsistency | 0.05 | 0.05 | — |
| surfaceComplexity | 0.05 | 0.05 | — |
| agentUsability | 0.15 | 0.35 | — |

#### Source Mode Additions

Source mode adds these dimensions:

| Dimension | consumerApi | agentReadiness | typeSafety | implementationQuality |
|-----------|------------|----------------|------------|----------------------|
| declarationFidelity | 0.10 | 0.05 | 0.10 | — |
| implementationSoundness | — | — | 0.20 | 0.45 |
| boundaryDiscipline | — | — | 0.10 | 0.25 |
| configDiscipline | — | — | 0.05 | 0.20 |

### Grading Scale

| Grade | Score Range |
|-------|------------|
| A+    | >= 95       |
| A     | >= 85       |
| B     | >= 70       |
| C     | >= 55       |
| D     | >= 40       |
| F     | < 40       |
| N/A   | null (no data) |

## Dimensions

### Consumer Dimensions

#### apiSpecificity

Measures how precise exported type positions are, using per-position feature-model scoring.

**Formula:**
```
positionScore = clamp(0, 100, basePrecision + sum(featureBonus))
score = weightedAverage(positionScores) + densityBonus - anyPenalty - recordLikePenalty - weakGuidancePenalty - lowReturnPenalty
```

**Feature bonuses (per-position):**
| Feature | Bonus |
|---------|-------|
| branded | +8 |
| constraint-strong | +8 |
| discriminated-union | +6 |
| recursive-type | +6 |
| constrained-generic | +5 |
| constraint-structural | +5 |
| mapped-type | +5 |
| template-literal | +5 |
| key-remapping | +5 |
| infer | +5 |
| conditional-type | +4 |
| indexed-access | +4 |
| constraint-basic | +3 |
| literal-union | +3 |
| tuple | +3 |
| never | +2 |

**Additional signals:**
- **Density bonus:** If >50% of positions have features, `+round((density - 0.5) * 10)`
- **Weak guidance penalty:** -5 if >30% of positions score below 40
- **Low return value penalty:** -5 if >50% of returns are void or any
- **Escape-hatch overload penalty:** -8 per function with catch-all any overloads
- **Broad fallback overload penalty:** -5 per function with wider implementation params
- **Correlated generic I/O bonus:** +3 per correlated param (max +9) when generic flows from input to output

**Confidence:** `min(1, sampleCount / 20)`

#### apiSafety

Measures `any` and `unknown` leakage in the public API.

**Formula:**
```
score = 100 - anyDensity * 80 - unknownDensity * 20
```

- `any` positions -> severity "error"
- `unknown` in function params -> severity "warning"
- Domain-aware: validation libraries suppress `unknown` param warnings

#### semanticLift

Measures type-level sophistication above a widened baseline, with per-feature scaling.

**Formula:**
```
rawLift(position) = max(0, precisionScore - widenedBaseline(features))
scaledLift = rawLift * FEATURE_LIFT_SCALE[primaryFeature]
score = liftRatio * 35 + scaledMeanLift * 0.7 + correlationBonus + diversityBonus
```

**Per-feature lift scaling:**
| Feature | Scale | Rationale |
|---------|-------|-----------|
| discriminated-union | 1.3 | Enables exhaustive matching |
| branded | 1.2 | Eliminates type confusion |
| literal-union | 1.1 | Very specific types |
| constraint-strong | 1.1 | Above-standard narrowing |
| constrained-generic | 1.0 | Standard |
| infer | 1.0 | Standard |
| conditional-type | 0.9 | Can be opaque |
| constraint-structural | 0.9 | |
| template-literal | 0.9 | |
| tuple | 0.9 | |
| mapped-type | 0.8 | Can be complex without benefit |
| indexed-access | 0.8 | |
| constraint-basic | 0.7 | Minimal narrowing |

**Diversity bonus:** `min(featureCount * 2, 10)` — rewards use of 3+ distinct advanced features.

**Correlation bonus:** `min(correlationCount * 8, 20)` — rewards generic params that flow from input to output.

**Confidence:** `min(1, totalPositions / 20)`

#### publishQuality

Measures publish-readiness of the package.

**Formula:**
```
score = returnTypeScore(35%) + paramTypeScore(20%) + entrypointClarity(15+10) + jsDocCoverage(15) + docsDensityBonus(5)
```

- Entrypoint clarity: +15 for `types`/`typings` field, +10 for `exports` with `types` conditions
- Docs density: +5 if >=80% of functions have JSDoc

**Confidence:** 1.0 if package.json resolved, 0.7 otherwise

#### surfaceConsistency

Measures API surface consistency. Starts at 100, penalties applied.

**Checks:**
- Overload density: penalty if ratio > 3.0 (`-min(25, (ratio-3)*10)`)
- Overload ordering quality: penalty for poorly-ordered overload signatures
- Return type explicitness: penalty if <80% explicit (`-min(20, (80-pct)/4)`)
- Naming consistency: -5 if mixed camelCase/PascalCase
- Nullability convention: -5 if mixed null/undefined usage
- Generic naming consistency: -5 if mixed single-letter/descriptive styles
- Result shape consistency: -5 if mixed discriminant properties across result types

#### surfaceComplexity

Penalizes harmful API surface complexity. Starts at 100, penalties applied.

**Checks:**
- Non-conventional generic names: -10 if any
- Type nesting depth: -3 per deeply nested type (>3 levels, max -15)
- Wide union/intersection: -2 per type with >8 union or >5 intersection members (max -10)
- Overload explosion: penalty if >50 total overloads (`-min(15, (count-50)/5)`)
- Declaration sprawl: penalty if >200 declarations (`-min(10, (count-200)/20)`)
- Helper-chain depth: -5 if average type alias chain depth > 2
- Ambiguous call surfaces: -2 per function with same-param-count overloads (max -10)
- Duplicate public concepts: penalty for identically-named declarations

#### agentUsability

Measures AI agent friendliness. Starts at 50.

**Signals:**
- Named exports (>=90%: +15, >=70%: +8, majority default: -10)
- Discriminated error unions: +10
- Generic Error returns: -5
- @example JSDoc coverage (>=50%: +10, >=20%: +5, <20% with >=5 functions: -5)
- Overload ambiguity (clear <=4: +5, ambiguous >6: -3 each, max -10)
- Readable generic names (>=90%): +5
- Correlated generic I/O (>30% of generic functions): +8
- Narrow result types (>70% specific returns): +5
- Predictable export structure (>60% one kind): +5
- Option bag discriminant check (-3 per bag without type/kind/mode, max -9)
- Stable type aliases (>70% descriptive non-trivial aliases): +5
- Generic opacity penalty (-2 per function with >3 generics, max -8)

### Source-Only Dimensions

#### declarationFidelity (source-only)

Checks that emitted `.d.ts` declarations preserve generics and constraints from source.

#### implementationSoundness (source-only)

Detects type assertion abuse, double casts, and unsound patterns in source code.

#### boundaryDiscipline (source-only)

Checks that I/O boundaries (fetch, fs, etc.) validate incoming data. Disabled when no I/O boundaries detected.

#### configDiscipline (source-only)

Scores TypeScript compiler strictness flags.

## Composite Confidence

Composite confidence is computed as a weighted evidence score:
```
confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

This replaces the previous pure-min model. The weighted approach is more informative: the bottleneck dimension still dominates (60% weight), but the average adds signal from well-sampled dimensions (40% weight).

Each composite also includes `compositeConfidenceReasons` listing the confidence bottleneck and any notable gaps.

Default dimension confidence is 0.8 when not explicitly set.

**Source-mode fallback penalty:** When declaration emit fails and consumer analysis uses raw source files, all dimension confidences are capped at 0.6.

## Domain Inference

Domain inference uses a scored rule engine with five categories of evidence:
- **package-name**: Direct match against known library lists (strongest signal, +0.6)
- **declaration-shape**: Pattern matching on declaration names and shapes
- **symbol-role**: Detection of specific type alias names (Result, Either, etc.)
- **generic-structure**: Analysis of generic parameter usage patterns
- **issue-pattern**: Detection of domain-specific patterns (unknown params, etc.)

Each rule emits a domain, category, name, and score. The winning domain is selected by highest aggregate score (minimum 0.5 threshold).

**Hard rule:** Domain inference may suppress issue severity, but may not directly increase a score. It can only change interpretation, confidence, or false-positive filtering.

**Output includes:**
- `falsePositiveRisk`: 0-1 estimate of misclassification risk, based on rule diversity and competing domains
- `matchedRules`: List of rules that fired

## Zero-File Behavior

When no source files are found:
- `filesAnalyzed = 0`
- All composites get score 0, grade "N/A"
- `dimensions` array is empty
