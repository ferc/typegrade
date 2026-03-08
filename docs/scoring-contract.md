# Scoring Contract

This document is the canonical reference for `typegrade`'s scoring model: all dimensions, weights, formulas, grading, and the three-layer score architecture.

## Three-layer model

| Layer | Score | Comparability | Description |
|---|---|---|---|
| Global | `consumerApi`, `agentReadiness`, `typeSafety` | Across all libraries | Universal quality scores using fixed weights |
| Domain | `domainFitScore` | Within same domain | Domain-adjusted score with weight multipliers |
| Scenario | `scenarioScore` | Within same scenario pack | Consumer benchmark tests for domain-specific DX |

**Rule**: every library always gets the three global scores. Domain and scenario scores are additional layers, never replacements.

## Global composite weights

### Package mode (8 consumer dimensions)

| Dimension | `consumerApi` | `agentReadiness` | `typeSafety` |
|---|---|---|---|
| apiSpecificity | 0.22 | 0.14 | 0.20 |
| apiSafety | 0.18 | 0.12 | 0.45 |
| semanticLift | 0.10 | 0.10 | 0.10 |
| specializationPower | 0.15 | 0.20 | 0.10 |
| publishQuality | 0.08 | 0.06 | 0.05 |
| surfaceConsistency | 0.06 | 0.05 | — |
| surfaceComplexity | 0.04 | 0.05 | — |
| agentUsability | 0.17 | 0.28 | — |

### Source mode additions (4 more dimensions)

Source mode adds these dimensions on top of the 8 above:

| Dimension | `consumerApi` | `agentReadiness` | `typeSafety` | `implementationQuality` |
|---|---|---|---|---|
| declarationFidelity | 0.10 | — | 0.10 | — |
| implementationSoundness | — | — | 0.05 | 0.45 |
| boundaryDiscipline | — | — | 0.03 | 0.25 |
| configDiscipline | — | — | 0.02 | 0.20 |

`implementationQuality` is a fourth composite, only emitted in source mode. In package mode it is `null` with grade `N/A`.

**Source**: these weights are defined in `src/constants.ts` as `DIMENSION_CONFIGS`.

## Grading scale

| Grade | Score range |
|---|---|
| A+ | >= 95 |
| A | >= 85 |
| B | >= 70 |
| C | >= 55 |
| D | >= 40 |
| F | < 40 |
| N/A | null (no data) |

## Dimensions

### apiSpecificity

Measures how precise exported type positions are, using per-position feature-model scoring with relation-aware signals.

**Formula:**

```
positionScore = clamp(0, 100, basePrecision + sum(featureBonuses))
score = weightedAverage(positionScores) + densityBonus + relationBonuses - penalties
```

**Feature bonuses (per-position):**

| Feature | Bonus |
|---|---|
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

**Relation-aware signals:**

| Signal | Effect |
|---|---|
| Key-preserving transforms | +4 each (max +12) |
| Path-param inference | +5 each (max +15) |
| Latent discriminants | +3 each (max +9) |
| Instantiated specificity potential | +3 each (max +12) |
| Catch-all object bags | -4 each (max -12) |
| Helper-chain opacity | -3 each (max -9) |
| Correlated generic I/O | +3 per param (max +9) |

### apiSafety

Measures `any` and `unknown` leakage in the public API. Domain-aware: suppresses `unknown`-parameter warnings for validation libraries where accepting `unknown` is intentional.

### semanticLift

Measures type-level sophistication above both a widened baseline and an instantiated baseline.

**Dual-baseline model:**
- Baseline A: erase advanced typing to broad approximations.
- Baseline B: estimate precision after generic instantiation with realistic types.
- Effective baseline = max(A, B) — lift must exceed both.

### specializationPower

Measures how well the API specializes generic patterns into precise, domain-specific outputs. Rewards key-preserving transforms, path-param inference, decode/parse output narrowing, and channel propagation.

### publishQuality

Checks exported functions for explicit return types, typed parameters, JSDoc documentation, and proper entrypoint clarity.

### surfaceConsistency

Scores semantic discipline: overload ordering, return type explicitness, naming consistency, nullability patterns, generic naming conventions, result shape consistency.

### surfaceComplexity

Scores harmful complexity: non-conventional generics, nesting depth, wide unions, overload explosion, declaration sprawl, helper-chain depth, ambiguous call surfaces, duplicate concepts.

### agentUsability

Consumer-guidance analyzer measuring how well the API guides AI agents:

| Signal | Effect |
|---|---|
| Named exports | +12 (named), +6 (namespace), -10 (default only) |
| Discriminated error unions | +10 (discriminated), -5 (generic Error) |
| @example JSDoc coverage | +8 (>50%), +4 (>20%), -5 (0%) |
| Overload ambiguity | +5 (clear), -3 per excessive |
| Readable generic names | +5 |
| Parameter-to-result predictability | +8 (correlated generics) |
| Narrow result types | +5 |
| Predictable export structure | +5 |
| Option bag discriminants | -3 per bag (max -9) |
| Stable alias quality | +5 |
| Generic opacity | -2 per opaque (max -8) |
| Wrong-path count | -penalty for >5, +3 for low ambiguity |
| Inference stability | +4 (constrained), -3 (unconstrained) |

### declarationFidelity (source only)

Checks that emitted `.d.ts` declarations preserve the source types, generic parameters, and constraints.

### implementationSoundness (source only)

Detects type assertion abuse (`as any`, double casts `as unknown as X`), non-null assertions, `@ts-ignore` usage, and other unsound patterns.

### boundaryDiscipline (source only)

Checks for runtime validation at I/O boundaries: `JSON.parse()`, `fetch()`, file reads. Rewards use of validation libraries (zod, valibot, etc.) at these boundaries.

### configDiscipline (source only)

Checks TypeScript compiler strictness flags. Each flag has a point value (defined in `src/constants.ts` as `STRICT_FLAGS`):

| Flag | Points |
|---|---|
| strictNullChecks | 15 |
| noUncheckedIndexedAccess | 12 |
| strict | 10 |
| noImplicitAny | 10 |
| strictFunctionTypes | 10 |
| exactOptionalPropertyTypes | 10 |
| noImplicitReturns | 8 |
| noFallthroughCasesInSwitch | 5 |
| noImplicitOverride | 5 |
| strictBindCallApply | 5 |
| strictPropertyInitialization | 5 |
| isolatedModules | 3 |
| verbatimModuleSyntax | 2 |

## Type precision hierarchy

From lowest to highest precision:

| Level | Base score | Example |
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

## Composite confidence

```
confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

Default dimension confidence is 0.8 when not explicitly set. See [Confidence Model](confidence-model.md) for details.

## Domain-fit score

When domain inference detects a known domain with >= 70% confidence and >= 15% gap over runner-up, a `domainFitScore` is computed using domain-specific weight multipliers applied to the `consumerApi` base weights.

| Domain | Key adjustments |
|---|---|
| router | apiSpecificity ×1.4, semanticLift ×1.3, surfaceComplexity ×0.7, specializationPower ×1.4 |
| validation | apiSpecificity ×1.2, semanticLift ×1.2, specializationPower ×1.2 |
| orm | apiSpecificity ×1.3, semanticLift ×1.2, specializationPower ×1.3 |
| result | semanticLift ×1.4, agentUsability ×1.2, specializationPower ×1.2 |
| schema | semanticLift ×1.3, surfaceComplexity ×0.6, specializationPower ×1.3 |
| stream | semanticLift ×1.2, surfaceComplexity ×0.7, specializationPower ×1.2 |

**Source**: these multipliers are defined in `src/constants.ts` as `DOMAIN_FIT_ADJUSTMENTS`.

**Hard rule**: domain inference may suppress issue severity but may never directly increase a global score. Domain adjustments only affect the domain-fit score layer.

## Domain inference

Scored rule engine with five rule categories:

1. **package-name**: direct match against known library names (+0.6).
2. **declaration-shape**: pattern matching on exported names.
3. **symbol-role**: Result/Either type alias detection.
4. **generic-structure**: generic parameter density analysis.
5. **issue-pattern**: domain-specific patterns in analyzer output.

Output: `domain`, `confidence`, `falsePositiveRisk`, `matchedRules`, `adjustments`.

Supported domains: validation, result, router, orm, schema, stream, frontend, utility, general.

## Scenario packs

Domain-specific consumer benchmark tests:

- **Router**: path-param inference, search-param inference, loader/action result propagation, route narrowing, nested route context, link target correctness.
- **Validation**: unknown-to-validated output, refinement/transform pipelines, discriminated schema composition, parse/assert/guard ergonomics.
- **ORM**: schema-to-query result inference, join result precision, selected-column narrowing.
- **Result/Effect**: error channel propagation, map/flatMap/match precision, async composition guidance.
- **Schema/Utility**: key-preserving transforms, deep recursive transforms, alias readability.
- **Stream**: pipe/operator inference, value/error channel propagation, composition patterns.

## Zero-file behavior

When no source files are found: all composites get score 0, grade `N/A`.
