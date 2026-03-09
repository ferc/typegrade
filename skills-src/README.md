# skills-src

Maintainer authoring layer for typegrade Intent skills.

## Structure

- `workflows/` — Skill authoring and maintenance workflows
- `references/` — Source-of-truth inputs for skill generation
- `generated/` — Generated artifacts from CLI, types, and docs

## How shipped skills are derived

Shipped skills in `skills/` are authored from these sources:

- `README.md` — CLI examples, score interpretation, quickstart
- `docs/` — scoring contract, confidence model, how-it-works
- `src/cli.ts` — CLI command definitions and flags
- `src/index.ts` — Public API exports
- `src/types.ts` — Stable output types

Generated artifacts in `generated/` capture CLI help snapshots, JSON output
examples, and public API surfaces that skills reference. When these inputs
change, the affected skills need updating (see AGENTS.md > Skill Freshness).
