# Agent Skills

typegrade ships versioned skills for AI coding agents via [TanStack Intent](https://tanstack.com/intent/latest). Skills are discovered automatically from `node_modules` when consumers install typegrade.

## Shipped Skills

| Skill | What it teaches |
|---|---|
| `analyze-project` | Local codebase analysis with `typegrade analyze`. Profile selection, verbose/explain flags, confidence interpretation. |
| `score-package` | Published package evaluation with `typegrade score`. Package-vs-source mode differences, confidence/coverage caveats. |
| `compare-packages` | Side-by-side comparison with `typegrade compare`. Reading deltas, domain fit, avoiding cross-domain mistakes. |
| `quality-gate` | CI integration with `--min-score`. Exit codes, JSON output, handling low-confidence failures. |
| `consume-json` | Programmatic JSON consumption. Stable fields, confidence handling, undersampling detection. |
| `self-analyze` | Closed-loop improvement with `typegrade self-analyze`. Fix batches, risk levels, iterative workflows. |
| `maintain-skills` | Maintainer skill for keeping skills fresh. Intent validation, stale checks, code-to-skill mapping. |

## Consumer Setup

Install typegrade in your project:

```bash
npm install typegrade
```

Then run TanStack Intent to discover and map skills:

```bash
npx @tanstack/intent@latest install
```

This scans `node_modules` for intent-enabled packages and writes skill-to-task mappings into your agent config (CLAUDE.md, .cursorrules, etc.).

To list available skills:

```bash
npx @tanstack/intent@latest list
```

## How Discovery Works

TanStack Intent discovers skills by scanning `node_modules` for packages that have a `skills/` directory and a `repository` field in `package.json`. When a consumer installs typegrade, the 7 skills in `skills/` become available to their AI coding agents.

Each skill is a `SKILL.md` file with YAML frontmatter that describes when the agent should load it (description field) and what library version it targets (library_version field). The agent reads the skill content to understand how to use typegrade correctly.

## Maintainer Guide

### Updating skills after code changes

See `AGENTS.md > Skill Freshness` for the mandatory review policy. In short: any change to CLI, JSON output, scoring, or docs requires updating the affected skills in the same commit.

### Validation

```bash
pnpm intent:validate   # Check SKILL.md structure (frontmatter, naming, line count)
pnpm intent:stale      # Check library_version against published npm version
pnpm intent:list       # Verify skills are discoverable
pnpm intent:smoke      # Verify skills appear in npm pack output
```

### Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` with valid YAML frontmatter.
2. Ensure `name` in frontmatter matches the directory name exactly.
3. Keep the file under 500 lines (move excess to `references/`).
4. Add the skill to `skills/_artifacts/skill_tree.yaml` and `domain_map.yaml`.
5. Add the skill to the mapping table in `AGENTS.md > Skill Freshness`.
6. Run `pnpm intent:validate`.

### Version bumps

After releasing a new version, update `library_version` in every SKILL.md frontmatter. The `stale` check compares this against the published npm version.

### Release gates

Before publishing, verify:

```bash
pnpm intent:validate                     # No structural errors
pnpm intent:stale                        # No version drift
pnpm pack --dry-run 2>&1 | grep skills/  # Skills in tarball
```
