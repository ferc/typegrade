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
library_version: "0.9.0"
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
  mode: 'source' | 'package';
  scoreProfile: string;
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;

  // Three global composites (always present)
  composites: CompositeScore[];

  // Domain score (present when domain detected or overridden)
  domainScore?: DomainScore;

  // Scenario score (present when a scenario pack applies)
  scenarioScore?: ScenarioScore;

  // Confidence signals
  confidenceSummary: ConfidenceSummary;

  // Coverage info
  coverageDiagnostics: CoverageDiagnostics;

  // Per-dimension results
  dimensions: DimensionResult[];

  // Top issues sorted by severity
  topIssues: Issue[];

  // Package identity (package mode only)
  packageIdentity?: PackageIdentity;

  // Evidence summary
  evidenceSummary?: EvidenceSummary;

  // Boundary analysis (source mode only)
  boundaryQuality?: BoundaryQualityScore;
  boundarySummary?: BoundarySummary;

  // Autofix summary (agent mode only)
  autofixSummary?: AutofixSummary;
}
```

### CompositeScore

```typescript
interface CompositeScore {
  key: 'consumerApi' | 'agentReadiness' | 'typeSafety';
  score: number;       // 0-100
  grade: Grade;        // 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
  confidence: number;  // 0-1
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
npx typegrade score zod --json | jq '.composites[] | select(.key=="agentReadiness") | .score'
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
const agentReadiness = result.composites.find(c => c.key === 'agentReadiness');
console.log(`Agent Readiness: ${agentReadiness?.score} (${agentReadiness?.grade})`);

if (result.coverageDiagnostics.undersampled) {
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

## Confidence-Aware Consumption

Always check confidence before making decisions:

```typescript
import { scorePackage } from 'typegrade';

const result = scorePackage('some-lib');
const ar = result.composites.find(c => c.key === 'agentReadiness');

if (!ar || ar.score === null) {
  // No score available
} else if (result.coverageDiagnostics.undersampled) {
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

### CRITICAL — Making blocking decisions on undersampled results

Wrong:

```typescript
const result = scorePackage('micro-util');
if (result.composites[0].score < 60) {
  throw new Error('Unacceptable type quality');
}
```

Correct:

```typescript
const result = scorePackage('micro-util');
const score = result.composites[0];
if (result.coverageDiagnostics.undersampled) {
  console.warn(`Score ${score.score} is from an undersampled package — skipping gate`);
  return;
}
if (score.score < 60) {
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
