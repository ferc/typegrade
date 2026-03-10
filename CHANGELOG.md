## [0.14.0](https://github.com/ferc/typegrade/compare/v0.13.0...v0.14.0) (2026-03-10)

### Features

* balanced analysis plan — trust, evidence, boundaries, agent output, diagnostics, and schema 0.14.0 ([e5f46d1](https://github.com/ferc/typegrade/commit/e5f46d1d2d73dcc94a2f7dc930fb0af8b6b77693))
* codebase-aware fit-compare, enriched comparisons, scenario outcomes, and schema 0.13.0 ([ce9a619](https://github.com/ferc/typegrade/commit/ce9a619b3bdbd3a74fb4038ba823741ae4851814))
* decision-grade reports, agent execution contract, and schema 0.12.0 ([93cf81b](https://github.com/ferc/typegrade/commit/93cf81b49752767646265143ecbaa193f17736ef))
* domain mismatch abstention, evidence gating, and comparability tracking ([1e00d34](https://github.com/ferc/typegrade/commit/1e00d34fbda298fc5a6bc64b74a2ba0be66df5e5))
* issue clusters, inspection reports, codebase relevance, agent JSON alignment, and schema 0.14.0 ([b2bf7af](https://github.com/ferc/typegrade/commit/b2bf7afb594f7cd197589c39e971c05971dcc95e))
* JSON contract normalization, source diagnostics, confidence bottlenecks, source diff, migration metrics ([82ade01](https://github.com/ferc/typegrade/commit/82ade01705c16603ff69381ef0353ef9c74285a1))
* push-to-99% — 9 workstreams for off-corpus trust, shadow gating, and agent precision ([a01eb89](https://github.com/ferc/typegrade/commit/a01eb89510cc86acd4d9b66660f3e7bcc1253405))
* smart root command — one tool, many modes ([6ce5f32](https://github.com/ferc/typegrade/commit/6ce5f3295f7e6a75d42d7c29c95af2a63a891a7f))
* source/monorepo benchmarks, release gates, and off-corpus directional scoring ([9e9e86c](https://github.com/ferc/typegrade/commit/9e9e86c37ec4b5f2665c862cc20fdd01d2b931a5))

### Bug Fixes

* add missing wilsonLowerBound import in shadow benchmark ([23ed3a0](https://github.com/ferc/typegrade/commit/23ed3a07a2dcf92451b3541e6d349c9ddadb25d6))
* reduce analyzer noise by filtering safe assertions and fixing boundary scoring ([a9c8e7c](https://github.com/ferc/typegrade/commit/a9c8e7c9407478391932f55ee40b3ec128736185))
* smart CLI target classification, trust alignment, and agentReport typing ([d765a75](https://github.com/ferc/typegrade/commit/d765a7538a2030df45fc720f0f40fc3a78ccf9c0))

## [0.13.0](https://github.com/ferc/typegrade/compare/v0.12.0...v0.13.0) (2026-03-09)

### Features

* add output trust contract with TrustSummary, ResolutionDiagnostics, holdout split, and shadow validation ([e261ed5](https://github.com/ferc/typegrade/commit/e261ed5fa2ad83951c184b93d3a0fe836dde768c))
* add signal-hygiene layer and comparison decision report ([f7a9042](https://github.com/ferc/typegrade/commit/f7a904259b3c4b1c51ab9dfeb800e217d852ca05))
* harden degraded results, confidence gating, and ownership model ([180cd7d](https://github.com/ferc/typegrade/commit/180cd7d8843f550d8f64519565adfdc7d9d8e275))
* implement remaining trust workstreams (WS2, WS4, WS5, WS8, WS9, WS10) ([6d7757c](https://github.com/ferc/typegrade/commit/6d7757c1d8ca61f876fbeb05c9974cb6cfd401a8))
* implement trustworthiness hardening across 12 workstreams ([503d69c](https://github.com/ferc/typegrade/commit/503d69c9efd1e37a61536ee19c8756bbd60fa39c))

### Bug Fixes

* expand holdout corpus to 18 packages and tune CI gates for small n ([07b9b7d](https://github.com/ferc/typegrade/commit/07b9b7df0b5be4483be1ee308f2e73b6918bb133))
* harden benchmark plumbing with CI-bound gates, install-failure accounting, and comparable tracking ([75af7c7](https://github.com/ferc/typegrade/commit/75af7c742d592f0d18393d55f172d4322786754c))
* restore train benchmark by making package analysis graph-first ([2724059](https://github.com/ferc/typegrade/commit/2724059186298e66f54f3570ef8531ceec998981))
* scope source files to target directory in monorepo analysis ([8b8422f](https://github.com/ferc/typegrade/commit/8b8422f833ebd715cd3ecfaea1c3c3734d79af20))
* skip degraded-package assertions and fix exactOptionalPropertyTypes errors ([343ab20](https://github.com/ferc/typegrade/commit/343ab20f116c64d7a65b0019336adbbd810803c5))

### Performance Improvements

* optimize CLI startup, result caching, and subpath exports ([3958096](https://github.com/ferc/typegrade/commit/395809609b5b5d35f8a7a34771ae90f4dbfb6d73))

## [0.12.0](https://github.com/ferc/typegrade/compare/v0.11.0...v0.12.0) (2026-03-09)

### Features

- implement maximum-accuracy generalization plan (schema 0.11.0) ([088c2de](https://github.com/ferc/typegrade/commit/088c2dee0409b09b3f2fd45b5cf8e648630a0b86))

## [0.11.0](https://github.com/ferc/typegrade/compare/v0.10.0...v0.11.0) (2026-03-09)

### Features

- add any-leak path tracking, dependency origin detection, and density-proportional penalties ([bb8552d](https://github.com/ferc/typegrade/commit/bb8552d192e4b66e172509a02255e80ac72cf3fa))
- sort topIssues by fixability so actionable issues surface first ([eb4ee04](https://github.com/ferc/typegrade/commit/eb4ee049a7a072245c9aaa40173571c8b0409c17))

## [0.10.0](https://github.com/ferc/typegrade/compare/v0.9.0...v0.10.0) (2026-03-09)

### Features

- add boundary analysis, fix planning, monorepo support, diff, and config loader ([7d8222e](https://github.com/ferc/typegrade/commit/7d8222e5abb942dde14973d6488cc759d241e708))
- add TanStack Intent skills for AI agent integration ([44bd0ab](https://github.com/ferc/typegrade/commit/44bd0abd9a22c19ace0a41b01346647effb2a9ed))

## [0.9.0](https://github.com/ferc/typegrade/compare/v0.8.0...v0.9.0) (2026-03-09)

### Features

- **accuracy:** implement 8-phase accuracy maximization plan ([2e6bcd2](https://github.com/ferc/typegrade/commit/2e6bcd20f6a06b8873213113eeb13fa6a58334e2))
- add multi-profile scoring, agent infrastructure, and self-analyze command ([052de39](https://github.com/ferc/typegrade/commit/052de3947559a5c1804c00d9c7c8e1580e2adf8c))

### Bug Fixes

- **ci:** track test fixture node_modules, inject version at build time ([6d3e494](https://github.com/ferc/typegrade/commit/6d3e494f8c7f3ece42bfbe0235b50bff4c145b75))
- **scoring:** resolve .d.ts companions for JS exports, tighten testing-library detection, fix gate snapshot lookup ([b71bbf3](https://github.com/ferc/typegrade/commit/b71bbf38588938ed2b510ba6ba36266d7607201f))
- **soundness:** replace 'as OutputOptions' casts with typed extraction in CLI ([93b02bc](https://github.com/ferc/typegrade/commit/93b02bcb5a07d57e61b15b987fdbfbfa4e5f6aad))
- **soundness:** replace non-null assertions with null-coalescing in scorer and package-scorer ([78e1737](https://github.com/ferc/typegrade/commit/78e17375915994f5a5a9958c5216b3cba11c4813))
- **types:** eliminate all `as any` casts, tighten domain types, remove double assertions ([529bf41](https://github.com/ferc/typegrade/commit/529bf41cdd37304904ec9f0873c7b97cfdd7a4dd))

## [0.7.6](https://github.com/ferc/typegrade/compare/v0.7.5...v0.7.6) (2026-03-08)

### Bug Fixes

- **ci:** use npm 11.5.1+ for trusted publishing OIDC support ([8f94228](https://github.com/ferc/typegrade/commit/8f9422818bdb16d12b97e252b48a635373c1a8f5))

## [0.7.5](https://github.com/ferc/typegrade/compare/v0.7.4...v0.7.5) (2026-03-08)

### Bug Fixes

- **ci:** manually exchange OIDC token and write npm auth to project .npmrc ([2424448](https://github.com/ferc/typegrade/commit/242444813a96ecc0451f0923eaca4a95b405cfb6))

## [0.7.4](https://github.com/ferc/typegrade/compare/v0.7.3...v0.7.4) (2026-03-08)

### Bug Fixes

- **ci:** enable npm provenance in publishConfig for OIDC auth ([6746dab](https://github.com/ferc/typegrade/commit/6746dab1783f0964bf6291329f9c6668188743be))

## [0.7.3](https://github.com/ferc/typegrade/compare/v0.7.2...v0.7.3) (2026-03-08)

### Bug Fixes

- **ci:** remove registry-url to stop overriding OIDC npm auth ([eddaf91](https://github.com/ferc/typegrade/commit/eddaf91466ef7b2651f077afb033720b664908cf))

## [0.7.2](https://github.com/ferc/typegrade/compare/v0.7.1...v0.7.2) (2026-03-08)

### Bug Fixes

- **ci:** remove NPM_TOKEN env vars to enable OIDC trusted publishing ([ce7b058](https://github.com/ferc/typegrade/commit/ce7b058a4ce7270e2d50361db50d440434893115))
- **ci:** reorder release plugins so GitHub release is created before npm ([c313ece](https://github.com/ferc/typegrade/commit/c313ece03f6d28fe5b7f0f36766ff80d0aff7d88))

## [0.7.1](https://github.com/ferc/typegrade/compare/v0.7.0...v0.7.1) (2026-03-08)

### Bug Fixes

- **ci:** configure npm auth for release workflow ([943e4e8](https://github.com/ferc/typegrade/commit/943e4e86b455614da1d951c0917153d06b8afe58))

## [0.7.0](https://github.com/ferc/typegrade/compare/v0.6.0...v0.7.0) (2026-03-08)

### Features

- accuracy-to-95% plan — phases 8-9 ([e4a52cd](https://github.com/ferc/typegrade/commit/e4a52cdf142102dbccfe6b6849c9f7037e7a99af))

### Bug Fixes

- **release:** enable npm provenance publishing via OIDC ([f340538](https://github.com/ferc/typegrade/commit/f340538ced3e798d4e5fa14ed6002ecb59745b4d))

## [0.6.0](https://github.com/ferc/typegrade/compare/v0.5.0...v0.6.0) (2026-03-08)

### Features

- accuracy-to-95% plan — phases 1-7 ([357a9c2](https://github.com/ferc/typegrade/commit/357a9c220f6a3dc2782d1735e50049797cb99d3d))

### Bug Fixes

- **benchmarks:** add undersampled anchor waivers for known-stable packages ([44a2d06](https://github.com/ferc/typegrade/commit/44a2d0626164ae125d42260e935c39409b4a4326))
- **ci:** add packageManager field for pnpm/action-setup@v4 ([ff14b71](https://github.com/ferc/typegrade/commit/ff14b71a7b9ff2bf2b4e29c9b2a89e91f2a89854))
- **ci:** auto-format source files to pass format check ([35d3a0c](https://github.com/ferc/typegrade/commit/35d3a0c75c48a7b5d1cfeff2daeefff1068173c7))

# Changelog

All notable changes to this project will be documented in this file.
This file is automatically generated by [semantic-release](https://github.com/semantic-release/semantic-release).
