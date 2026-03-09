# typegrade JSON Field Reference

## Top-Level Fields

| Field | Type | Presence | Description |
|---|---|---|---|
| `analysisSchemaVersion` | `string` | Always | Schema version (e.g. `"0.11.0"`) |
| `status` | `AnalysisStatus` | Always | `'complete' \| 'degraded' \| 'invalid-input' \| 'unsupported-package'` |
| `scoreValidity` | `ScoreValidity` | Always | `'fully-comparable' \| 'partially-comparable' \| 'not-comparable'` |
| `degradedReason` | `string` | When degraded | Why the analysis is degraded |
| `mode` | `'source' \| 'package'` | Always | Analysis mode |
| `scoreProfile` | `string` | Always | `'source-project' \| 'published-declarations'` |
| `projectName` | `string` | Always | Project or package name |
| `filesAnalyzed` | `number` | Always | Number of declaration files analyzed |
| `timeMs` | `number` | Always | Analysis duration in milliseconds |
| `composites` | `CompositeScore[]` | Always | Three global composite scores |
| `globalScores` | `GlobalScores` | Always | Structured global scores (same data as composites) |
| `profileInfo` | `ProfileInfo` | Always | Detected profile with confidence |
| `packageIdentity` | `PackageIdentity` | Always | Package or project identity |
| `dimensions` | `DimensionResult[]` | Always | Per-dimension scores |
| `topIssues` | `Issue[]` | Always | Top issues sorted by fixability then severity |
| `domainScore` | `DomainScore` | When detected | Domain-adjusted score |
| `scenarioScore` | `ScenarioScore` | When applicable | Scenario benchmark score |
| `confidenceSummary` | `ConfidenceSummary` | When available | Confidence signals |
| `coverageDiagnostics` | `CoverageDiagnostics` | When available | Coverage and sampling info |
| `evidenceSummary` | `EvidenceSummary` | When available | Evidence strength breakdown |
| `graphStats` | `object` | Always | Declaration graph statistics |
| `boundaryQuality` | `BoundaryQualityScore` | Source mode | Boundary trust score |
| `boundarySummary` | `BoundarySummary` | Source mode | Boundary validation summary |
| `autofixSummary` | `AutofixSummary` | Agent mode | Autofix capability summary |

## CompositeScore

| Field | Type | Description |
|---|---|---|
| `key` | `'consumerApi' \| 'agentReadiness' \| 'typeSafety'` | Composite identifier |
| `score` | `number \| null` | Score 0-100, null if not computable |
| `grade` | `Grade` | Letter grade (A+, A, B, C, D, F) |
| `confidence` | `number` | Confidence 0-1 |

## GlobalScores

| Field | Type | Description |
|---|---|---|
| `consumerApi` | `CompositeScore` | Consumer API composite |
| `agentReadiness` | `CompositeScore` | Agent Readiness composite |
| `typeSafety` | `CompositeScore` | Type Safety composite |

## ProfileInfo

| Field | Type | Description |
|---|---|---|
| `profile` | `string` | `'library' \| 'application' \| 'autofix-agent'` |
| `profileConfidence` | `number` | Detection confidence (0-1) |
| `profileReasons` | `string[]` | Signals that led to profile detection |

## DimensionResult

| Field | Type | Description |
|---|---|---|
| `key` | `string` | Dimension identifier |
| `score` | `number` | Score 0-100 |
| `confidence` | `number` | Confidence 0-1 |
| `applicability` | `Applicability` | `'applicable' \| 'not_applicable' \| 'insufficient_evidence'` |
| `metrics` | `object` | Dimension-specific metric details |
| `issues` | `Issue[]` | Issues found for this dimension |

## DomainScore

| Field | Type | Description |
|---|---|---|
| `domain` | `string` | Detected or overridden domain |
| `score` | `number` | Domain-adjusted score 0-100 |
| `grade` | `Grade` | Letter grade |
| `confidence` | `number` | Domain inference confidence |

## ScenarioScore

| Field | Type | Description |
|---|---|---|
| `scenario` | `string` | Scenario pack name |
| `score` | `number` | Scenario benchmark score 0-100 |
| `passedScenarios` | `number` | Number of passed scenario tests |
| `totalScenarios` | `number` | Total scenario tests in pack |

## ConfidenceSummary

| Field | Type | Description |
|---|---|---|
| `graphResolution` | `number` | Declaration graph resolution quality (0-1) |
| `domainInference` | `number` | Domain detection confidence (0-1) |
| `sampleCoverage` | `number` | Surface sampling coverage (0-1) |
| `scenarioApplicability` | `number` | Scenario pack fit (0-1) |

## CoverageDiagnostics

| Field | Type | Description |
|---|---|---|
| `typesSource` | `string` | `'bundled' \| '@types' \| 'mixed' \| 'unknown'` |
| `reachableFiles` | `number` | Number of reachable declaration files |
| `measuredPositions` | `number` | Type positions measured |
| `undersampled` | `boolean` | True if too few declarations for reliable scoring |

## EvidenceSummary

| Field | Type | Description |
|---|---|---|
| `exportCoverage` | `number` | Fraction of exports measured |
| `coreSurfaceCoverage` | `number` | Core surface coverage |
| `specializationEvidence` | `number` | Specialization evidence level (0-1) |
| `domainEvidence` | `number` | Domain evidence level (0-1) |
| `scenarioEvidence` | `number` | Scenario evidence level (0-1) |

## PackageIdentity

| Field | Type | Description |
|---|---|---|
| `displayName` | `string` | Human-readable package name |
| `resolvedSpec` | `string` | Resolved npm specifier |
| `resolvedVersion` | `string \| null` | Resolved semver version (null for source mode) |
| `typesSource` | `string` | `'bundled' \| '@types' \| 'mixed' \| 'unknown'` (optional) |
| `moduleKind` | `string` | `'esm' \| 'cjs' \| 'dual' \| 'unknown'` (optional) |
| `entrypointStrategy` | `string` | How entrypoints were resolved (optional) |

## Dimension Keys

### Consumer dimensions (package + source mode)

| Key | Description |
|---|---|
| `specificity` | Narrowness of types — literals, branded, discriminated unions |
| `surfaceComplexity` | API surface complexity and discoverability |
| `semanticLift` | Meaningful type names and semantic type patterns |
| `specializationPower` | Domain-specific type features (generics, conditional types) |
| `apiSpecificity` | Function signature precision (params, returns, overloads) |
| `agentUsability` | AI agent navigability (discriminants, doc comments) |
| `publishQuality` | Declaration file quality and export hygiene |
| `typeExportHealth` | Re-export cleanliness, re-usable type surface |

### Implementation dimensions (source mode only)

| Key | Description |
|---|---|
| `soundness` | Absence of `any`, `@ts-ignore`, unsafe casts |
| `boundaryDiscipline` | I/O boundary validation quality |
| `configDiscipline` | TypeScript config strictness |
| `declarationFidelity` | Source-to-declaration alignment |

## FixPlan (from `typegrade fix-plan --json`)

| Field | Type | Description |
|---|---|---|
| `batches` | `FixPlanBatch[]` | Ordered fix batches with dependencies |
| `totalExpectedUplift` | `number` | Total expected score improvement |
| `analysisSchemaVersion` | `string` | Schema version for compatibility (e.g. `"0.11.0"`) |
| `verificationCommands` | `string[]` | Commands to verify fixes |

## FixPlanBatch

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Batch identifier |
| `title` | `string` | Human-readable batch title |
| `risk` | `'low' \| 'medium' \| 'high'` | Risk level |
| `fixCategory` | `string` | Category of fix (e.g. 'return-types', 'literal-unions') |
| `confidence` | `number` | Confidence that fix is correct (0-1) |
| `expectedScoreUplift` | `number` | Expected score improvement |
| `targetFiles` | `string[]` | Files to modify |
| `dependsOn` | `string[]` | IDs of batches that must be applied first |

## DiffResult (from `typegrade diff --json`)

| Field | Type | Description |
|---|---|---|
| `baseline` | `AnalysisResult` | Baseline analysis result |
| `target` | `AnalysisResult` | Target analysis result |
| `compositeDiffs` | `CompositeDiff[]` | Per-composite score deltas |
| `dimensionDiffs` | `DimensionDiff[]` | Per-dimension score deltas |

## BoundaryQualityScore (from `typegrade boundaries --json`)

| Field | Type | Description |
|---|---|---|
| `score` | `number` | Boundary quality score 0-100 |
| `grade` | `Grade` | Letter grade |
| `rationale` | `string[]` | Scoring rationale |

## BoundarySummary

| Field | Type | Description |
|---|---|---|
| `totalBoundaries` | `number` | Total I/O boundaries found |
| `validatedBoundaries` | `number` | Boundaries with validation |
| `unvalidatedBoundaries` | `number` | Boundaries without validation |
| `boundaryCoverage` | `number` | Fraction with validation (0-1) |
| `missingValidationHotspots` | `BoundaryHotspot[]` | Unvalidated boundaries by severity |
| `taintBreaks` | `object[]` | Unvalidated data flow chains |
