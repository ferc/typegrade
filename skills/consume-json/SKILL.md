---
name: consume-json
description: >
  Consume typegrade JSON output programmatically. Covers stable
  AnalysisResult fields, composite scores with confidence, dimension
  results, domain and scenario scores, coverage diagnostics, undersampling
  detection, and how to avoid acting on weak evidence. Use when building
  automation, dashboards, or agent workflows that ingest typegrade output.
type: core
library: typegrade
library_version: "0.10.0"
sources:
  - "ferc/typegrade:README.md"
  - "ferc/typegrade:src/types.ts"
  - "ferc/typegrade:src/index.ts"
  - "ferc/typegrade:docs/scoring-contract.md"
  - "ferc/typegrade:docs/confidence-model.md"
---

# typegrade — Consume JSON Output

Use `--json` on any typegrade command to get structured output suitable for
automation, dashboards, and agent workflows.

## Setup

```bash
npx typegrade analyze . --json
npx typegrade score zod --json
npx typegrade compare zod valibot --json
npx typegrade boundaries . --json
npx typegrade fix-plan . --json
npx typegrade apply-fixes . --json
npx typegrade diff lib@1.0 lib@2.0 --json
```

All commands produce JSON on stdout when `--json` is passed.

## AnalysisResult Structure

The JSON output is an `AnalysisResult` object. Here are the stable fields:

```typescript
interface AnalysisResult {
  // --- Mandatory envelope fields (always present) ---
  analysisSchemaVersion: string;   // e.g. "0.11.0"
  status: AnalysisStatus;         // 'complete' | 'degraded' | 'invalid-input' | 'unsupported-package'
  scoreValidity: ScoreValidity;   // 'fully-comparable' | 'partially-comparable' | 'not-comparable'
  degradedReason?: string;        // Present when status is 'degraded'

  mode: 'source' | 'package';
  scoreProfile: 'source-project' | 'published-declarations';
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;

  // --- Always-present structured fields ---
  composites: CompositeScore[];      // Three global composites
  globalScores: GlobalScores;        // Structured access to the same three composites
  profileInfo: ProfileInfo;          // Detected/overridden profile with confidence
  packageIdentity: PackageIdentity;  // Always present (both modes)
  dimensions: DimensionResult[];     // Per-dimension scores
  topIssues: Issue[];                // Top issues sorted by fixability then severity

  // --- Optional layer scores ---
  domainScore?: DomainScore;       // Present when domain detected or overridden
  scenarioScore?: ScenarioScore;   // Present when a scenario pack applies

  // --- Optional diagnostics ---
  confidenceSummary?: ConfidenceSummary;   // Confidence signals
  coverageDiagnostics?: CoverageDiagnostics; // Coverage and sampling info
  evidenceSummary?: EvidenceSummary;

  // --- Optional analysis extras ---
  boundaryQuality?: BoundaryQualityScore;  // Source mode
  boundarySummary?: BoundarySummary;        // Source mode
  autofixSummary?: AutofixSummary;          // Agent mode
}
```

### Key envelope fields

- **`status`**: `"complete"` means all dimensions scored normally. `"degraded"`
  means some dimensions could not be scored (e.g. install failure, missing
  types) — check `degradedReason` for details. Degraded results no longer
  emit fake zero scores; instead, affected dimensions are marked as
  inapplicable.
- **`scoreValidity`**: Tells you how comparable this result is to others.
  `"fully-comparable"` means all global composites are reliable.
  `"not-comparable"` means scores should not be used for cross-package ranking.
- **`analysisSchemaVersion`**: Use this to detect breaking output changes
  across typegrade versions.

### CompositeScore

```typescript
interface CompositeScore {
  key: 'consumerApi' | 'agentReadiness' | 'typeSafety';
  score: number;       // 0-100
  grade: Grade;        // 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
  confidence: number;  // 0-1
}
```

### GlobalScores

```typescript
interface GlobalScores {
  consumerApi: CompositeScore;
  agentReadiness: CompositeScore;
  typeSafety: CompositeScore;
}
```

Provides structured access to the three global composites without searching
the `composites` array. Equivalent to finding each key in `composites[]`.

### ProfileInfo

```typescript
interface ProfileInfo {
  profile: 'library' | 'application' | 'autofix-agent';
  profileConfidence: number;   // 0-1
  profileReasons: string[];    // Signals that led to detection
}
```

### ConfidenceSummary

```typescript
interface ConfidenceSummary {
  graphResolution: number;       // How well the declaration graph resolved
  domainInference: number;       // How confident the domain classification is
  sampleCoverage: number;        // How much of the surface was measured
  scenarioApplicability: number; // How applicable the scenario pack is
}
```

### CoverageDiagnostics

```typescript
interface CoverageDiagnostics {
  typesSource: 'bundled' | 'definitelyTyped' | 'source';
  reachableFiles: number;
  measuredPositions: number;
  undersampled: boolean;  // true = very few declarations, scores unreliable
}
```

## Core Patterns

### Extract Agent Readiness score

```bash
# Via globalScores (preferred — structured access)
npx typegrade score zod --json | jq '.globalScores.agentReadiness.score'

# Via composites array (also works)
npx typegrade score zod --json | jq '.composites[] | select(.key=="agentReadiness") | .score'
```

### Check analysis status before acting on results

```bash
npx typegrade score some-lib --json | jq '{status: .status, validity: .scoreValidity}'
# If status is "degraded", check .degradedReason before using scores
```

### Check if a package is undersampled

```bash
npx typegrade score tiny-lib --json | jq '.coverageDiagnostics.undersampled'
```

### Get all dimension scores

```bash
npx typegrade analyze . --json | jq '[.dimensions[] | {name: .key, score: .score, confidence: .confidence}]'
```

### Programmatic API in TypeScript

```typescript
import { analyzeProject, scorePackage, buildFixPlan, computeDiff } from 'typegrade';

const result = analyzeProject('./src');

// Check status before using scores
if (result.status === 'degraded') {
  console.warn(`Degraded result: ${result.degradedReason}`);
}

// Use globalScores for structured access
const { agentReadiness } = result.globalScores;
console.log(`Agent Readiness: ${agentReadiness.score} (${agentReadiness.grade})`);

if (result.coverageDiagnostics?.undersampled) {
  console.warn('Result is undersampled — treat as indicative');
}

// Fix planning
const plan = buildFixPlan(result);
console.log(`Fix batches: ${plan.batches.length}, expected uplift: +${plan.totalExpectedUplift}`);

// Diff analysis
const before = scorePackage('my-lib@1.0');
const after = scorePackage('my-lib@2.0');
const diff = computeDiff({ baseline: before, target: after });
```

## Status-Aware and Confidence-Aware Consumption

Always check `status` and `scoreValidity` before making decisions:

```typescript
import { scorePackage } from 'typegrade';

const result = scorePackage('some-lib');

// Step 1: Check status — degraded results no longer emit fake zeros
if (result.status !== 'complete') {
  console.warn(`Analysis ${result.status}: ${result.degradedReason}`);
  if (result.scoreValidity === 'not-comparable') {
    return; // Scores are not usable for ranking
  }
}

// Step 2: Check confidence
const ar = result.globalScores.agentReadiness;

if (ar.score === null) {
  // No score available
} else if (result.coverageDiagnostics?.undersampled) {
  // Undersampled: score capped at 65, unreliable
} else if (ar.confidence < 0.5) {
  // Low confidence: treat as directional only
} else if (ar.confidence < 0.7) {
  // Moderate confidence: score is moderated (pulled toward baseline)
} else {
  // High confidence: score is reliable
}
```

Confidence below 0.7 triggers score moderation — scores above the baseline
(50) are pulled proportionally toward 50. This prevents overconfident
high scores from limited evidence.

## Common Mistakes

### CRITICAL — Making blocking decisions on degraded or undersampled results

Wrong:

```typescript
const result = scorePackage('micro-util');
if (result.globalScores.consumerApi.score < 60) {
  throw new Error('Unacceptable type quality');
}
```

Correct:

```typescript
const result = scorePackage('micro-util');
if (result.status !== 'complete' || result.scoreValidity === 'not-comparable') {
  console.warn(`Analysis ${result.status}, scores not reliable`);
  return;
}
if (result.coverageDiagnostics?.undersampled) {
  console.warn('Undersampled package — skipping gate');
  return;
}
if (result.globalScores.consumerApi.score < 60) {
  throw new Error('Unacceptable type quality');
}
```

Undersampled packages have scores capped at 65. Acting on them as if they
are precise measurements leads to false positives and false negatives.

### HIGH — Comparing domain scores across different domains

Wrong:

```typescript
const zod = scorePackage('zod');
const express = scorePackage('express');
const zodDomain = zod.domainScore?.score ?? 0;      // validation domain
const expressDomain = express.domainScore?.score ?? 0; // router domain
// Comparing these numbers is meaningless
```

Correct:

```typescript
const zod = scorePackage('zod');
const express = scorePackage('express');
// Compare global scores — these use fixed weights
const zodAR = zod.composites.find(c => c.key === 'agentReadiness')?.score ?? 0;
const expressAR = express.composites.find(c => c.key === 'agentReadiness')?.score ?? 0;
```

Domain scores use domain-specific weight adjustments. A validation library's
domain score of 72 and a router library's domain score of 48 are not
comparable — the weight schemes differ.

### HIGH — Using scenario scores outside their domain

Wrong:

```typescript
const result = scorePackage('my-router');
// scenarioScore is from the router scenario pack
if (result.scenarioScore && result.scenarioScore.score < 50) {
  console.log('Poor validation capabilities');  // Wrong domain!
}
```

Correct:

```typescript
const result = scorePackage('my-router');
if (result.scenarioScore) {
  console.log(`${result.scenarioScore.scenario} scenario: ${result.scenarioScore.score}`);
  // Only interpret within the detected scenario domain
}
```

Scenario scores come from domain-specific consumer benchmark tests.
A router scenario score says nothing about validation capabilities.

## References

- [JSON field reference](references/json-fields.md)
