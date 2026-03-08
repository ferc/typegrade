# How It Works

This document is the main technical walkthrough for `typegrade`. It covers both analysis modes, the declaration graph, public surface extraction, all analyzers, the three-layer scoring model, domain inference, and scenario packs.

## Two analysis modes

### Source mode (`typegrade analyze`)

Source mode analyzes your TypeScript source files directly. All 12 dimensions contribute.

1. Load the project via `ts-morph` from the given path.
2. Emit declarations in-memory (`project.emitToMemory({ emitOnlyDtsFiles: true })`) to build a **consumer view** — what downstream consumers would see after publishing.
3. Extract the public surface from the emitted `.d.ts` files.
4. Run all 8 consumer-facing analyzers against the consumer view.
5. Run all 4 implementation analyzers against the original source files.
6. Compute composites, domain scores, and scenario scores.

If declaration emit fails, source mode falls back to analyzing raw source files for the consumer dimensions, with all confidences capped at 0.6.

### Package mode (`typegrade score`)

Package mode analyzes published `.d.ts` declarations — what consumers and AI agents actually import.

1. Install or resolve the package (supports npm names, versioned names like `zod@3.24`, and local paths).
2. Build a **declaration graph** by resolving entrypoints and walking imports.
3. Extract the public surface from reachable declaration files.
4. Run the 8 consumer-facing analyzers. The 4 implementation dimensions are disabled.
5. Compute composites, domain scores, and scenario scores.

## Declaration graph engine

In package mode, `typegrade` does not analyze every `.d.ts` file in a package. Instead, it builds a declaration import graph to score only what consumers can actually reach:

1. **Resolve entrypoints** from `package.json` fields: `types`, `typings`, and conditional `exports` entries.
2. **Walk imports** via BFS, following `import`/`export` statements and `/// <reference path>` directives.
3. **Deduplicate** to avoid double-counting:
   - ESM/CJS twins (`.d.ts` vs `.d.mts`/`.d.cts`)
   - Symbol-identical files
   - Same-subpath condition variants
4. **Sibling `@types/*` resolution** — when a package doesn't bundle its own types, `typegrade` looks for the corresponding `@types/*` package.

If entrypoint resolution fails entirely, the engine falls back to a glob of all `.d.ts` files in the package root, with confidence capped at 0.55.

## Public surface extraction

All consumer-facing analyzers share a single `PublicSurface` extraction, eliminating duplicate traversal. The surface sampler walks the declaration files and collects:

- **Declarations**: every exported function, class, interface, type alias, enum, and variable.
- **Positions**: every type position within those declarations — parameters, return types, properties, generic constraints, index signatures.
- **Stats**: totals for declarations, positions, and type categories.

A **derived index** is also computed once, providing precomputed aggregates (role counts, feature densities, naming patterns) used by multiple analyzers.

## Analyzers

### Consumer-facing dimensions (8)

These analyze the public API surface — what downstream consumers and AI agents see.

| Dimension | Key | What it measures |
|---|---|---|
| **API Specificity** | `apiSpecificity` | How narrow and specific are exported types? Per-position feature-model scoring with 16 feature bonuses and relation-aware signals. |
| **API Safety** | `apiSafety` | How much `any` and `unknown` leaks into the public API? Domain-aware: suppresses false positives for validation libraries. |
| **Semantic Lift** | `semanticLift` | How much do advanced type features lift your API above a widened baseline? Dual-baseline model: lift must exceed both an erased baseline and an instantiation baseline. |
| **Specialization Power** | `specializationPower` | How well does the API specialize — key-preserving transforms, path-param inference, decode/parse output narrowing, channel propagation? |
| **Publish Quality** | `publishQuality` | Do exported functions have explicit return types, typed parameters, JSDoc, and proper entrypoint clarity? |
| **Surface Consistency** | `surfaceConsistency` | Is the API consistent? Checks overload ordering, return type explicitness, naming conventions, nullability patterns, generic naming, result shape consistency. |
| **Surface Complexity** | `surfaceComplexity` | Is the API approachable? Penalizes deep nesting, wide unions, overload explosion, declaration sprawl, non-conventional generics. |
| **Agent Usability** | `agentUsability` | Is the API AI-agent-friendly? Checks named exports, discriminated errors, correlated generics, overload clarity, parameter-to-result predictability, inference stability. |

### Implementation dimensions (4, source mode only)

These analyze your source code directly and are disabled in package mode.

| Dimension | Key | What it measures |
|---|---|---|
| **Declaration Fidelity** | `declarationFidelity` | Do emitted `.d.ts` declarations preserve the source types, generic parameters, and constraints? |
| **Soundness** | `implementationSoundness` | Type assertions (`as any`, `as unknown as X`), non-null assertions, `@ts-ignore` usage. |
| **Boundary Discipline** | `boundaryDiscipline` | Runtime validation at I/O boundaries (JSON.parse, fetch, file reads). |
| **Config Discipline** | `configDiscipline` | TypeScript strict mode flags (`strictNullChecks`, `noUncheckedIndexedAccess`, etc.). |

## Three-layer scoring model

### Layer 1: Global scores

Three composites computed from weighted dimension averages. **Comparable across all libraries.**

- **Consumer API** — weighted average of the 8 consumer dimensions (or all 12 in source mode where applicable).
- **Agent Readiness** — weighted average emphasizing agent usability, specialization power, and API specificity.
- **Type Safety** — weighted average emphasizing API safety, with smaller contributions from implementation dimensions in source mode.

See [Scoring Contract](scoring-contract.md) for exact weights.

### Layer 2: Domain-fit scores

When `typegrade` detects a known domain with sufficient confidence (>= 0.70, with >= 0.15 gap over runner-up), it computes a **domain-adjusted score** using domain-specific weight multipliers.

Example: for a router library, `apiSpecificity` and `specializationPower` get boosted weights because path-param inference and route narrowing are the core router value. `surfaceComplexity` gets a reduced weight because complex generic signatures are expected.

**Only comparable within the same domain.** A router's domain score and a validation library's domain score are not directly comparable.

### Layer 3: Scenario scores

Domain-specific consumer benchmark tests that measure real downstream DX. Each scenario pack defines concrete checks that a library in that domain should pass:

- **Router**: path-param inference, search-param inference, loader result propagation, route narrowing, nested route context, link target correctness.
- **Validation**: unknown-to-validated output, refinement pipelines, discriminated schema composition, parse/guard ergonomics.
- **ORM**: schema-to-query inference, join precision, selected-column narrowing.
- **Result/Effect**: error channel propagation, map/flatMap/match precision, async composition.
- **Schema/Utility**: key-preserving transforms, deep recursive transforms, alias readability.
- **Stream**: pipe/operator inference, value/error channel propagation, composition patterns.

**Only comparable within the same scenario pack.**

## Domain inference

`typegrade` detects 9 library domains using a scored rule engine with five rule categories:

1. **Package name**: direct match against known library names (+0.6).
2. **Declaration shape**: pattern matching on exported names (route/handler/middleware for routers, model/schema/table for ORMs, etc.).
3. **Symbol role**: type alias detection (Result/Either/Ok/Err for result libraries).
4. **Generic structure**: generic parameter density analysis.
5. **Issue patterns**: domain-specific patterns in the analyzer output.

The winning domain must score >= 0.5. Otherwise, `typegrade` falls back to "utility" (if >50% type aliases) or "general".

**Supported domains**: validation, result, router, orm, schema, stream, frontend, utility, general.

**Hard rule**: domain inference may suppress false-positive issues (e.g., `unknown` params in validation libraries) but may never directly increase a global score. Domain adjustments only affect the domain-fit score layer.

You can override domain detection with `--domain <domain>` or disable it with `--domain off`.

## Coverage and confidence

### Confidence

Every dimension carries a confidence value (0-1). Composite confidence uses a weighted formula:

```
composite.confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

See [Confidence Model](confidence-model.md) for details.

### Coverage diagnostics

In package mode, `typegrade` reports:
- **Reachable files**: how many declaration files were found via graph traversal.
- **Measured positions**: how many type positions were analyzed.
- **Undersampling**: whether the package has too few declarations for a reliable score.
- **Types source**: whether types are bundled, from `@types/*`, or mixed.

Undersampled packages get confidence caps based on severity (0.40 / 0.55 / 0.65 depending on how many undersampling reasons apply).
