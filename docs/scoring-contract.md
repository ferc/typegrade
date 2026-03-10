# Scoring Contract

This document is the canonical reference for `typegrade`'s scoring model: all dimensions, weights, formulas, grading, and the three-layer score architecture.

## Three-layer model

| Layer    | Score                                         | Comparability             | Description                                     |
| -------- | --------------------------------------------- | ------------------------- | ----------------------------------------------- |
| Global   | `consumerApi`, `agentReadiness`, `typeSafety` | Across all libraries      | Universal quality scores using fixed weights    |
| Domain   | `domainFitScore`                              | Within same domain        | Domain-adjusted score with weight multipliers   |
| Scenario | `scenarioScore`                               | Within same scenario pack | Consumer benchmark tests for domain-specific DX |

**Rule**: every library always gets the three global scores. Domain and scenario scores are additional layers, never replacements. When average composite confidence is below 0.5, domain and scenario scores are stripped from the result to prevent low-evidence data from misleading consumers.

## Global composite weights

### Package mode (8 consumer dimensions)

| Dimension           | `consumerApi` | `agentReadiness` | `typeSafety` |
| ------------------- | ------------- | ---------------- | ------------ |
| apiSpecificity      | 0.22          | 0.14             | 0.20         |
| apiSafety           | 0.18          | 0.12             | 0.45         |
| semanticLift        | 0.10          | 0.10             | 0.10         |
| specializationPower | 0.15          | 0.20             | 0.10         |
| publishQuality      | 0.08          | 0.06             | 0.05         |
| surfaceConsistency  | 0.06          | 0.05             | —            |
| surfaceComplexity   | 0.04          | 0.05             | —            |
| agentUsability      | 0.17          | 0.28             | —            |

### Source mode additions (4 more dimensions)

Source mode adds these dimensions on top of the 8 above:

| Dimension               | `consumerApi` | `agentReadiness` | `typeSafety` | `implementationQuality` |
| ----------------------- | ------------- | ---------------- | ------------ | ----------------------- |
| declarationFidelity     | 0.10          | —                | 0.10         | —                       |
| implementationSoundness | —             | —                | 0.05         | 0.45                    |
| boundaryDiscipline      | —             | —                | 0.03         | 0.25                    |
| configDiscipline        | —             | —                | 0.02         | 0.20                    |

`implementationQuality` is a fourth composite, only emitted in source mode. In package mode it is `null` with grade `N/A`.

**Source**: these weights are defined in `src/constants.ts` as `DIMENSION_CONFIGS`.

## Grading scale

| Grade | Score range    |
| ----- | -------------- |
| A+    | >= 95          |
| A     | >= 85          |
| B     | >= 70          |
| C     | >= 55          |
| D     | >= 40          |
| F     | < 40           |
| N/A   | null (no data) |

## Dimensions

### apiSpecificity

Measures how precise exported type positions are, using per-position feature-model scoring with relation-aware signals.

**Formula:**

```
positionScore = clamp(0, 100, basePrecision + sum(featureBonuses))
score = weightedAverage(positionScores) + densityBonus + relationBonuses - penalties
```

**Feature bonuses (per-position):**

| Feature               | Bonus |
| --------------------- | ----- |
| branded               | +8    |
| constraint-strong     | +8    |
| discriminated-union   | +6    |
| recursive-type        | +6    |
| constrained-generic   | +5    |
| constraint-structural | +5    |
| mapped-type           | +5    |
| template-literal      | +5    |
| key-remapping         | +5    |
| infer                 | +5    |
| conditional-type      | +4    |
| indexed-access        | +4    |
| constraint-basic      | +3    |
| literal-union         | +3    |
| tuple                 | +3    |
| never                 | +2    |

**Relation-aware signals:**

| Signal                             | Effect                |
| ---------------------------------- | --------------------- |
| Key-preserving transforms          | +4 each (max +12)     |
| Path-param inference               | +5 each (max +15)     |
| Latent discriminants               | +3 each (max +9)      |
| Instantiated specificity potential | +3 each (max +12)     |
| Catch-all object bags              | -4 each (max -12)     |
| Helper-chain opacity               | -3 each (max -9)      |
| Correlated generic I/O             | +3 per param (max +9) |

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

| Signal                             | Effect                                          |
| ---------------------------------- | ----------------------------------------------- |
| Named exports                      | +12 (named), +6 (namespace), -10 (default only) |
| Discriminated error unions         | +10 (discriminated), -5 (generic Error)         |
| @example JSDoc coverage            | +8 (>50%), +4 (>20%), -5 (0%)                   |
| Overload ambiguity                 | +5 (clear), -3 per excessive                    |
| Readable generic names             | +5                                              |
| Parameter-to-result predictability | +8 (correlated generics)                        |
| Narrow result types                | +5                                              |
| Predictable export structure       | +5                                              |
| Option bag discriminants           | -3 per bag (max -9)                             |
| Stable alias quality               | +5                                              |
| Generic opacity                    | -2 per opaque (max -8)                          |
| Wrong-path count                   | -penalty for >5, +3 for low ambiguity           |
| Inference stability                | +4 (constrained), -3 (unconstrained)            |

### declarationFidelity (source only)

Checks that emitted `.d.ts` declarations preserve the source types, generic parameters, and constraints.

### implementationSoundness (source only)

Detects type assertion abuse (`as any`, double casts `as unknown as X`), non-null assertions, `@ts-ignore` usage, and other unsound patterns.

### boundaryDiscipline (source only)

Checks for runtime validation at I/O boundaries: `JSON.parse()`, `fetch()`, file reads. Rewards use of validation libraries (zod, valibot, etc.) at these boundaries.

When boundary flow analysis is enabled, this dimension also incorporates the **boundary quality score** — a composite of validation coverage, untrusted-boundary penalties, and trust-model accuracy. See [How It Works: Boundary flow analysis](how-it-works.md#boundary-flow-analysis) for the full scoring formula.

As of schema 0.15.0, boundary hotspots are converted to first-class `Issue` records with `rootCauseCategory` and `suggestedFixKind` mapped from the boundary type. These issues appear in `topIssues` and flow into the fix-plan pipeline, enabling agent-driven boundary remediation through the standard batching system. See [How It Works: Boundary-to-issue pipeline](how-it-works.md#boundary-to-issue-pipeline).

### configDiscipline (source only)

Checks TypeScript compiler strictness flags. Each flag has a point value (defined in `src/constants.ts` as `STRICT_FLAGS`):

| Flag                         | Points |
| ---------------------------- | ------ |
| strictNullChecks             | 15     |
| noUncheckedIndexedAccess     | 12     |
| strict                       | 10     |
| noImplicitAny                | 10     |
| strictFunctionTypes          | 10     |
| exactOptionalPropertyTypes   | 10     |
| noImplicitReturns            | 8      |
| noFallthroughCasesInSwitch   | 5      |
| noImplicitOverride           | 5      |
| strictBindCallApply          | 5      |
| strictPropertyInitialization | 5      |
| isolatedModules              | 3      |
| verbatimModuleSyntax         | 2      |

## Type precision hierarchy

From lowest to highest precision:

| Level                 | Base score | Example                                    |
| --------------------- | ---------- | ------------------------------------------ |
| `any`                 | 0          | `any`                                      |
| `unknown`             | 20         | `unknown`                                  |
| `wide-primitive`      | 40         | `string`, `number`, `boolean`              |
| `interface`           | 55         | `{ name: string; age: number }`            |
| `void`                | 60         | `void`                                     |
| `enum`                | 65         | `enum Role { Admin, User }`                |
| `generic-bound`       | 70         | `<T extends string>`                       |
| `literal`             | 80         | `'active'`, `42`                           |
| `template-literal`    | 82         | `` `/api/${string}` ``                     |
| `literal-union`       | 85         | `'a' \| 'b' \| 'c'`                        |
| `branded`             | 90         | `string & { __brand: 'UserId' }`           |
| `discriminated-union` | 95         | `{ kind: 'circle' } \| { kind: 'square' }` |

## Composite confidence

```
confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

Default dimension confidence is 0.8 when not explicitly set. See [Confidence Model](confidence-model.md) for details.

## Domain-fit score

When domain inference detects a known domain with >= 70% confidence and >= 15% gap over runner-up, a `domainFitScore` is computed using domain-specific weight multipliers applied to the `consumerApi` base weights.

| Domain     | Key adjustments                                                                          |
| ---------- | ---------------------------------------------------------------------------------------- |
| router     | apiSpecificity ×1.4, semanticLift ×1.3, surfaceComplexity ×0.7, specializationPower ×1.4 |
| validation | apiSpecificity ×1.2, semanticLift ×1.2, specializationPower ×1.2                         |
| orm        | apiSpecificity ×1.3, semanticLift ×1.2, specializationPower ×1.3                         |
| result     | semanticLift ×1.4, agentUsability ×1.2, specializationPower ×1.2                         |
| schema     | semanticLift ×1.3, surfaceComplexity ×0.6, specializationPower ×1.3                      |
| stream     | semanticLift ×1.2, surfaceComplexity ×0.7, specializationPower ×1.2                      |

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

Supported domains (12): validation, result, utility, router, orm, schema, frontend, stream, state, testing, cli, general.

## Scenario packs

Domain-specific consumer benchmark tests:

- **Router**: path-param inference, search-param inference, loader/action result propagation, route narrowing, nested route context, link target correctness.
- **Validation**: unknown-to-validated output, refinement/transform pipelines, discriminated schema composition, parse/assert/guard ergonomics.
- **ORM**: schema-to-query result inference, join result precision, selected-column narrowing.
- **Result/Effect**: error channel propagation, map/flatMap/match precision, async composition guidance.
- **Schema/Utility**: key-preserving transforms, deep recursive transforms, alias readability.
- **Stream**: pipe/operator inference, value/error channel propagation, composition patterns.

### Scenario applicability

Each `ScenarioScore` carries a `scenarioApplicability` field indicating whether the scenario was evaluable. Scenarios are gated by domain confidence, graph quality, and domain ambiguity before execution. See [Confidence Model: Scenario applicability gating](confidence-model.md#scenario-applicability-gating) for the full status taxonomy and gating rules.

### Scenario result outcomes

Each individual scenario result within a pack carries an `outcome` field classifying the test result:

| Outcome          | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `pass`           | Score >= 70, scenario fully satisfied                                |
| `partial`        | Score 40-69, scenario partially satisfied                            |
| `fail`           | Score < 40, scenario not satisfied                                   |
| `not-applicable` | Scenario could not be evaluated (insufficient surface or confidence) |

Only results with `outcome` other than `not-applicable` contribute to the aggregate scenario score. This prevents inapplicable tests from diluting the score.

## Root cause categories

Every issue may carry a `rootCauseCategory` identifying why the problem exists. Root cause categories are used by the fix planning pipeline to group related issues and suggest appropriate fixes.

| Category                     | Description                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `missing-validation`         | External data enters without runtime validation                                               |
| `weak-type`                  | Type is too broad for its usage context (e.g., `string` where a literal union is appropriate) |
| `unsafe-cast`                | Type assertion (`as any`, `as unknown as X`) bypasses the type system                         |
| `missing-narrowing`          | Union type is used without discriminant check or type guard                                   |
| `opaque-dependency`          | Dependency types are opaque or poorly typed, infecting downstream code                        |
| `config-gap`                 | TypeScript strict-mode flag is missing or disabled                                            |
| `boundary-leak`              | Unvalidated data crosses a trust boundary                                                     |
| `export-vagueness`           | Exported declaration is less specific than it could be                                        |
| `unsafe-external-input`      | External input is consumed without sanitization                                               |
| `architecture-bypass`        | Code bypasses intended architectural layers or boundaries                                     |
| `declaration-drift`          | Emitted `.d.ts` declarations diverge from source types                                        |
| `missing-strict-config`      | Strict configuration flags are absent                                                         |
| `unresolved-package-surface` | Package surface could not be fully resolved                                                   |
| `other`                      | Does not fit a specific category                                                              |

## Suggested fix kinds

Each issue may carry a `suggestedFixKind` recommending a concrete fix approach.

| Fix kind              | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `add-type-annotation` | Add an explicit type annotation to a declaration                   |
| `add-validation`      | Add runtime validation at a data boundary                          |
| `replace-any`         | Replace `any` with a specific type or `unknown`                    |
| `add-narrowing`       | Add a type guard or discriminant check                             |
| `add-type-guard`      | Add an `is` type predicate function                                |
| `strengthen-generic`  | Add or tighten a generic constraint                                |
| `add-overload`        | Add a more specific overload signature                             |
| `insert-satisfies`    | Insert a `satisfies` expression for type checking without widening |
| `wrap-json-parse`     | Wrap `JSON.parse` with schema validation                           |
| `add-env-parsing`     | Add typed environment variable parsing                             |
| `narrow-overloads`    | Replace broad overloads with narrower signatures                   |
| `hoist-validation`    | Move validation closer to the data boundary                        |
| `other`               | Fix does not fit a specific category                               |

Safe fix categories (`add-explicit-return-type`, `replace-any-with-unknown`, `insert-satisfies`, `wrap-json-parse`, `add-env-parsing`, `narrow-overloads`, `hoist-validation`) can be applied automatically by agents. All other fix kinds require human review.

## Coverage classification

The `samplingClass` field on coverage diagnostics classifies how thoroughly the package surface was sampled.

| Class              | Description                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `complete`         | All declarations and positions were analyzed with no sampling limitations                                   |
| `compact`          | Few declarations exist but analysis is representative (legacy classification)                               |
| `compact-complete` | Compact surface that was fully analyzed — all reachable declarations were covered despite the small surface |
| `compact-partial`  | Compact surface where analysis is incomplete — some reachable declarations could not be analyzed            |
| `undersampled`     | Too few declarations for a reliable score; confidence caps apply                                            |

The `compact-complete` / `compact-partial` distinction refines the older `compact` class. A package with a small but fully-resolved surface (e.g., a focused utility with 3 exported functions) receives `compact-complete` and no confidence penalty. A package with resolution failures on a small surface receives `compact-partial` with moderate confidence caps.

When `undersampled`, confidence caps are applied based on severity: 0.40 (severe), 0.55 (moderate), 0.65 (mild), depending on how many undersampling reasons apply.

## Boundary finding categories

Each boundary inventory entry carries a `findingCategory` classifying the nature of the boundary point:

| Category                       | Description                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `library-public-boundary`      | Boundary at a library's public API surface (exported functions accepting external input) |
| `application-runtime-boundary` | Boundary at application runtime (HTTP handlers, CLI entry points, queue consumers)       |
| `tooling-trusted-local`        | Boundary in tooling or build code where data is locally controlled                       |
| `cross-package-trust-boundary` | Boundary where data crosses between packages with different trust levels                 |

The category helps agents and consumers understand which boundaries are most critical. `library-public-boundary` and `application-runtime-boundary` findings typically require validation, while `tooling-trusted-local` findings can often be safely suppressed.

## Boundary flow scoring

When boundary flow analysis is active (source mode with boundary configuration), a `BoundaryQualityScore` is computed separately from the dimension scores.

**Formula:**

```
base = 50
validationPoints = round(boundaryCoverage * 40)   // 0-40 points
score = base + (validationPoints - 20)
      - min(untrustedUnvalidated * 5, 30)          // untrusted penalty
      + min(trustedLocalSuppressions * 2, 10)      // awareness bonus
score = clamp(0, 100, score)
```

**Outputs:**

| Field                | Description                                         |
| -------------------- | --------------------------------------------------- |
| `score`              | 0-100 boundary quality score                        |
| `grade`              | Letter grade (same scale as composites)             |
| `validatedRatio`     | Proportion of boundaries with downstream validation |
| `trustModelAccuracy` | 1 - (missing hotspots / total boundaries)           |
| `totalBoundaries`    | Number of detected boundary points                  |
| `rationale`          | Human-readable explanation of the score components  |

When no boundaries are detected, the score is 0 with grade `N/A` — indicating the metric is not applicable rather than a failure.

## Suppression Categories

Issues can be suppressed using one of 13 categories. Suppressions are profile-aware — the applicable categories vary depending on the active profile (`library`, `package`, `application`, or `autofix-agent`).

| Category                          | Description                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `trusted-local-tooling`           | Issue originates in local tooling code that is not part of the public surface |
| `dependency-owned-opaque`         | Issue is caused by opaque types owned by a dependency                         |
| `generated-artifact`              | Issue occurs in generated code (codegen output, compiled assets)              |
| `benchmark-self-referential`      | Issue is a false positive from the tool analyzing its own benchmark fixtures  |
| `non-applicable-boundary`         | Boundary rule does not apply to the detected boundary type                    |
| `low-evidence`                    | Issue is based on insufficient evidence to be actionable                      |
| `ambiguous-ownership`             | Ownership of the problematic code is unclear (shared between packages)        |
| `expected-generic-density`        | High generic density is expected for this kind of library                     |
| `self-referential-false-positive` | Self-analysis false positive (tool scoring itself)                            |
| `lexical-only-match`              | Issue triggered by lexical matching without structural confirmation           |
| `non-applicable-dimension`        | Dimension is not meaningful for this profile or domain                        |
| `scenario-domain-ambiguity`       | Scenario pack matched ambiguously across domains                              |
| `expected-domain-complexity`      | Domain-inherent complexity that should not penalize the score                 |
| `internal-tooling-pattern`        | Pattern is idiomatic for internal tooling and should not be flagged           |

Suppressions are configured via `typegrade.config.ts` or applied programmatically through `applySuppressions()`.

## Monorepo health scoring

The `monorepo` command produces a health score based on **severity-weighted** violation counts. Each violation is classified by severity (as of 2026-03-09):

| Severity   | Weight | When assigned                                                                                                  |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `critical` | 20     | Trust-zone-crossing from `domain` or `shared` layers                                                           |
| `high`     | 10     | Trust-zone-crossing from other layers, `unstable-leak`, `infra-bypass`, high trust-delta forbidden-cross-layer |
| `medium`   | 5      | Moderate trust-delta forbidden-cross-layer                                                                     |
| `low`      | 2      | Low trust-delta forbidden-cross-layer                                                                          |

**Formula:**

```
healthScore = 100 - sum(severity_weight × count_per_severity)
healthScore = clamp(0, 100, healthScore)
```

The health report also includes:

- `violationSeveritySummary` — count of violations by severity level
- `violationDensity` — violations per package (normalized for comparability)
- `workspaceConfidence` — confidence in workspace discovery (0=none, 0.3=single package, 0.6=few, 0.9=adequate)
- `layerModelConfidence` — confidence in layer classification (higher when packages have clear layer indicators)
- `crossPackageBoundarySummary` — summary of trust-zone crossings with risk classification, including a `trustGapSeverity` field (`none`, `low`, `moderate`, `high`) computed from the ratio of high-risk crossings to total crossings

When workspace discovery is partial or ambiguous (low `workspaceConfidence`), the health grade should be interpreted with caution.

## Trust summary contract

Every `AnalysisResult` carries a `trustSummary` field that classifies the result into one of three trust tiers. This is the canonical signal for consumers to decide whether to compare, gate, or display the result.

### Trust classifications

| Classification | Meaning                                                             | `canCompare` | `canGate` |
| -------------- | ------------------------------------------------------------------- | ------------ | --------- |
| `trusted`      | Complete analysis, sufficient coverage, fully-comparable            | true         | true      |
| `directional`  | Scores are directionally correct but not reliable enough for gating | varies       | false     |
| `abstained`    | No usable scores — analysis could not complete                      | false        | false     |

### Computation rules

1. **Abstained** when `status` is `degraded`, `invalid-input`, or `unsupported-package`.
2. **Directional** when any of: `scoreValidity` is `not-comparable` or `partially-comparable`, entrypoint strategy is `fallback-glob`, coverage is `undersampled`, or graph used fallback glob. `canCompare` is false when `scoreValidity` is `not-comparable`.
3. **Trusted** otherwise — complete analysis with adequate coverage.

### Contract guarantees

- `canGate: true` implies `canCompare: true`. The reverse is not guaranteed.
- `--min-score` rejects `abstained` and `not-comparable` results with a contract-specific error before evaluating the score threshold.
- All three classifications include a `reasons` array with human-readable explanations.

### TrustSummary type

```typescript
type TrustClassification = "trusted" | "directional" | "abstained";

interface TrustSummary {
  classification: TrustClassification;
  canCompare: boolean;
  canGate: boolean;
  reasons: string[];
}
```

## Resolution diagnostics contract

Every `AnalysisResult` carries a `resolutionDiagnostics` field that traces the package acquisition and resolution pipeline. This provides observability into how the analysis reached its final state.

### ResolutionDiagnostics type

```typescript
type AcquisitionStage =
  | "spec-resolution"
  | "package-install"
  | "companion-types-resolution"
  | "declaration-entrypoint-resolution"
  | "graph-build"
  | "fallback-selection"
  | "complete";

interface ResolutionDiagnostics {
  acquisitionStage: AcquisitionStage;
  chosenStrategy: string;
  attemptedStrategies: string[];
  declarationCount: number;
  failureStage?: AcquisitionStage;
  failureReason?: string;
}
```

### Fields

| Field                 | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `acquisitionStage`    | The stage the pipeline reached (or stopped at)         |
| `chosenStrategy`      | The resolution strategy that produced the final result |
| `attemptedStrategies` | All strategies tried during resolution, in order       |
| `declarationCount`    | Number of `.d.ts` files found                          |
| `failureStage`        | Stage where failure occurred, if any                   |
| `failureReason`       | Error message from the failure stage, if any           |

For degraded results, `acquisitionStage` is inferred from the `degradedCategory` (e.g., `install-failure` maps to `"package-install"`). For successful analyses, `acquisitionStage` is `"complete"`.

## Zero-file behavior

When no source files are found: all composites get `score: null`, grade `N/A`, and the result is marked `status: "degraded"` with `degradedCategory: "missing-declarations"`. This prevents degraded results from masquerading as real zero scores.
