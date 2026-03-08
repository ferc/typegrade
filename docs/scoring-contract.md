# Scoring Contract

This document specifies the complete scoring model: dimensions, formulas, weights, grading, and the three-layer score architecture.

## Product Model

typegrade produces scores at three layers:

| Layer | Score | Comparability | Description |
|-------|-------|---------------|-------------|
| Global | `globalConsumerApi`, `globalAgentReadiness`, `globalTypeSafety` | Across all libraries | Universal quality scores using fixed weights |
| Domain | `domainFitScore` | Within same domain | Domain-adjusted score with weighted emphasis |
| Scenario | `scenarioScore` | Within same scenario pack | Consumer-specified score from benchmark apps |

**Rule:** Unknown library default output always includes the three global scores. Domain and scenario scores are additional layers, never replacements.

## Global Composites

### Global Weight Model (Package Mode)

| Dimension | consumerApi | agentReadiness | typeSafety |
|-----------|------------|----------------|------------|
| apiSpecificity | 0.28 | 0.18 | 0.25 |
| apiSafety | 0.18 | 0.12 | 0.50 |
| semanticLift | 0.12 | 0.10 | 0.10 |
| publishQuality | 0.10 | 0.05 | 0.05 |
| surfaceConsistency | 0.07 | 0.05 | — |
| surfaceComplexity | 0.05 | 0.05 | — |
| agentUsability | 0.20 | 0.35 | — |

### Source Mode Additions

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

## Domain-Fit Score

When domain inference detects a known domain with ≥50% confidence, a `domainFitScore` is computed using domain-specific weight adjustments:

| Domain | Key Adjustments |
|--------|----------------|
| router | apiSpecificity ×1.4, semanticLift ×1.3, surfaceComplexity ×0.7 |
| validation | apiSpecificity ×1.2, semanticLift ×1.2 |
| orm | apiSpecificity ×1.3, semanticLift ×1.2 |
| result | semanticLift ×1.4, agentUsability ×1.2 |
| schema | semanticLift ×1.3, surfaceComplexity ×0.6 |
| stream | semanticLift ×1.2, surfaceComplexity ×0.7 |

**Rule:** Domain inference may suppress false-positive issues but may NOT directly increase a global score.

## Scenario Packs

Domain-specific consumer benchmark tests that measure real downstream DX:

### Router Pack
- Path-param inference (template literal route types)
- Search param inference
- Loader/action result propagation
- Route narrowing after navigation
- Nested route context propagation
- Link target correctness

### Validation Pack
- Unknown input to validated output
- Refinement/transform pipelines
- Discriminated schema composition
- Parse/assert/guard ergonomics

### ORM Pack
- Schema-to-query result inference
- Join result precision
- Selected-column narrowing

### Result/Effect Pack
- Error channel propagation
- map/flatMap/match precision
- Async composition guidance

### Schema/Utility Pack
- Key-preserving transforms
- Deep transforms (recursive)
- Alias readability

### Stream Pack
- Pipe/operator inference
- Value/error channel propagation
- Composition patterns

## Dimensions

### apiSpecificity

Measures how precise exported type positions are, using per-position feature-model scoring with relation-aware signals.

**Formula:**
```
positionScore = clamp(0, 100, basePrecision + sum(featureBonus))
score = weightedAverage(positionScores) + densityBonus + relationBonuses - penalties
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

**Relation-aware signals (new):**
| Signal | Effect |
|--------|--------|
| Key-preserving transforms | +4 each (max +12) |
| Path-param inference | +5 each (max +15) |
| Latent discriminants | +3 each (max +9) |
| Instantiated specificity potential | +3 each (max +12) |
| Catch-all object bags | -4 each (max -12) |
| Helper-chain opacity | -3 each (max -9) |
| Correlated generic I/O | +3 per param (max +9) |

### apiSafety

Measures `any` and `unknown` leakage in the public API.

### semanticLift

Measures type-level sophistication above both a widened baseline and an instantiated baseline.

**Dual baseline model:**
- Baseline A: erase advanced typing to broad approximations
- Baseline B: estimate precision after generic instantiation with realistic types
- Effective baseline = max(A, B) — lift must exceed both

### agentUsability

Consumer-guidance analyzer measuring how well the API guides AI agents:

**Signals:**
- Discoverability: named vs default exports (+12/+6/-10)
- Discriminated error unions (+10) vs generic Error (-5)
- @example JSDoc coverage (+8/+4/-5)
- Overload ambiguity (+5 clear, -3 per excessive)
- Readable generic names (+5)
- Parameter-to-result predictability (correlated generics, +8)
- Narrow result types (+5)
- Predictable export structure (+5)
- Option bag discriminants (-3 per bag, max -9)
- Stable alias quality (+5)
- Generic opacity (-2 per opaque, max -8)
- Wrong-path count (-penalty for >5 wrong paths, +3 for low ambiguity)
- Inference stability (constrained vs unconstrained generics, +4/-3)

### surfaceConsistency

Scores semantic discipline: overload ordering, return type explicitness, naming consistency, nullability patterns, generic naming, result shape consistency.

### surfaceComplexity

Scores harmful complexity: non-conventional generics, nesting depth, wide unions, overload explosion, declaration sprawl, helper-chain depth, ambiguous call surfaces, duplicate concepts.

### Source-Only Dimensions

- **declarationFidelity**: Emitted `.d.ts` preserves generics and constraints
- **implementationSoundness**: Type assertion abuse, double casts, unsound patterns
- **boundaryDiscipline**: I/O boundary validation
- **configDiscipline**: TypeScript compiler strictness

## Composite Confidence

```
confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

Default dimension confidence is 0.8 when not explicitly set.

## Domain Inference

Scored rule engine with five categories:
- **package-name**: Direct match (+0.6)
- **declaration-shape**: Pattern matching on names
- **symbol-role**: Result/Either type alias detection
- **generic-structure**: Generic parameter analysis
- **issue-pattern**: Domain-specific patterns

Output: domain, confidence, falsePositiveRisk, matchedRules, adjustments.

**Hard rule:** Domain inference may suppress issue severity, but may not directly increase a score.

## Zero-File Behavior

When no source files are found: all composites get score 0, grade "N/A".
