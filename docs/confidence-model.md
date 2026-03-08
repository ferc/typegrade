# Confidence Model

tsguard attaches confidence values to scores, indicating how much evidence supports each measurement.

## Dimension Confidence

Each dimension emits a confidence value (0–1) based on evidence quality:

| Dimension | Confidence Source | Formula |
|-----------|-------------------|---------|
| apiSpecificity | Sample coverage | `min(1, sampleCount / 20)` |
| semanticLift | Sample coverage | `min(1, totalPositions / 20)` |
| publishQuality | Metadata availability | 1.0 if package.json resolved, 0.7 otherwise |
| Other dimensions | Default | 0.8 |

## Confidence Signals

Dimensions that emit confidence also provide structured `confidenceSignals`:

```typescript
interface ConfidenceSignal {
  source: string;   // e.g., "sample-coverage", "metadata-availability"
  value: number;    // 0–1
  reason: string;   // Human-readable explanation
}
```

Example:
```json
{
  "confidenceSignals": [
    {
      "source": "sample-coverage",
      "value": 0.7,
      "reason": "14 positions analyzed (20 = full confidence)"
    }
  ]
}
```

## Composite Confidence

Composite confidence uses **minimum-signal logic**:

```
composite.confidence = min(dimension.confidence for each contributing dimension)
```

**Rationale:** A composite score is only as reliable as its weakest input. If one dimension has low confidence (e.g., only 3 positions analyzed), the entire composite's confidence should reflect that uncertainty.

When no confidence is explicitly set on a dimension, **0.8** is used as the default.

### Examples

- 2 dimensions with confidence 1.0 and 0.5 → composite confidence = 0.5
- 2 dimensions with no explicit confidence → composite confidence = 0.8
- 1 dimension with confidence 0.3 → composite confidence = 0.3
- 0 contributing dimensions → confidence is undefined

## Interpreting Confidence

| Confidence | Interpretation |
|------------|---------------|
| ≥ 0.8 | High — sufficient evidence for reliable scoring |
| 0.5–0.8 | Moderate — score is directionally correct but may shift with more data |
| < 0.5 | Low — score should be treated as indicative only |

## Confidence in JSON Output

Confidence appears on both dimensions and composites:

```json
{
  "composites": [
    {
      "key": "consumerApi",
      "score": 72,
      "grade": "B",
      "confidence": 0.7
    }
  ],
  "dimensions": [
    {
      "key": "apiSpecificity",
      "score": 68,
      "confidence": 0.7,
      "confidenceSignals": [...]
    }
  ]
}
```
