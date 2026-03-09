---
name: self-analyze
description: >
  Run typegrade self-analyze for closed-loop type quality improvement.
  Produces agent-optimized output with actionable fix batches ordered by
  impact, suppression breakdowns, and expected score improvements.
  Covers the self-analyze workflow, reading fix batches, understanding
  risk levels, and safe iterative improvement. Use when running typegrade
  in agent-driven refactoring or self-improvement loops.
type: core
library: typegrade
library_version: "0.11.0"
sources:
  - "ferc/typegrade:src/cli.ts"
  - "ferc/typegrade:src/agent/report.ts"
  - "ferc/typegrade:src/agent/types.ts"
---

# typegrade — Self-Analyze and Improve

Use `typegrade self-analyze` for closed-loop type quality improvement.
It runs analysis with the autofix-agent profile and produces actionable
output with fix batches ordered by impact.

## Setup

```bash
npx typegrade self-analyze .
```

Analyzes the current directory with agent-optimized output. Shows current
scores, actionable findings, fix batches, and suppression breakdown.

## Core Patterns

### Human-readable self-analysis

```bash
npx typegrade self-analyze .
```

Output:

```
  typegrade self-analyze

  Current Scores:
    consumerApi             72/100 (B)
    agentReadiness          68/100 (C)
    typeSafety              65/100 (C)

  Actionable Findings:
    Total issues: 23
    Suppressed: 5
    Expected improvement: +8 points

  Fix Batches (ordered by impact):
    [low] Add explicit return types to exported functions (impact: 3)
    [low] Replace string with literal unions (impact: 2)
    [medium] Add discriminant fields to union types (impact: 2) [needs review]
    [high] Remove unsafe casts in boundary handlers (impact: 1) [needs review]
```

### JSON output for agent consumption

```bash
npx typegrade self-analyze . --json
```

Returns an `AgentReport` with up to 50 actionable issues (capped by the agent
issue budget), sorted by `agentPriority` with source-owned issues first:

```typescript
interface AgentReport {
  actionableIssues: Issue[];  // Capped at 50, ownership-prioritized
  fixBatches: FixBatch[];
  enrichedBatches: EnrichedFixBatch[];  // Batches with score deltas and verification
  suppressedCount: number;
  suppressionReasons: { category: string; count: number }[];
  executionOrder: string[];             // Suggested batch execution order (batch IDs)
  expectedScoreImprovement: number;
  stopConditions: StopCondition[];      // When the agent should stop iterating
  verificationSteps: string[];          // Commands to verify the entire report
}

interface FixBatch {
  title: string;
  risk: 'low' | 'medium' | 'high';
  expectedImpact: number;
  requiresHumanReview: boolean;
  issues: Issue[];
}

interface EnrichedFixBatch extends FixBatch {
  expectedScoreDelta: number;      // Estimated score delta from this batch
  verificationCommands: string[];  // Commands to run after applying this batch
}

interface StopCondition {
  kind: 'no-actionable-issues' | 'all-batches-applied' | 'score-target-met'
      | 'diminishing-returns' | 'max-iterations';
  met: boolean;
  reason: string;
}
```

### Iterative improvement workflow

```bash
# Step 1: Analyze and identify fix batches
npx typegrade self-analyze . --json > report.json

# Step 2: Follow the suggested execution order
jq '.executionOrder' report.json

# Step 3: Apply low-risk fixes first
jq '.fixBatches[] | select(.risk=="low")' report.json

# Step 4: Check stop conditions before continuing
jq '.stopConditions[] | select(.met==true)' report.json

# Step 5: Re-analyze to verify improvement
npx typegrade self-analyze .

# Step 6: Move to medium-risk fixes with human review
jq '.fixBatches[] | select(.risk=="medium")' report.json
```

### Specific path analysis

```bash
npx typegrade self-analyze ./src/api
```

Scopes the analysis to a subdirectory for focused improvement.

### Using fix-plan and apply-fixes for structured improvements

For a more structured approach with dependency ordering and confidence:

```bash
# Generate a fix plan with batch dependencies and verification
npx typegrade fix-plan . --json > plan.json

# Apply only safe fixes automatically
npx typegrade apply-fixes . --mode safe

# Apply fixes including those needing human review
npx typegrade apply-fixes . --mode review --json
```

`fix-plan` produces a `FixPlan` with ordered batches, expected uplift per
batch, confidence scores, target files, dependency chains, and verification
commands. `apply-fixes` executes the batches and reports before/after scores.

## Understanding Fix Batches

Fix batches group related issues and are ordered by impact (highest first):

- **Risk: low** — Safe to apply automatically. Example: adding explicit return
  types, replacing `string` with literal unions.
- **Risk: medium** — Likely safe but review the diff. Example: adding
  discriminant fields, tightening generic constraints.
- **Risk: high** — Requires human review. Example: removing unsafe casts,
  changing boundary validation logic.

Each batch shows `requiresHumanReview: true` when the fix might change
runtime behavior.

## Understanding Suppressions

Some issues are suppressed based on the analysis profile. There are 13
suppression categories. Common ones in agent reports:

- **dependency-owned-opaque** — Issue in dependency-owned code, not fixable locally.
- **generated-artifact** — Issue in generated code (e.g. `.generated.ts`).
- **low-evidence** — Not enough evidence to be actionable.
- **non-applicable-dimension** — Dimension does not apply to this codebase.
- **trusted-local-tooling** — Issue in trusted local tooling code.
- **ambiguous-ownership** — Ownership could not be determined.
- **self-referential-false-positive** — Self-referential pattern, not a real issue.
- **expected-domain-complexity** — Complexity expected for this domain.

## Common Mistakes

### HIGH — Applying high-risk fix batches without review

Wrong:

```bash
npx typegrade self-analyze . --json | jq '.fixBatches[].issues' | xargs -I {} apply-fix {}
# Applies all fixes including high-risk ones blindly
```

Correct:

```bash
# Apply only low-risk batches automatically
npx typegrade self-analyze . --json | jq '[.fixBatches[] | select(.risk=="low")]'
# Review medium and high-risk batches manually before applying
```

High-risk fix batches may change runtime behavior. Always review the specific
issues in each batch before applying changes that touch boundary handling,
type assertions, or cast removals.

### MEDIUM — Not re-analyzing after fixes

Wrong:

```bash
# Apply all fix batches from one report
# Assume the expected improvement number is the actual result
```

Correct:

```bash
npx typegrade self-analyze . --json > before.json
# Apply fixes
npx typegrade self-analyze . --json > after.json
# Compare actual vs expected improvement
```

Fix interactions can amplify or cancel each other. The `expectedScoreImprovement`
is an estimate. Always re-analyze after applying fixes to verify the actual
improvement.

### MEDIUM — Ignoring suppressed issues entirely

Wrong:

```bash
npx typegrade self-analyze . --json | jq '.actionableIssues'
# Only looks at actionable, ignores suppressed context
```

Correct:

```bash
npx typegrade self-analyze . --json | jq '{
  actionable: .actionableIssues | length,
  suppressed: .suppressedCount,
  reasons: .suppressionReasons
}'
# Understand why issues were suppressed — some may warrant investigation
```

Suppressed issues are not necessarily non-issues. Review the suppression
breakdown to understand which categories are being filtered and whether
the profile-based suppressions match your project's needs.
