---
name: maintain-skills
description: >
  Maintain typegrade TanStack Intent skills. Covers updating skill content
  after code changes, running Intent validate and stale checks, syncing
  skill sources with CLI behavior and docs, and publishing verified skills.
  Use when modifying typegrade code that affects CLI, JSON output, scoring,
  or documentation.
type: lifecycle
library: typegrade
library_version: "0.15.0"
sources:
  - "ferc/typegrade:AGENTS.md"
  - "ferc/typegrade:skills/_artifacts/domain_map.yaml"
  - "ferc/typegrade:skills/_artifacts/skill_tree.yaml"
---

# typegrade — Maintain Intent Skills

This skill is for typegrade maintainers. It covers how to keep shipped
skills accurate after code changes.

## Setup

```bash
# Validate skill structure
pnpm intent:validate

# Check for staleness
pnpm intent:stale

# List all skills
pnpm intent:list
```

## Skill-to-Code Mapping

When you change code, update the affected skills in the same commit:

| Change area                   | Affected skills                                                        |
| ----------------------------- | ---------------------------------------------------------------------- |
| CLI commands or flags         | `analyze-project`, `score-package`, `compare-packages`, `quality-gate` |
| JSON output shape or fields   | `consume-json`                                                         |
| Scoring dimensions or weights | `analyze-project`, `score-package`, `consume-json`                     |
| Confidence or coverage logic  | `score-package`, `consume-json`, `quality-gate`                        |
| Self-analyze or agent output  | `self-analyze`                                                         |
| Fix planning or apply-fixes   | `self-analyze`, `consume-json`                                         |
| Boundary analysis             | `analyze-project`, `consume-json`                                      |
| Diff analysis                 | `compare-packages`, `consume-json`                                     |
| Domain detection or scenarios | `score-package`, `consume-json`                                        |
| Profile system                | `analyze-project`, `quality-gate`                                      |
| Benchmark or CI workflows     | `quality-gate`, `maintain-skills`                                      |

## Validation Workflow

### After any skill edit

```bash
# 1. Validate structure (frontmatter, line count, naming)
pnpm intent:validate

# 2. Check for version staleness
pnpm intent:stale

# 3. Verify skills are discoverable from a consumer's perspective
pnpm intent:list
```

### After a version bump

Update `library_version` in every SKILL.md frontmatter:

```bash
# Find all skills with the old version
grep -r 'library_version:' skills/ --include='SKILL.md'
# Update each file
```

### After changing CLI behavior

1. Run the affected CLI command to verify current behavior.
2. Update the skill's code examples to match.
3. If a command was renamed or removed, update or remove the skill.
4. Run `pnpm intent:validate` to confirm.

### After changing JSON output

1. Run `npx typegrade analyze . --json` and `npx typegrade score zod --json`.
2. Compare actual output fields with `consume-json/SKILL.md` and
   `consume-json/references/json-fields.md`.
3. Update field tables and TypeScript interfaces to match.
4. Run `pnpm intent:validate` to confirm.

## Smoke Testing

```bash
# Build and pack
pnpm build
pnpm pack

# Install in a fresh directory and verify discovery
mkdir /tmp/intent-test && cd /tmp/intent-test
npm init -y
npm install /path/to/typegrade-*.tgz
npx @tanstack/intent@latest list
# Should show typegrade with all 7 skills
```

## Core Patterns

### Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` with valid frontmatter.
2. Ensure `name` in frontmatter matches the directory name.
3. Add the skill to `skills/_artifacts/skill_tree.yaml`.
4. Update `skills/_artifacts/domain_map.yaml` if it belongs to a new domain.
5. Add the skill to the mapping table in this file and in `AGENTS.md`.
6. Run `pnpm intent:validate`.

### Removing a skill

1. Delete the `skills/<skill-name>/` directory.
2. Remove from `skill_tree.yaml` and `domain_map.yaml`.
3. Remove from the mapping table in this file and `AGENTS.md`.
4. Run `pnpm intent:validate`.

## Common Mistakes

### HIGH — Updating code without updating affected skills

Wrong:

```bash
# Change --min-score to check consumerApi instead of agentReadiness
# Commit without updating quality-gate/SKILL.md
```

Correct:

```bash
# Change --min-score behavior
# Update quality-gate/SKILL.md to reflect the new behavior
# Run pnpm intent:validate
# Commit code + skill changes together
```

Stale skills teach agents wrong patterns. Always update skills in the same
commit as the code change that affects them.

### MEDIUM — Forgetting to bump library_version

Wrong:

```yaml
# In SKILL.md frontmatter after a 0.13.0 -> 0.14.0 release
library_version: "0.13.0"
```

Correct:

```yaml
library_version: "0.14.0"
```

The `stale` check compares `library_version` against the published npm version.
Stale versions trigger warnings for consumers running `npx @tanstack/intent stale`.

### MEDIUM — Publishing without validation

Wrong:

```bash
pnpm publish
# Skills may have structural errors or stale content
```

Correct:

```bash
pnpm intent:validate && pnpm intent:stale && pnpm publish
```

Always validate and check staleness before publishing. CI should enforce
this as a release gate.
