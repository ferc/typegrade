# Confidence Model

`typegrade` attaches confidence values to scores, indicating how much evidence supports each measurement. This document is the canonical reference for how confidence is computed.

## Dimension confidence

Each dimension emits a confidence value (0-1) based on evidence quality:

| Dimension        | Confidence source     | Formula                                     |
| ---------------- | --------------------- | ------------------------------------------- |
| apiSpecificity   | Sample coverage       | `min(1, sampleCount / 20)`                  |
| semanticLift     | Sample coverage       | `min(1, totalPositions / 20)`               |
| publishQuality   | Metadata availability | 1.0 if package.json resolved, 0.7 otherwise |
| Other dimensions | Default               | 0.8                                         |

When no confidence is explicitly set on a dimension, **0.8** is used as the default.

## Composite confidence

Composite confidence uses a **weighted evidence score**:

```
composite.confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

The bottleneck dimension dominates (60% weight), but the average adds signal from well-sampled dimensions (40% weight).

Each composite also includes `compositeConfidenceReasons` — structured reasons explaining the confidence bottleneck and any notable gaps between dimensions.

### Confidence bottlenecks

When dimensions have confidence below 0.5, the result includes `confidenceBottlenecks` — an array (up to 5, sorted worst-first) of actionable explanations:

```json
{
  "dimensionKey": "specializationPower",
  "dimensionLabel": "Specialization Power",
  "confidence": 0.3,
  "explanation": "Undersampled package — confidence capped (1 reason(s))",
  "improvementHint": "Add generic type parameters, conditional types, mapped types, or infer keywords"
}
```

Each bottleneck identifies the dragging dimension, explains why confidence is low (from `confidenceSignals`), and provides a concrete improvement hint specific to that dimension.

### Examples

| Scenario                           | Calculation            | Result    |
| ---------------------------------- | ---------------------- | --------- |
| 2 dims with confidence 1.0 and 0.5 | 0.6 × 0.5 + 0.4 × 0.75 | 0.60      |
| 2 dims with no explicit confidence | 0.6 × 0.8 + 0.4 × 0.8  | 0.80      |
| 1 dim with confidence 0.3          | 0.6 × 0.3 + 0.4 × 0.3  | 0.30      |
| 0 contributing dimensions          | —                      | undefined |

## Confidence caps

Several conditions cap dimension confidence to reflect reduced reliability:

### Source-mode fallback

When declaration emit fails in source mode and consumer analysis falls back to raw source files, all dimension confidences are capped at **0.6**. Additionally, `scoreValidity` is set to `"partially-comparable"`, which produces a `directional` trust classification — source fallback results cannot be `trusted`.

Signal added:

```json
{
  "source": "source-fallback",
  "value": 0.6,
  "reason": "Consumer analysis using raw source files instead of declarations"
}
```

### Fallback glob

When the declaration graph engine cannot resolve entrypoints and falls back to globbing all `.d.ts` files, all confidences are capped at **0.55**.

Signal added:

```json
{
  "source": "fallback-glob",
  "value": 0.55,
  "reason": "Graph resolution used fallback glob — confidence capped"
}
```

### Undersampling

When a package has too few declarations for a reliable score, a severity-based confidence cap is applied:

| Severity | Conditions                                               | Cap  |
| -------- | -------------------------------------------------------- | ---- |
| Severe   | 3+ undersampling reasons, or zero positions/declarations | 0.40 |
| Moderate | 2 undersampling reasons                                  | 0.55 |
| Mild     | 1 undersampling reason                                   | 0.65 |

Undersampling is triggered when:

- Fewer than 3 reachable files from entrypoints
- Fewer than 10 measured type positions
- Fewer than 5 public declarations
- Graph resolution used fallback glob
- High dedup ratio leaving few files after deduplication
- High cross-package type refs with few reachable files (indicating incomplete `@types` traversal)

Signal added:

```json
{
  "source": "undersampled",
  "value": 0.55,
  "reason": "Undersampled package — confidence capped (2 reason(s))"
}
```

## Confidence signals

Dimensions that emit confidence also provide structured `confidenceSignals`:

```typescript
interface ConfidenceSignal {
  source: string; // e.g. "sample-coverage", "metadata-availability", "source-fallback"
  value: number; // 0-1
  reason: string; // Human-readable explanation
}
```

## Score validity

The `scoreValidity` field reflects whether scores can be meaningfully compared to other results. It is set based on confidence and coverage signals:

| Value                  | When set                                                  | Meaning                                                      |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `fully-comparable`     | Complete analysis with adequate coverage                  | Scores are reliable and comparable                           |
| `partially-comparable` | Fallback glob resolution, source-mode fallback, or low average confidence (<0.3) | Scores are directionally correct but may not rank accurately |
| `not-comparable`       | Undersampled or degraded analysis                         | Scores should not be used for ranking or gating              |

Key transitions:

- **Undersampled** analysis → `"not-comparable"` (insufficient evidence for any comparison).
- **Fallback glob** resolution → `"partially-comparable"` (some evidence, but entrypoint graph is unreliable).
- **Source-mode fallback** (declaration emit failed) → `"partially-comparable"` (consumer analysis based on raw source files instead of emitted declarations).
- **Confidence collapse** (<0.2 average across all four summary axes) → entire result is degraded. All composite scores are nulled, domain/scenario/fix data are stripped, and `degradedCategory` is set to `"confidence-collapse"`. This prevents analyses with near-zero evidence from producing any authoritative-looking output.
- **Resource exhaustion** (worker OOM, analysis timeout) → result is degraded with `degradedCategory: "resource-exhaustion"`. Resource warnings are recorded in `executionDiagnostics.resourceWarnings`.
- **Low average confidence** (<0.3 across all four summary axes) on an otherwise complete result → downgraded from `"fully-comparable"` to `"partially-comparable"`.
- **Low average confidence** (<0.4) → fix batches are suppressed (emptied). `autofixAbstentionReason` explains why no fix batches were emitted.
- **Low composite confidence** (<0.5 average across composites) → `domainScore`, `scenarioScore`, `autofixSummary`, and `fixPlan` are stripped from the result (set to `undefined`). These layers require sufficient evidence to be meaningful.

## Source-mode confidence

When running in source or self mode, `typegrade` computes a `SourceModeConfidence` object attached to the result as `sourceModeConfidence`. This captures confidence metrics specific to source analysis that are not applicable in package mode.

| Field                       | Description                                                    | Formula                                   |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `sourceFileCoverage`        | Proportion of source files that were actually analyzed         | `min(1, filesAnalyzed / sourceFileCount)` |
| `declarationEmitSuccess`    | Whether declaration emit succeeded (1.0) or fell back (capped) | 1.0 on success, reduced on fallback       |
| `sourceOwnedExportCoverage` | Proportion of issues that are source-owned                     | `sourceOwnedIssues / totalIssues`         |
| `ownershipClarity`          | Proportion of issues with resolved ownership                   | `resolvedOwnership / totalIssues`         |
| `fixabilityRate`            | Proportion of issues that are directly fixable                 | `fixableIssues / totalIssues`             |

These metrics help agents assess whether a source analysis provides enough coverage and actionability to proceed with fixes. When all five fields are near 1.0, the source analysis is comprehensive and the resulting fix plan is highly actionable.

## Scenario applicability gating

Scenario packs are gated by multiple confidence signals before they run. The `ScenarioApplicabilityStatus` on each `ScenarioScore` indicates why a scenario was or was not evaluated:

| Status                  | When set                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `applicable`            | Domain confidence >= 0.5, graph resolution succeeded, domain ambiguity <= 0.7                       |
| `applicable_but_weak`   | Domain detected but ambiguity > 0.7 — scenario ran but results should be interpreted cautiously     |
| `insufficient_evidence` | Domain confidence < 0.5 or graph used fallback glob — not enough evidence to run scenarios reliably |
| `not_applicable`        | Domain confidence < 0.3 or domain scoring disabled — scenario evaluation skipped entirely           |

The gating conditions in order of precedence:

1. **Domain confidence < 0.3** or domain disabled: `not_applicable` — scenario is skipped.
2. **Domain confidence < 0.5** or fallback glob used: `insufficient_evidence` — scenario is skipped.
3. **Domain ambiguity > 0.7**: `applicable_but_weak` — scenario runs but with reduced trust.
4. Otherwise: `applicable` — scenario runs normally.

When a scenario is skipped, `scenarioAbstentionReason` explains the specific gate that blocked it.

## Multi-label domain confidence

Domain inference now computes a `multiLabelConfidence` value (0-1) on `DomainInference`, indicating how strongly a secondary domain applies alongside the primary domain. When the runner-up domain has confidence > 0.4, the multi-label confidence is computed as `min(1, secondaryConfidence / primaryConfidence)`. A high multi-label confidence (e.g., > 0.5) indicates the package spans multiple domains and domain-specific scoring should be interpreted with caution.

## Interpreting confidence

| Confidence | Interpretation                                                                              |
| ---------- | ------------------------------------------------------------------------------------------- |
| >= 0.8     | High — sufficient evidence for reliable scoring                                             |
| 0.5-0.8    | Moderate — score is directionally correct but may shift with more data                      |
| < 0.5      | Low — score should be treated as indicative only; domain and scenario scores are suppressed |

## Trust classification

The top-level `trustSummary` on every `AnalysisResult` distills confidence, coverage, and status signals into a single trust label. This replaces the need for consumers to manually interpret `scoreValidity`, `status`, and coverage fields.

### TrustClassification

| Classification | When assigned                                                                                                                            | `canCompare`        | `canGate` |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------- |
| `trusted`      | `status` is `complete`, coverage is adequate, `scoreValidity` is `fully-comparable`, all composite confidences >= 0.5                    | true                | true      |
| `directional`  | Fallback glob, undersampled, source fallback, `partially-comparable`/`not-comparable` validity, or any composite confidence < 0.5        | depends on validity | false     |
| `abstained`    | `status` is `degraded`, `invalid-input`, or `unsupported-package`                                                                        | false               | false     |

### Classification logic

The classification is computed in `normalizeResult` after all confidence caps and validity checks have been applied:

1. **Abstained**: if `status` is `degraded`, `invalid-input`, or `unsupported-package`, the result is abstained. The `reasons` array includes the status and any `degradedReason`.
2. **Directional** (coverage/validity signals): if any of these signals are present — `scoreValidity` is `not-comparable` or `partially-comparable`, entrypoint strategy is `fallback-glob`, coverage is undersampled, or graph used fallback glob — the result is directional. `canCompare` is true only if `scoreValidity` is not `not-comparable`. Note: source-mode fallback sets `scoreValidity` to `"partially-comparable"`, so source fallback results are always directional.
3. **Directional** (low composite confidence): if any global composite has confidence below 0.5 (and the result was not already classified by steps 1-2), the result is downgraded to directional with `canCompare: true` but `canGate: false`. This prevents results with technically complete analysis but insufficient per-composite evidence from being used for quality gates.
4. **Trusted**: complete analysis with sufficient coverage, `fully-comparable` scores, and all composite confidences >= 0.5. Both `canCompare` and `canGate` are true.

### TrustSummary fields

```typescript
interface TrustSummary {
  classification: "trusted" | "directional" | "abstained";
  canCompare: boolean; // Safe for ranking comparisons
  canGate: boolean; // Safe for --min-score quality gates
  reasons: string[]; // Human-readable explanation chain
}
```

### CLI behavior

In non-JSON mode, the CLI displays the trust label before results:

- **Trusted**: green label, no additional warnings.
- **Directional**: yellow label with the primary reason.
- **Abstained**: red label with the primary reason.

The `--min-score` flag rejects abstained results with a contract-specific error: "result is abstained ... cannot evaluate against min-score". It also rejects `not-comparable` results.

## Confidence in JSON output

Confidence appears on both dimensions and composites:

```json
{
  "composites": [
    {
      "key": "consumerApi",
      "score": 72,
      "grade": "B",
      "confidence": 0.7,
      "compositeConfidenceReasons": [
        "Bottleneck: API Specificity (confidence=0.7)",
        "Average dimension confidence (85%) higher than bottleneck"
      ]
    }
  ],
  "dimensions": [
    {
      "key": "apiSpecificity",
      "score": 68,
      "confidence": 0.7,
      "confidenceSignals": [
        {
          "source": "sample-coverage",
          "value": 0.7,
          "reason": "14 positions analyzed (20 = full confidence)"
        }
      ]
    }
  ]
}
```

## Confidence summary

The top-level `confidenceSummary` object provides a quick overview across all layers:

```json
{
  "confidenceSummary": {
    "graphResolution": 0.95,
    "domainInference": 0.9,
    "sampleCoverage": 0.82,
    "scenarioApplicability": 0.9
  }
}
```

| Field                   | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `graphResolution`       | 0.95 for successful entrypoint traversal, 0.3 for fallback glob        |
| `domainInference`       | Domain detection confidence (0 = no domain detected)                   |
| `sampleCoverage`        | Average dimension confidence across enabled dimensions                 |
| `scenarioApplicability` | 0.9 if scenario ran, 0.5 if domain detected but no pack, 0.1 otherwise |
