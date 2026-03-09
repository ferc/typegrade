---
name: quality-gate
description: >
  Use typegrade as a CI quality gate with --min-score. Exits with code 1 when
  Agent Readiness drops below the threshold. Covers CI integration patterns,
  JSON output parsing for CI, handling low-confidence and undersampled results,
  and avoiding false failures. Use when adding typegrade to a CI pipeline.
type: core
library: typegrade
library_version: "0.13.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:src/cli.ts"
---

# typegrade — CI Quality Gate

Use `--min-score` to fail CI when type quality drops below a threshold.
The gate checks the **Agent Readiness** composite score. Results classified
as **abstained** (via the trust contract) are rejected automatically --
`--min-score` exits with code 1 before evaluating the score.

## Setup

```yaml
# GitHub Actions example
- name: Type quality gate
  run: npx typegrade analyze . --min-score 70
```

Exits with code 1 if Agent Readiness < 70. Exits with code 0 otherwise.

## Core Patterns

### Basic CI gate for a library

```yaml
jobs:
  type-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx typegrade analyze . --min-score 70
```

### Gate with JSON output for downstream consumption

```yaml
- name: Score and gate
  run: |
    npx typegrade analyze . --json > typegrade-report.json
    SCORE=$(jq -r '.globalScores.agentReadiness.score' typegrade-report.json)
    if [ "$SCORE" -lt 70 ]; then
      echo "Agent Readiness score $SCORE is below threshold 70"
      exit 1
    fi
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: typegrade-report
    path: typegrade-report.json
```

This captures the full report as a CI artifact regardless of pass/fail.

### Gate for a published package (pre-release check)

```yaml
- name: Pre-release type quality check
  run: |
    npm pack
    npx typegrade score ./typegrade-*.tgz --min-score 65
```

Scores the tarball as a consumer would see it (package mode, 8 dimensions).

### Trust-aware gate

```bash
#!/bin/bash
RESULT=$(npx typegrade analyze . --json)
TRUST=$(echo "$RESULT" | jq -r '.trustSummary.classification // "unknown"')
CAN_GATE=$(echo "$RESULT" | jq -r '.trustSummary.canGate // false')
SCORE=$(echo "$RESULT" | jq -r '.globalScores.agentReadiness.score')

if [ "$TRUST" = "abstained" ]; then
  echo "Result is abstained — cannot gate"
  exit 1
fi

if [ "$CAN_GATE" != "true" ]; then
  echo "Warning: trust=$TRUST, canGate=false — skipping gate"
  exit 0
fi

if [ "$SCORE" -lt 70 ]; then
  echo "Agent Readiness $SCORE < 70"
  exit 1
fi
```

When using `--min-score` directly, abstained results are rejected
automatically. For custom JSON-based gates, check `trustSummary.canGate`
to decide whether the result is reliable enough to gate on.

### Confidence-aware gate

```bash
#!/bin/bash
RESULT=$(npx typegrade analyze . --json)
STATUS=$(echo "$RESULT" | jq -r '.status')
SCORE=$(echo "$RESULT" | jq -r '.globalScores.agentReadiness.score')
COVERAGE=$(echo "$RESULT" | jq -r '.confidenceSummary.sampleCoverage // 0')
UNDERSAMPLED=$(echo "$RESULT" | jq -r '.coverageDiagnostics.undersampled // false')

if [ "$STATUS" != "complete" ]; then
  echo "Warning: analysis status is $STATUS, skipping gate"
  exit 0
fi

if [ "$UNDERSAMPLED" = "true" ]; then
  echo "Warning: undersampled project, score $SCORE is unreliable"
  exit 0  # Do not block on unreliable scores
fi

if [ "$(echo "$COVERAGE < 0.5" | bc)" -eq 1 ]; then
  echo "Warning: low coverage ($COVERAGE), score $SCORE is indicative only"
  exit 0
fi

if [ "$SCORE" -lt 70 ]; then
  echo "Agent Readiness $SCORE < 70"
  exit 1
fi
```

### Application profile gate

```yaml
- run: npx typegrade analyze . --profile application --min-score 60
```

Use `--profile application` for non-library projects. Application scoring
downweights publishQuality and boosts boundary and config discipline.

## Common Mistakes

### HIGH — Gating on undersampled projects without confidence checks

Wrong:

```yaml
- run: npx typegrade analyze . --min-score 75
# Fails on a project with 3 exported functions — score capped at 65
```

Correct:

```yaml
- run: |
    RESULT=$(npx typegrade analyze . --json)
    STATUS=$(echo "$RESULT" | jq -r '.status')
    if [ "$STATUS" = "degraded" ]; then
      echo "Degraded analysis — skipping gate"
      exit 0
    fi
    UNDERSAMPLED=$(echo "$RESULT" | jq -r '.coverageDiagnostics.undersampled // false')
    if [ "$UNDERSAMPLED" = "true" ]; then
      echo "Undersampled — skipping gate"
      exit 0
    fi
    SCORE=$(echo "$RESULT" | jq -r '.globalScores.agentReadiness.score')
    [ "$SCORE" -ge 70 ] || exit 1
```

Undersampled projects have scores capped at 65. A `--min-score 75` gate
would always fail regardless of actual type quality.

### MEDIUM — Setting the threshold too high initially

Wrong:

```yaml
- run: npx typegrade analyze . --min-score 90
# Most real projects score 55-80. This blocks everything.
```

Correct:

```yaml
# Start with a baseline check, then ratchet up
- run: npx typegrade analyze . --min-score 60
# After improvements, raise to 70
```

Start with `--min-score 55` or `60` and increase the threshold as the
project improves. Scores above 85 require elite type discipline.

### HIGH — Using domain/scenario data from degraded or low-confidence results

Wrong:

```typescript
const result = JSON.parse(execSync("npx typegrade score pkg --json").toString());
if (result.domainScore?.score < 50) {
  throw new Error("Domain quality too low");
}
```

Correct:

```typescript
const result = JSON.parse(execSync("npx typegrade score pkg --json").toString());
// Degraded results have domainScore stripped (undefined)
// Low-confidence results (< 0.5) also strip domainScore
if (result.domainScore) {
  // Only present on complete, sufficiently-confident results
  if (result.domainScore.score < 50) {
    throw new Error("Domain quality too low");
  }
}
```

Degraded results and results with overall confidence below 0.5 have
`domainScore`, `scenarioScore`, `autofixSummary`, and `fixPlan` stripped
entirely. Gate logic that depends on these fields must handle `undefined`.

### MEDIUM — Not capturing the report on failure

Wrong:

```yaml
- run: npx typegrade analyze . --min-score 70
# CI fails but no artifact to diagnose why
```

Correct:

```yaml
- run: npx typegrade analyze . --json > typegrade-report.json --min-score 70
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: typegrade-report
    path: typegrade-report.json
```

Always upload the full JSON report as an artifact so developers can
diagnose score regressions without re-running locally.
