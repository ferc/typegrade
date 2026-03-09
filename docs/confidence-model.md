# Confidence Model

`typegrade` attaches confidence values to scores, indicating how much evidence supports each measurement. This document is the canonical reference for how confidence is computed.

## Dimension confidence

Each dimension emits a confidence value (0-1) based on evidence quality:

| Dimension | Confidence source | Formula |
|---|---|---|
| apiSpecificity | Sample coverage | `min(1, sampleCount / 20)` |
| semanticLift | Sample coverage | `min(1, totalPositions / 20)` |
| publishQuality | Metadata availability | 1.0 if package.json resolved, 0.7 otherwise |
| Other dimensions | Default | 0.8 |

When no confidence is explicitly set on a dimension, **0.8** is used as the default.

## Composite confidence

Composite confidence uses a **weighted evidence score**:

```
composite.confidence = 0.6 * min(dimensionConfidences) + 0.4 * avg(dimensionConfidences)
```

The bottleneck dimension dominates (60% weight), but the average adds signal from well-sampled dimensions (40% weight).

Each composite also includes `compositeConfidenceReasons` — structured reasons explaining the confidence bottleneck and any notable gaps between dimensions.

### Examples

| Scenario | Calculation | Result |
|---|---|---|
| 2 dims with confidence 1.0 and 0.5 | 0.6 × 0.5 + 0.4 × 0.75 | 0.60 |
| 2 dims with no explicit confidence | 0.6 × 0.8 + 0.4 × 0.8 | 0.80 |
| 1 dim with confidence 0.3 | 0.6 × 0.3 + 0.4 × 0.3 | 0.30 |
| 0 contributing dimensions | — | undefined |

## Confidence caps

Several conditions cap dimension confidence to reflect reduced reliability:

### Source-mode fallback

When declaration emit fails in source mode and consumer analysis falls back to raw source files, all dimension confidences are capped at **0.6**.

Signal added:
```json
{ "source": "source-fallback", "value": 0.6, "reason": "Consumer analysis using raw source files instead of declarations" }
```

### Fallback glob

When the declaration graph engine cannot resolve entrypoints and falls back to globbing all `.d.ts` files, all confidences are capped at **0.55**.

Signal added:
```json
{ "source": "fallback-glob", "value": 0.55, "reason": "Graph resolution used fallback glob — confidence capped" }
```

### Undersampling

When a package has too few declarations for a reliable score, a severity-based confidence cap is applied:

| Severity | Conditions | Cap |
|---|---|---|
| Severe | 3+ undersampling reasons, or zero positions/declarations | 0.40 |
| Moderate | 2 undersampling reasons | 0.55 |
| Mild | 1 undersampling reason | 0.65 |

Undersampling is triggered when:
- Fewer than 3 reachable files from entrypoints
- Fewer than 10 measured type positions
- Fewer than 5 public declarations
- Graph resolution used fallback glob
- High dedup ratio leaving few files after deduplication
- High cross-package type refs with few reachable files (indicating incomplete `@types` traversal)

Signal added:
```json
{ "source": "undersampled", "value": 0.55, "reason": "Undersampled package — confidence capped (2 reason(s))" }
```

## Confidence signals

Dimensions that emit confidence also provide structured `confidenceSignals`:

```typescript
interface ConfidenceSignal {
  source: string;   // e.g. "sample-coverage", "metadata-availability", "source-fallback"
  value: number;    // 0-1
  reason: string;   // Human-readable explanation
}
```

## Score validity

The `scoreValidity` field reflects whether scores can be meaningfully compared to other results. It is set based on confidence and coverage signals:

| Value | When set | Meaning |
|---|---|---|
| `fully-comparable` | Complete analysis with adequate coverage | Scores are reliable and comparable |
| `partially-comparable` | Fallback glob resolution or low average confidence (<0.3) | Scores are directionally correct but may not rank accurately |
| `not-comparable` | Undersampled or degraded analysis | Scores should not be used for ranking or gating |

Key transitions:
- **Undersampled** analysis → `"not-comparable"` (insufficient evidence for any comparison).
- **Fallback glob** resolution → `"partially-comparable"` (some evidence, but entrypoint graph is unreliable).
- **Low average confidence** (<0.3 across all four summary axes) on an otherwise complete result → downgraded from `"fully-comparable"` to `"partially-comparable"`.
- **Low composite confidence** (<0.5 average across composites) → `domainScore`, `scenarioScore`, `autofixSummary`, and `fixPlan` are stripped from the result (set to `undefined`). These layers require sufficient evidence to be meaningful.

## Interpreting confidence

| Confidence | Interpretation |
|---|---|
| >= 0.8 | High — sufficient evidence for reliable scoring |
| 0.5-0.8 | Moderate — score is directionally correct but may shift with more data |
| < 0.5 | Low — score should be treated as indicative only; domain and scenario scores are suppressed |

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
        { "source": "sample-coverage", "value": 0.7, "reason": "14 positions analyzed (20 = full confidence)" }
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

| Field | Meaning |
|---|---|
| `graphResolution` | 0.95 for successful entrypoint traversal, 0.3 for fallback glob |
| `domainInference` | Domain detection confidence (0 = no domain detected) |
| `sampleCoverage` | Average dimension confidence across enabled dimensions |
| `scenarioApplicability` | 0.9 if scenario ran, 0.5 if domain detected but no pack, 0.1 otherwise |
