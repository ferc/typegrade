# typegrade JSON Field Reference

## Top-Level Fields

| Field | Type | Presence | Description |
|---|---|---|---|
| `mode` | `'source' \| 'package'` | Always | Analysis mode |
| `scoreProfile` | `string` | Always | Score profile used |
| `projectName` | `string` | Always | Project or package name |
| `filesAnalyzed` | `number` | Always | Number of declaration files analyzed |
| `timeMs` | `number` | Always | Analysis duration in milliseconds |
| `composites` | `CompositeScore[]` | Always | Three global composite scores |
| `domainScore` | `DomainScore` | When detected | Domain-adjusted score |
| `scenarioScore` | `ScenarioScore` | When applicable | Scenario benchmark score |
| `confidenceSummary` | `ConfidenceSummary` | Always | Confidence signals |
| `coverageDiagnostics` | `CoverageDiagnostics` | Always | Coverage and sampling info |
| `dimensions` | `DimensionResult[]` | Always | Per-dimension scores |
| `topIssues` | `Issue[]` | Always | Top issues by severity |
| `packageIdentity` | `PackageIdentity` | Package mode | Package resolution details |
| `evidenceSummary` | `EvidenceSummary` | Always | Evidence strength breakdown |
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
| `typesSource` | `string` | `'bundled' \| 'definitelyTyped' \| 'source'` |
| `reachableFiles` | `number` | Number of reachable declaration files |
| `measuredPositions` | `number` | Type positions measured |
| `undersampled` | `boolean` | True if too few declarations for reliable scoring |

## EvidenceSummary

| Field | Type | Description |
|---|---|---|
| `exportCoverage` | `number` | Fraction of exports measured |
| `coreSurfaceCoverage` | `number` | Core surface coverage |
| `specializationEvidence` | `string` | Specialization evidence level |
| `domainEvidence` | `string` | Domain evidence level |
| `scenarioEvidence` | `string` | Scenario evidence level |

## PackageIdentity

| Field | Type | Description |
|---|---|---|
| `displayName` | `string` | Human-readable package name |
| `resolvedSpec` | `string` | Resolved npm specifier |
| `resolvedVersion` | `string` | Resolved semver version |

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
| `analysisSchemaVersion` | `number` | Schema version for compatibility |
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
