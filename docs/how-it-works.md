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

In source mode, a `sourceModeConfidence` object is computed with metrics specific to source analysis: source file coverage, declaration emit success, source-owned export coverage, ownership clarity, and fixability rate. See [Confidence Model: Source-mode confidence](confidence-model.md#source-mode-confidence) for details.

### Package mode (`typegrade score`)

Package mode analyzes published `.d.ts` declarations — what consumers and AI agents actually import.

1. Install or resolve the package (supports npm names, versioned names like `zod@3.24`, and local paths).
2. Build a **declaration graph** by resolving entrypoints and walking imports.
3. Extract the public surface from reachable declaration files.
4. Run the 8 consumer-facing analyzers. The 4 implementation dimensions are disabled.
5. Compute composites, domain scores, and scenario scores.

### Boundary-only fast path (`typegrade boundaries`)

The `boundaries` command uses a lightweight analysis path that skips the full scoring pipeline. Instead of loading the project with full type resolution, it uses a fast loader (`skipLoadingLibFiles`, `skipFileDependencyResolution`) and runs only the boundary graph, summary, and quality score computation. This makes it significantly faster than the general `analyze` command.

### CLI architecture

The CLI uses code splitting and lazy imports for fast startup:

- **`--version` / `-V`** exits immediately before loading any framework (prints the build-injected version constant).
- **`--help`** loads only `commander` and `picocolors` — no analyzer code.
- **Command handlers** dynamically import heavy modules (`analyzer.js`, `package-scorer.js`, `agent/index.js`, `fix/planner.js`, `diff.js`, `monorepo/index.js`) only when the specific command executes.
- **Build output** uses ESM code splitting (`tsup` with `splitting: true`) so each command's dependencies are separate chunks loaded on demand. Runtime dependencies (`commander`, `picocolors`, `ts-morph`) are externalized.

### Subpath imports

For library consumers who need only a subset of typegrade's functionality, subpath exports avoid loading the entire module graph:

- `typegrade/analyze` — `analyzeProject`, `analyzeBoundariesOnly`, `normalizeResult`
- `typegrade/score` — `scorePackage`, `comparePackages`
- `typegrade/boundaries` — boundary graph, summary, quality, flow, and policy functions
- `typegrade/fix` — `buildFixPlan`, `applyFixes`

The root import (`typegrade`) re-exports everything for compatibility.

## Result schema

### Status and validity

Every `AnalysisResult` carries two top-level discriminators:

- **`AnalysisStatus`**: `complete | degraded | invalid-input | unsupported-package` — whether the analysis ran to completion.
- **`ScoreValidity`**: `fully-comparable | partially-comparable | not-comparable` — whether the scores can be meaningfully compared to other results.

### Mandatory fields

The following fields are always present on every `AnalysisResult`, regardless of status:

- `analysisSchemaVersion` — semver string identifying the result schema.
- `status` — the `AnalysisStatus` value.
- `scoreValidity` — the `ScoreValidity` value.
- `globalScores` — structured global composite scores (Consumer API, Agent Readiness, Type Safety).
- `profileInfo` — resolved analysis profile and its signals.
- `packageIdentity` — resolved package name, version, and source metadata (`typesSource` and `entrypointStrategy` are always present).
- `confidenceSummary` — confidence across graph resolution, domain inference, sample coverage, and scenario applicability.
- `coverageDiagnostics` — reachable files, measured positions, undersampling flag, and types source.
- `evidenceSummary` — aggregate evidence counts (total declarations, positions, files, and coverage class).
- `trustSummary` — trust classification (`trusted`, `directional`, or `abstained`) with `canCompare`, `canGate`, and `reasons`. See [Confidence Model: Trust classification](confidence-model.md#trust-classification).
- `resolutionDiagnostics` — traces the acquisition pipeline stages, chosen strategy, attempted strategies, declaration count, and failure information. See [Scoring Contract: Resolution diagnostics contract](scoring-contract.md#resolution-diagnostics-contract).

### Degraded result semantics

When analysis cannot complete normally (e.g., declaration emit fails catastrophically, the package has no usable type surface, or install fails), `typegrade` returns a **degraded result** instead of fabricating zero scores:

- `status` is set to `"degraded"`.
- `scoreValidity` is set to `"not-comparable"`.
- `degradedReason` contains a human-readable explanation of why the analysis degraded.
- `degradedCategory` classifies the failure: `invalid-package-spec`, `unsupported-package-layout`, `missing-declarations`, `partial-graph-resolution`, `install-failure`, `insufficient-surface`, `confidence-collapse`, or `workspace-discovery-failure`.
- `degradedReasonChain` provides an ordered chain of reasons (most specific first) explaining the degradation path, including the primary reason, category, and specific failure mode.
- All composite scores are set to `null` (never fake zeros).
- `domainScore`, `scenarioScore`, `autofixSummary`, `fixPlan`, `boundaryQuality`, and `boundarySummary` are stripped entirely.
- `autofixAbstentionReason` explains why no fix batches were emitted.

Consumers should check `status` before comparing scores. Degraded results are excluded from ranking and gating by default.

Low-confidence results (average composite confidence < 0.5) also have `domainScore`, `scenarioScore`, `autofixSummary`, and `fixPlan` stripped, even when `status` is `"complete"`. When average confidence falls below 0.2, the result is auto-degraded with `degradedCategory: "confidence-collapse"`.

### Ownership classification

Every issue and dimension result can carry an `OwnershipClass` indicating who owns the code where the finding originates:

| Value | Meaning |
|-------|---------|
| `source-owned` | Code written and maintained in this project |
| `workspace-owned` | Code in a sibling workspace package within a monorepo |
| `dependency-owned` | Code originating from an external dependency |
| `generated` | Machine-generated code (codegen, build output) |
| `standard-library-owned` | TypeScript or platform standard library types |
| `mixed` | Finding spans both owned and external code |
| `unresolved` | Ownership could not be determined |

Ownership influences fix planning — `source-owned` and `workspace-owned` issues are directly actionable, while `dependency-owned` issues are flagged as `external` fixability.

## Package layout classification

Before building the declaration graph, `typegrade` classifies the package layout to determine the best analysis strategy and avoid unnecessary fallback/degraded results:

| Layout class | Conditions | Behavior |
|---|---|---|
| `standard` | Has type entries + 3 or more `.d.ts` files | Normal graph-based analysis |
| `declaration-sparse` | Has type entries but fewer than 3 `.d.ts` files | Normal analysis with compact-surface handling |
| `no-declarations` | Zero `.d.ts` files | Degraded result (`missing-declarations`) |
| `no-types-entry` | Has `.d.ts` files but no `types`/`typings`/`exports` entries | Falls back to analyzing all `.d.ts` files directly |
| `unsupported-bundler` | Package uses an unsupported bundler output format | Degraded result (`unsupported-package-layout`) |

This classification reduces false degraded results for packages that have usable type information but lack standard `package.json` type entries (e.g., older packages or unconventional layouts).

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

`typegrade` detects 12 library domains using a scored rule engine with five rule categories:

1. **Package name**: direct match against known library names (+0.6).
2. **Declaration shape**: pattern matching on exported names (route/handler/middleware for routers, model/schema/table for ORMs, etc.).
3. **Symbol role**: type alias detection (Result/Either/Ok/Err for result libraries).
4. **Generic structure**: generic parameter density analysis.
5. **Issue patterns**: domain-specific patterns in the analyzer output.

The winning domain must score >= 0.5. Otherwise, `typegrade` falls back to "utility" (if >50% type aliases) or "general".

**Supported domains**: validation, result, router, orm, schema, stream, frontend, state, testing, cli, utility, general.

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

## Trust summary

After all scoring, confidence capping, and validity checks are applied, `normalizeResult` computes a `TrustSummary` that distills the result into one of three trust classifications:

| Classification | Trigger conditions | Consumer guidance |
|---|---|---|
| `trusted` | Complete analysis, adequate coverage, `fully-comparable` validity | Safe for ranking, gating, and display |
| `directional` | Fallback glob, undersampled, `partially-comparable` or `not-comparable` validity | Scores are indicative but should not be used for gating |
| `abstained` | `degraded`, `invalid-input`, or `unsupported-package` status | No usable scores — do not compare or display |

The trust summary is computed late in the pipeline — after confidence caps, score validity assignment, domain/scenario suppression, and fix batch gating. This ensures it reflects the final state of the result.

See [Confidence Model: Trust classification](confidence-model.md#trust-classification) for the full classification logic and [Scoring Contract: Trust summary contract](scoring-contract.md#trust-summary-contract) for the type contract.

## Resolution diagnostics

Every analysis result includes `ResolutionDiagnostics` tracing the package acquisition pipeline. The pipeline proceeds through these stages in order:

1. **spec-resolution** — parse the package specifier (name, version, local path).
2. **package-install** — install the package to a temporary directory (package mode) or locate it locally (source mode).
3. **companion-types-resolution** — resolve `@types/*` companion packages when the main package lacks bundled types.
4. **declaration-entrypoint-resolution** — resolve `types`/`typings`/`exports` entries from `package.json`.
5. **graph-build** — build the declaration import graph by walking entrypoints.
6. **fallback-selection** — if entrypoint resolution fails, fall back to globbing all `.d.ts` files.
7. **complete** — pipeline finished successfully.

The `chosenStrategy` field records which strategy produced the final result (e.g., `"exports-types"`, `"typings-field"`, `"fallback-glob"`). The `attemptedStrategies` array records all strategies tried in order. For failed analyses, `failureStage` and `failureReason` identify where and why the pipeline stopped.

## Configuration file

`typegrade` supports project-level configuration via a `typegrade.config.ts` (or `.js` / `.mjs`) file in the project root. The config file is searched in priority order: `typegrade.config.ts`, `typegrade.config.js`, `typegrade.config.mjs`.

The default export should be a `TypegradeConfig` object:

```ts
import type { TypegradeConfig } from "typegrade";

export default {
  domain: "validation",
  profile: "library",
  minScore: 70,
  boundaries: {
    trustZones: [
      { name: "api-layer", paths: ["src/api/**"], trustLevel: "untrusted-external" },
      { name: "internal", paths: ["src/core/**"], trustLevel: "trusted-local" },
    ],
    policies: [
      { name: "require-fetch-validation", source: "network", requiresValidation: true, severity: "error" },
    ],
  },
  monorepo: {
    layers: { "@my/api": "app", "@my/core": "domain", "@my/db": "infra" },
    allowedDependencies: { app: ["domain", "shared"], domain: ["infra", "shared"], infra: ["shared"] },
  },
  suppressions: {
    budgets: { "trusted-local-tooling": 10 },
    protectedCategories: ["unsafe-cast"],
  },
} satisfies TypegradeConfig;
```

**Supported fields:**

| Field | Type | Description |
|-------|------|-------------|
| `domain` | `"auto" \| "off" \| DomainKey` | Override domain detection |
| `profile` | `AnalysisProfile` | Analysis profile (`library`, `package`, `application`, `autofix-agent`) |
| `boundaries` | `BoundaryPolicyConfig` | Trust zones and boundary validation policies |
| `monorepo` | `MonorepoConfig` | Package layer assignments and allowed dependencies |
| `suppressions` | `SuppressionOverrides` | Suppression budgets and protected categories |
| `minScore` | `number` | Minimum composite score for CI gate pass |

CLI options always take precedence over config file values. Undefined CLI options fall back to config values.

## Boundary flow analysis

In source mode, `typegrade` performs boundary flow analysis to detect where unvalidated external data enters the codebase and whether it is properly validated before use.

### Boundary detection

The analyzer scans source files for data ingress points — call expressions and property accesses that introduce external data:

| Boundary type | Examples |
|---------------|----------|
| `network` | `fetch()`, `axios.get()`, HTTP client calls |
| `filesystem` | `readFile()`, `readFileSync()` |
| `env` | `process.env.*` access |
| `config` | Config file reads |
| `serialization` | `JSON.parse()` |
| `IPC` | Inter-process communication |
| `UI-input` | User input from forms or DOM |
| `queue` | Message queue payloads |
| `database` | Database query results |
| `sdk` | Third-party SDK responses |

### Trust level classification

Each boundary is assigned a trust level based on the boundary type and file context:

- **`untrusted-external`** — Data from outside the system (network, user input). Always requires validation.
- **`semi-trusted-external`** — Data from partially controlled sources (config files, environment). Should be validated.
- **`trusted-local`** — Internal data (local function calls, generated files). Validation optional.
- **`generated-local`** — Machine-generated data. Validation optional.
- **`internal-only`** — Data that never crosses a process boundary.

### Taint tracking

For each detected boundary, the analyzer checks whether downstream validation exists within the same scope (up to 5 statements ahead). Validation is identified by the presence of known validation library calls (e.g., `parse`, `safeParse`, `validate`, `decode`, `z.object`, `t.type`).

Unvalidated boundaries at `untrusted-external` trust level produce **taint edges** — indicating data that flows from an untrusted source without passing through a validation sink.

### Taint provenance

Each taint flow chain carries a `provenance` field classifying the origin of the tainted data:

| Provenance | Description |
|---|---|
| `external-input` | Data originates from outside the system (network requests, user input) |
| `parsed-data` | Data produced by a deserialization step (`JSON.parse`, config parsing) |
| `cross-boundary` | Data flowing across a package or trust zone boundary |
| `internal` | Data from internal sources that crossed an unexpected boundary |

Provenance helps agents prioritize which taint flows are most critical. `external-input` and `cross-boundary` flows typically require immediate validation, while `internal` flows may be acceptable depending on context.

### Trust zones and policies

When configured via `typegrade.config.ts`, the boundary analyzer enforces **trust zones** — named regions of the codebase mapped to trust levels — and **policies** — rules requiring validation at specific boundary types.

Trust zone crossings (data flowing from a high-trust zone to a low-trust zone, or vice versa) are reported separately. Policy violations produce issues at the configured severity level.

### Boundary quality score

The boundary analysis produces a `BoundaryQualityScore` with:

- **Validation coverage**: proportion of boundaries with downstream validation (0-40 points).
- **Untrusted penalty**: -5 per unvalidated untrusted boundary (max -30).
- **Trusted-local bonus**: +2 per trusted-local suppression (max +10), indicating awareness.
- **Trust model accuracy**: 1 minus the ratio of missing validation hotspots.

The boundary report includes taint chains (with provenance), hotspots, trust zone crossings, policy violations, and finding categories (see [Scoring Contract: Boundary finding categories](scoring-contract.md#boundary-finding-categories)).

### Boundary hotspots

Unvalidated boundaries are ranked into **hotspots** using `computeBoundaryHotspots()`. Each hotspot carries a `riskScore` computed from boundary type weight and trust level:

- **Network + untrusted-external**: highest risk (weight 10 × trust multiplier 2.0)
- **Filesystem, database, queue + semi-trusted**: moderate risk
- **Env, config + trusted-local**: lower risk

Hotspots are sorted by descending risk score and attached to the `AnalysisResult` as `boundaryHotspots`. In boundary-only mode (`typegrade boundaries`), hotspots and recommended fixes are included in the JSON output.

### Boundary recommended fixes

Each hotspot maps to a **recommended fix** (`BoundaryRecommendedFix`) with a concrete `fix` description and `fixKind` (e.g., `add-validation`, `wrap-json-parse`, `add-env-parsing`) based on the boundary type.

### Recommendations (source mode)

In source and self-analysis modes, up to 3 **recommendations** are generated from the analysis results, grouped by category:

- **soundness** — from implementation issues (unsafe casts, missing narrowing)
- **boundary** — from unvalidated boundary hotspots
- **public-surface** — from exported API surface issues (weak types, missing annotations)

Each recommendation includes an `action`, `reason`, `impact` level (high/medium/low), and `category`. Recommendations are attached to the `AnalysisResult` as the `recommendations` field.

## Fix planning pipeline

The `self-analyze` command produces an **autofix summary** with actionable issues and fix batches for agent consumption. Actionable issues are capped at 50 (the agent issue budget, or 25 in strict/source mode), sorted by `agentPriority` descending with source-owned issues prioritized first. Degraded results with all-null composite scores emit an empty report with no fix batches.

### Agent report fields

The `AgentReport` includes:

- **`nextBestBatch`** — the highest-impact batch that is low or medium risk. High-risk batches are never auto-selected. Agents should apply this batch first.
- **`abortSignals`** — global abort conditions for the entire agent session (e.g., "Trust becomes abstained after applying fixes", "Score regresses by more than 5 points").
- **`reportTrust`** — the `TrustSummary` from the underlying analysis, so agents can check trust classification before proceeding.
- **`abstentionReason`** — explains why no fix batches were emitted (present when batches are empty due to degraded status, low confidence, or no actionable issues).

### Issue enrichment

Each issue is enriched with metadata for fix planning:

| Field | Description |
|-------|-------------|
| `rootCauseCategory` | Why the issue exists (e.g., `weak-type`, `unsafe-cast`, `boundary-leak`) |
| `suggestedFixKind` | Recommended fix approach (e.g., `add-type-annotation`, `replace-any`, `wrap-json-parse`) |
| `fixability` | How directly fixable: `direct`, `indirect`, `external`, `not_actionable` |
| `ownership` | Who owns the code: `source-owned`, `dependency-owned`, `generated`, etc. |
| `agentPriority` | Priority for agent consumption (0-100, higher = more important) |

### Fix batching

Issues are grouped into **fix batches** for sequential agent execution:

1. Group by file and dimension (issues in the same file for the same dimension are likely related).
2. Assign risk based on whether public API changes are needed (`high` if public API changes, `medium` for high-severity, `low` otherwise).
3. Order by expected impact (high confidence + high severity first), then by risk (ascending).
4. Flag batches requiring human review (public API changes, indirect fixes, high risk).

### Fix plan

The full `FixPlan` extends batches with:

- **Confidence** per batch (0-1) — how likely the fix is correct.
- **Expected score uplift** — predicted composite score improvement.
- **Verification plan** — typed verification commands (see below).
- **Rollback notes** — instructions for reverting if the fix causes regressions.
- **Dependency ordering** — `dependsOn` fields ensuring batches are applied in the correct sequence.

Safe fix categories (`add-explicit-return-type`, `replace-any-with-unknown`, `insert-satisfies`, `wrap-json-parse`, `add-env-parsing`, `narrow-overloads`, `hoist-validation`) can be applied automatically. All other fixes require human review.

### Agent fix batch enrichment

Enriched fix batches (`EnrichedFixBatch`) extend the base batch with agent-specific metadata:

- **`expectedDiffs`** — predicted code changes per file (`FixBatchDiff[]`), each with a `file`, `linesAffected`, and `changeDescription`. Helps agents preview impact before applying.
- **`rollbackRisk`** — a risk assessment with `level` (`trivial`, `safe`, `caution`, `dangerous`), `reason`, and flags for `affectsPublicApi` and `affectsTests`. Agents can use this to decide whether human review is needed.
- **`expectedScoreDelta`** — predicted composite score improvement from applying this batch.
- **`verificationCommands`** — shell commands to validate the fix after applying.
- **`goal`** — human-readable objective for the batch (e.g., "Resolve 3 apiSafety issue(s) to improve score by ~6 points").
- **`whyNow`** — urgency rationale based on batch risk level.
- **`patchHints`** — concrete code change hints mapped from `suggestedFixKind` values (e.g., "Replace `any` with `unknown` and add narrowing where the value is consumed").
- **`acceptanceChecks`** — typed acceptance criteria (`AcceptanceCheck[]`), each with a `command`, `expectedOutcome`, and `mustPass` flag.
- **`abortIf`** — abort conditions (`AbortCondition[]`) that should halt batch application (e.g., "TypeScript compilation fails after applying this batch").
- **`rollbackPlan`** — shell command to revert the batch's changes.

### Verification plan

The `VerificationPlan` provides typed verification commands for post-fix validation:

```typescript
interface VerificationPlan {
  commands: VerificationCommand[];
  expectedOutcome: string;
}

interface VerificationCommand {
  command: string;       // e.g. "tsc --noEmit"
  description: string;   // e.g. "Type-check without emitting"
  mustPass: boolean;      // Whether this command must succeed for the fix to be accepted
}
```

Commands with `mustPass: true` are mandatory gates — if they fail after applying a fix, the agent should roll back. Commands with `mustPass: false` are informational checks (e.g., running benchmarks).

### Source-mode issue ranking

In source and self analysis modes, issues receive priority boosts to surface the most actionable findings first:

| Signal | Priority boost |
|---|---|
| `source-owned` ownership | +20 |
| Exported-surface dimension (`apiSpecificity`, `semanticLift`) | +15 |
| Declaration-affecting fix kind (`add-type-annotation`, `replace-any`, `strengthen-generic`) | +10 |
| Directly fixable (`fixability: "direct"`) | +10 |

These boosts are additive. A source-owned issue on an exported-surface dimension with a direct fix receives up to +55 priority, ensuring it surfaces at the top of the agent's work queue.

### Module cluster batching

In source and self modes, fix batches cluster issues by **module directory** rather than individual file. This groups related issues across files in the same directory into a single batch, reducing context-switching for agents and encouraging holistic fixes. In package mode, batching groups by individual file as before.

## Monorepo and layering analysis

When a `monorepo` configuration is provided in `typegrade.config.ts`, `typegrade` performs layering analysis across packages.

### Layer assignments

Packages are assigned to layers: `app`, `domain`, `infra`, `ui`, `data`, `shared`, `tooling`.

### Dependency enforcement

The `allowedDependencies` map defines which layers may depend on which. For example:

```ts
allowedDependencies: {
  app: ["domain", "shared"],
  domain: ["infra", "shared"],
  infra: ["shared"],
}
```

Violations are classified as:

| Violation type | Description |
|---------------|-------------|
| `forbidden-cross-layer` | Import from a layer not in the allowed list |
| `infra-bypass` | App layer importing infra directly, bypassing domain |
| `unstable-leak` | Stable layer depending on an unstable layer |
| `trust-zone-crossing` | Data flow crossing trust zone boundaries |

The monorepo report includes `analysisSchemaVersion`, the package list with layers, all violations, the layer dependency graph, and an optional `MonorepoHealthSummary` with:

- `healthScore` — numeric score (0-100) reflecting overall monorepo layering health.
- `healthGrade` — letter grade derived from the health score.
- `totalViolations` — total count of layer violations across all packages.
- `violationsByType` — breakdown of violations by type (`forbidden-cross-layer`, `infra-bypass`, `unstable-leak`, `trust-zone-crossing`).

## Diff command

The `compare` command (`typegrade compare <pkgA> <pkgB>`) performs a side-by-side comparison of two packages. Both packages are scored independently, and the results are presented with deltas for each composite score.

Programmatically, the `comparePackages(pkgA, pkgB, options?)` function returns both `AnalysisResult` objects and an optional rendered text comparison.

The type system also supports a `DiffResult` for comparing two analysis runs of the same project (e.g., before and after a change). Each `DiffResult` carries `analysisSchemaVersion` for compatibility verification. A diff result includes:

- **Composite diffs**: delta for each composite score (`consumerApi`, `agentReadiness`, `typeSafety`).
- **Dimension diffs**: delta for each individual dimension score.
- **New issues**: issues present in the target but not the baseline.
- **Resolved issues**: issues present in the baseline but not the target.
- **Worsened issues**: issues present in both runs but with increased severity or score impact.
- **Confidence drift**: aggregate change in composite confidence between baseline and target.
- **Boundary coverage delta**: change in boundary validation coverage between the two runs.
- **Degraded rate increased**: flag indicating whether the target has more degraded dimensions than the baseline.
- **Summary**: human-readable summary of the changes.
