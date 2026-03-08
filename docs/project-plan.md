# typegrade — Architecture & Implementation Status

## v0.3.0 (current)

All implementation steps complete.

### Tech Stack

- **Language:** TypeScript
- **Type Resolution:** `ts-morph` (wraps TypeScript Compiler API)
- **CLI:** `commander`
- **Output:** `picocolors` for terminal
- **Build:** `tsup`
- **Test:** `vitest`
- **Lint/Format:** `oxlint` + `oxfmt`
- **Package Manager:** `pnpm`

### Project Structure

```
typegrade/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts                  # CLI entry point (#!/usr/bin/env node)
│   ├── cli.ts                    # Argument parsing, command routing
│   ├── analyzer.ts               # Orchestrator — dual-view analysis, surface extraction
│   ├── scorer.ts                 # Weighted composite scoring with confidence
│   ├── types.ts                  # All shared types/interfaces
│   ├── constants.ts              # Dimension configs, weights, strict flags
│   ├── domain.ts                 # Domain detection (validation, result libs)
│   ├── package-scorer.ts         # npm package scoring (graph-based)
│   ├── surface/
│   │   ├── types.ts              # PublicSurface, SurfaceDeclaration, SurfacePosition
│   │   ├── sampler.ts            # extractPublicSurface() — shared API extraction
│   │   └── index.ts              # Barrel re-exports
│   ├── graph/
│   │   ├── types.ts              # DeclarationGraph, GraphNode, ResolvedEntrypoint
│   │   ├── resolve.ts            # Entrypoint resolution from package.json
│   │   ├── walker.ts             # BFS import graph walker
│   │   ├── dedup.ts              # 3-level deduplication
│   │   └── index.ts              # buildDeclarationGraph()
│   ├── analyzers/
│   │   ├── api-specificity.ts    # Type narrowness scoring
│   │   ├── api-safety.ts         # any/unknown leakage (domain-aware)
│   │   ├── semantic-lift.ts      # Advanced type feature usage
│   │   ├── publish-quality.ts    # Explicit returns, JSDoc, typed params
│   │   ├── surface-coherence.ts  # API consistency checks
│   │   ├── declaration-fidelity.ts  # Source→declaration preservation (source-only)
│   │   ├── implementation-soundness.ts  # Assertions, unsoundness (source-only)
│   │   ├── boundary-discipline.ts  # I/O validation (source-only)
│   │   └── config-discipline.ts  # Strict tsconfig flags (source-only)
│   └── utils/
│       ├── project-loader.ts     # Load TS project via ts-morph
│       ├── type-utils.ts         # analyzePrecision() — recursive type scoring
│       └── format.ts             # Terminal report, bars, JSON output
├── test/
│   ├── fixtures/                 # 5 test fixture projects
│   ├── e2e.test.ts
│   ├── type-precision.test.ts
│   ├── scorer.test.ts
│   ├── strict-config.test.ts
│   └── unsoundness.test.ts
├── benchmarks/
│   ├── manifest.json             # 15 packages with tier labels
│   ├── run.ts                    # Benchmark runner
│   ├── assertions.ts             # 38 pairwise ranking assertions
│   └── calibrate.ts              # Weight adjustment suggestions
└── docs/
    ├── project-plan.md           # This file
    ├── testing-guide.md          # Benchmark results and methodology
    └── research.md               # Background research
```

### Scoring Architecture

**Three composites** from **nine dimensions**:

| Composite | Source Mode | Package Mode |
|---|---|---|
| Agent Readiness | 65% Consumer + 35% Implementation | 100% Consumer |
| Consumer API | Weighted average of 6 dimensions | 5 dimensions (no decl fidelity) |
| Implementation | 3 dimensions | n/a |

**Consumer dimensions:** apiSpecificity (0.40), apiSafety (0.20), semanticLift (0.15), publishQuality (0.10), surfaceCoherence (0.05), declarationFidelity (0.10, source-only)

**Implementation dimensions:** implementationSoundness (0.45), boundaryDiscipline (0.25), configDiscipline (0.20)

### Key Design Decisions

1. **Shared public surface**: All consumer analyzers consume a single `PublicSurface` extraction, eliminating duplicate traversal.
2. **Declaration graph**: Package scoring resolves entrypoints from package.json, walks imports via BFS, and deduplicates ESM/CJS twins.
3. **Dual-view analysis**: Source mode emits declarations in-memory to score both consumer API and implementation.
4. **Domain-aware scoring**: Detects validation/result library patterns and suppresses false positives.
5. **Confidence scoring**: Each dimension and composite carries a confidence value.

### Implementation History

- **v0.1.0**: Initial 6-dimension model (type precision, coverage, strict config, unsoundness, export quality, runtime validation)
- **v0.2.0**: Restructured to 3 composites + 8 dimensions. Added package scoring with graph engine, shared surface sampler, class/enum coverage.
- **v0.3.0**: Added semanticLift and surfaceCoherence dimensions (replacing apiExpressiveness). Domain detection, confidence scoring, declaration fidelity deepening. 15-package benchmark with 38 assertions.
