# tsguard — Implementation Plan

A fast CLI tool that scores TypeScript projects and npm packages on **type precision quality** — not just "do you have types?" but "how narrow, specific, and useful are your types?"

The premise: AI coding agents produce better output when operating within tighter static boundaries. This tool measures how tight those boundaries are.

## Tech Stack

- **Language:** TypeScript
- **Type Resolution:** `ts-morph` (wraps TypeScript Compiler API)
- **CLI:** `commander`
- **Output:** `picocolors` for terminal
- **Build:** `tsup`
- **Test:** `vitest`
- **Package Manager:** `pnpm`

---

## Project Structure

```
tsguard/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts                  # CLI entry point (#!/usr/bin/env node)
│   ├── cli.ts                    # Argument parsing, output formatting
│   ├── analyzer.ts               # Orchestrator — runs all analyzers, produces final score
│   ├── scorer.ts                 # Weighted composite scoring
│   ├── types.ts                  # All shared types/interfaces
│   ├── constants.ts              # Scoring weights, precision values, flag lists
│   ├── analyzers/
│   │   ├── type-coverage.ts      # Dimension 1: any/unknown coverage
│   │   ├── strict-config.ts      # Dimension 2: tsconfig strictness
│   │   ├── type-precision.ts     # Dimension 3: type narrowness (THE KEY ONE)
│   │   ├── unsoundness.ts        # Dimension 4: unsafe pattern detection
│   │   ├── runtime-validation.ts # Dimension 5: validation libraries at boundaries
│   │   └── export-quality.ts     # Dimension 6: exported API surface quality
│   ├── package-scorer.ts         # npm package scoring (install + analyze)
│   └── utils/
│       ├── project-loader.ts     # Load a TS project via ts-morph
│       ├── type-utils.ts         # Classify types, compute precision
│       └── format.ts             # Terminal bars, colors, JSON output
├── test/
│   ├── fixtures/
│   │   ├── high-precision/       # Project with branded types, discriminated unions, literal unions
│   │   ├── low-precision/        # Project with string, any, object everywhere
│   │   ├── medium-precision/     # Typical project with interfaces and enums
│   │   └── tanstack-style/       # Constrained generics, template literals
│   ├── type-precision.test.ts
│   ├── strict-config.test.ts
│   ├── unsoundness.test.ts
│   ├── scorer.test.ts
│   └── e2e.test.ts
```

---

## Core Types (src/types.ts)

Define these first. Everything else implements against them.

```typescript
/** The precision level of a single resolved type */
export type TypePrecisionLevel =
  | "any" // 0 points
  | "unknown" // 20 points
  | "wide-primitive" // 35 points — string, number, boolean, object
  | "primitive-union" // 45 points — string | number
  | "generic-unbound" // 40 points — <T> unconstrained
  | "interface" // 55 points — named object shape
  | "enum" // 65 points — string or numeric enum
  | "generic-bound" // 70 points — <T extends Base>
  | "literal" // 80 points — 'active', 42, true
  | "template-literal" // 82 points — `prefix-${string}`
  | "literal-union" // 85 points — 'a' | 'b' | 'c'
  | "branded" // 95 points — string & { __brand: 'X' }
  | "discriminated-union" // 95 points — { kind: 'a' } | { kind: 'b' }
  | "never"; // 90 points — exhaustiveness signal

/** Result from a single analyzer dimension */
export interface DimensionResult {
  name: string;
  score: number; // 0-100
  weight: number; // 0-1
  details: string[]; // Human-readable findings
  issues: Issue[];
}

export interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  dimension: string;
}

/** Final output */
export interface AnalysisResult {
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;
  overallScore: number; // 0-100
  grade: string; // A+, A, B, C, D, F
  dimensions: DimensionResult[];
  topIssues: Issue[]; // Top 10 most impactful
  aiReadiness: "HIGH" | "MODERATE" | "LOW" | "POOR";
}

export interface TsguardConfig {
  weights: {
    typeCoverage: number;
    strictConfig: number;
    typePrecision: number;
    unsoundness: number;
    runtimeValidation: number;
    exportQuality: number;
  };
  include: string[];
  exclude: string[];
  thresholds: {
    literalUnionMaxMembers: number;
    minScore: number;
  };
}
```

---

## Scoring Constants (src/constants.ts)

```typescript
export const DEFAULT_WEIGHTS = {
  typePrecision: 0.3, // Most important — the novel part
  typeCoverage: 0.15,
  strictConfig: 0.15,
  unsoundness: 0.15,
  exportQuality: 0.15,
  runtimeValidation: 0.1,
} as const;

export const PRECISION_SCORES: Record<TypePrecisionLevel, number> = {
  any: 0,
  unknown: 20,
  "wide-primitive": 35,
  "primitive-union": 45,
  "generic-unbound": 40,
  interface: 55,
  enum: 65,
  "generic-bound": 70,
  literal: 80,
  "template-literal": 82,
  "literal-union": 85,
  branded: 95,
  "discriminated-union": 95,
  never: 90,
};

export const STRICT_FLAGS: Record<string, number> = {
  strict: 10,
  noImplicitAny: 10,
  strictNullChecks: 15,
  strictFunctionTypes: 10,
  strictBindCallApply: 5,
  strictPropertyInitialization: 5,
  noImplicitReturns: 8,
  noFallthroughCasesInSwitch: 5,
  noUncheckedIndexedAccess: 12,
  exactOptionalPropertyTypes: 10,
  noImplicitOverride: 5,
  isolatedModules: 3,
  verbatimModuleSyntax: 2,
};
// Max possible = 100. Score = sum of enabled flags.
```

---

## The 6 Analyzers

### 1. Type Coverage (src/analyzers/type-coverage.ts)

Walk every identifier. Resolve its type. Count `any` vs non-`any`.

```
Score = (identifiers_not_any / total_identifiers) × 100
```

- Use `project.getSourceFiles()` → iterate files
- For each file, walk all `Identifier` nodes
- Call `node.getType()` → check `type.getFlags()` for `TypeFlags.Any`
- Distinguish explicit `any` (annotation) from implicit `any` (inference failure)
- Count `unknown` as a positive signal (intentional boundary)
- Ignore `node_modules`, test files, generated files

### 2. Strict Config (src/analyzers/strict-config.ts)

Parse `tsconfig.json`, check which strict flags are enabled, assign points per the `STRICT_FLAGS` table.

- Use ts-morph's `project.compilerOptions` or directly parse tsconfig.json
- Sum points for enabled flags
- Bonus: check `@ts-expect-error` usage over `@ts-ignore` (+5, capped at 100)

### 3. Type Precision (src/analyzers/type-precision.ts) — THE CORE

Analyze every exported function/method/variable and score the **narrowness** of its types.

**The classification function:**

```typescript
function classifyTypePrecision(type: Type): TypePrecisionLevel {
  const flags = type.getFlags();

  if (flags & TypeFlags.Any) return "any";
  if (flags & TypeFlags.Unknown) return "unknown";
  if (flags & TypeFlags.Never) return "never";

  // Unions — check subtypes
  if (type.isUnion()) {
    const members = type.getUnionTypes();
    if (isDiscriminatedUnion(members)) return "discriminated-union";
    if (
      members.every(
        (m) =>
          m.isStringLiteral() || m.isNumberLiteral() || m.isBooleanLiteral(),
      )
    ) {
      return "literal-union";
    }
    return "primitive-union";
  }

  // Literals
  if (
    type.isStringLiteral() ||
    type.isNumberLiteral() ||
    type.isBooleanLiteral()
  )
    return "literal";

  // Template literal types
  if (type.isTemplateLiteral?.()) return "template-literal";

  // Branded types: intersection of primitive + object with __brand-like property
  if (type.isIntersection()) {
    const members = type.getIntersectionTypes();
    const hasPrimitive = members.some(
      (m) => m.getFlags() & (TypeFlags.String | TypeFlags.Number),
    );
    const hasBrand = members.some(
      (m) =>
        m.isObject() &&
        m
          .getProperties()
          .some(
            (p) => p.getName().startsWith("__") || p.getName() === "_brand",
          ),
    );
    if (hasPrimitive && hasBrand) return "branded";
  }

  // Enums
  if (flags & TypeFlags.Enum || flags & TypeFlags.EnumLiteral) return "enum";

  // Generics
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown))
      return "generic-bound";
    return "generic-unbound";
  }

  // Object/interface
  if (type.isObject() || type.isInterface()) return "interface";

  // Wide primitives
  if (
    flags &
    (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt)
  ) {
    return "wide-primitive";
  }

  return "wide-primitive";
}
```

**Detecting discriminated unions:**

```typescript
function isDiscriminatedUnion(members: Type[]): boolean {
  if (members.length < 2) return false;
  if (!members.every((m) => m.isObject())) return false;

  const firstProps = members[0].getProperties().map((p) => p.getName());

  for (const propName of firstProps) {
    const allHaveLiteral = members.every((member) => {
      const prop = member.getProperty(propName);
      if (!prop) return false;
      const propType = prop.getValueDeclaration()?.getType();
      if (!propType) return false;
      return propType.isStringLiteral() || propType.isNumberLiteral();
    });

    if (allHaveLiteral) {
      const values = members.map((m) => {
        const prop = m.getProperty(propName);
        return prop?.getValueDeclaration()?.getType()?.getLiteralValue?.();
      });
      if (new Set(values).size === members.length) return true;
    }
  }
  return false;
}
```

**What to analyze:**

1. Get all exported declarations from all source files
2. For exported functions: score each parameter type + return type
3. For exported interfaces/type aliases: score each property type
4. Dimension score = average precision across all exported API types

### 4. Unsoundness Patterns (src/analyzers/unsoundness.ts)

Walk AST and count unsafe patterns:

| Pattern                           | Detection                                     | Severity  |
| --------------------------------- | --------------------------------------------- | --------- |
| `as SomeType`                     | `SyntaxKind.AsExpression`                     | warning   |
| `as any`                          | AsExpression where target is `any`            | error     |
| `as unknown as X`                 | Two nested AsExpressions                      | error     |
| `value!`                          | `SyntaxKind.NonNullExpression`                | warning   |
| `@ts-ignore`                      | Comment contains `@ts-ignore`                 | error     |
| `@ts-expect-error`                | Comment contains `@ts-expect-error`           | info (OK) |
| `JSON.parse()` without validation | CallExpression to JSON.parse, no schema after | warning   |

Scoring: penalties per occurrence, normalized by project size. Start at 100 and subtract.

### 5. Runtime Validation (src/analyzers/runtime-validation.ts)

Check for validation at I/O boundaries:

- **Check package.json deps** for: `zod`, `valibot`, `arktype`, `io-ts`, `yup`, `joi`, `superstruct`, `runtypes`, `typia`, `@effect/schema` → +30 points
- **Count type guard functions** (functions with `is` return predicates) → +20 if any exist
- **Count assertion functions** (`asserts` return type) → +15
- **Count `satisfies` usage** → +10
- **Penalty:** `JSON.parse()` without validation → -5 each (max -25)
- **Penalty:** `fetch()` response cast without validation → -5 each (max -25)

Score = clamp(0, 100, sum).

### 6. Export Quality (src/analyzers/export-quality.ts)

Analyze the public API surface:

- Exported functions with **explicit return type annotations** (not inferred) / total exported functions → 40% of score
- Exported functions with **fully typed parameters** / total → 30%
- `package.json` has `types` or `typings` field → +15
- Exports have JSDoc documentation → +15

Score capped at 100.

---

## Scorer (src/scorer.ts)

```typescript
function computeGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function computeAiReadiness(score: number): string {
  if (score >= 80) return "HIGH";
  if (score >= 60) return "MODERATE";
  if (score >= 40) return "LOW";
  return "POOR";
}
```

Overall score = weighted average of all 6 dimensions using `DEFAULT_WEIGHTS`.

---

## Package Scoring (src/package-scorer.ts)

For `tsguard score <package-name>`:

1. Create a temp directory
2. Write a minimal `package.json` with the target package as a dependency
3. Run `npm install --ignore-scripts --no-audit --no-fund` (resolves full dep tree including `@types/*`)
4. Read target package's `package.json` to find its `types`/`typings` entry point
5. Handle three cases:
   - Package has `types` field → bundled types, best case
   - Package has no types but `@types/<name>` exists → install that too
   - No types at all → report "no types available", score 0
6. Create synthetic `tsconfig.json` with `strict: true`
7. Load with ts-morph, filter analysis to only the target package's `.d.ts` files
8. Run all analyzers EXCEPT strict-config (packages don't have their own tsconfig). Replace strict-config weight with extra weight on export-quality.
9. Clean up temp directory

Also support analyzing a locally installed package by path:

```
tsguard score ./node_modules/@tanstack/react-router
```

This skips the npm install step and just analyzes whatever is at that path.

---

## CLI Interface (src/cli.ts)

```
Usage: tsguard [command] [options]

Commands:
  analyze [path]       Analyze a local TypeScript project (default: .)
  score <package>      Score an npm package (installs to tmp, analyzes .d.ts)

Options:
  --json               Output as JSON
  --min-score <n>      Exit code 1 if score < n (CI gate)
  --verbose            Show per-file breakdown
  --no-color           Disable colors

Examples:
  tsguard                                           # Analyze current directory
  tsguard analyze ./src                             # Analyze specific path
  tsguard score zod                                 # Score npm package
  tsguard score @tanstack/react-router              # Score scoped package
  tsguard score ./node_modules/@tanstack/router-core  # Score local package
  tsguard --json > report.json                      # JSON output
  tsguard --min-score 70                            # CI: fail below 70
```

Terminal output format:

```
  tsguard v0.1.0

  Project: my-project
  Files: 42 analyzed in 1.2s

  ╔═══════════════════════════════════════════╗
  ║  Score: 78/100 (B)                        ║
  ║  AI Agent Readiness: MODERATE             ║
  ╚═══════════════════════════════════════════╝

  Type Precision      ████████████░░░░░░░░  61%  ← most impactful
  Type Coverage       ████████████████░░░░  82%
  Strict Config       ██████████████████░░  90%
  Unsoundness         ██████████████████░░  88%
  Export Quality      ████████████████░░░░  79%
  Runtime Validation  ████████████░░░░░░░░  58%

  Top issues:
   ⚠  src/api.ts:23 — exported getUser() has return type `any`
   ⚠  src/handlers.ts:45 — JSON.parse() without runtime validation
   ⚠  src/utils.ts:12 — double type assertion (as unknown as X)
   ℹ  tsconfig.json — enable noUncheckedIndexedAccess for +12 strict score
```

---

## Test Fixtures

Create small standalone TS projects under `test/fixtures/` with their own `tsconfig.json` and `package.json`.

**test/fixtures/high-precision/src/index.ts:**

```typescript
type Status = "active" | "inactive" | "pending";
type UserId = string & { __brand: "UserId" };
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number };
type ApiPath = `/api/${string}`;

export function getUser(id: UserId): Shape {
  /* ... */
}
export function setStatus(status: Status): void {
  /* ... */
}
export function fetchEndpoint(path: ApiPath): Promise<unknown> {
  /* ... */
}
```

**test/fixtures/low-precision/src/index.ts:**

```typescript
export function getUser(id: string): any {
  return null;
}
export function process(data: any): any {
  return data;
}
export function handle(input: Record<string, any>): void {}
export const config: object = {};
```

**test/fixtures/medium-precision/src/index.ts:**

```typescript
interface User {
  name: string;
  age: number;
}
enum Role {
  Admin = "admin",
  User = "user",
  Guest = "guest",
}
export function getUser(id: number): User {
  return { name: "", age: 0 };
}
export function setRole(role: Role): void {}
```

**test/fixtures/tanstack-style/src/index.ts:**

```typescript
interface RouteConfig<
  TPath extends string,
  TParams extends Record<string, string>,
> {
  path: TPath;
  parse: (raw: string) => TParams;
}
export function createRoute<
  TPath extends string,
  TParams extends Record<string, string>,
>(config: RouteConfig<TPath, TParams>): { path: TPath; params: TParams } {
  return {} as any;
}
```

**test/fixtures/unsound/src/index.ts:**

```typescript
const x = JSON.parse("{}") as { name: string };
const y = x as unknown as number;
const z = x!;
// @ts-ignore
const broken = (undefined as any).foo;
// @ts-expect-error — intentional
const deliberate: number = "string";
```

Each fixture directory needs its own `tsconfig.json` (with varying strictness) and `package.json`.

**Expected scores:**

- `high-precision` → 85+ (A)
- `low-precision` → below 30 (F)
- `medium-precision` → 50-65 (C)
- `tanstack-style` → 70+ (B)
- `unsound` → low unsoundness dimension, other dimensions vary

---

## Implementation Steps

Work through these sequentially. Each builds on the previous.

### Step 1: Scaffolding

Set up the project with pnpm, TypeScript, tsup, vitest. Create all directories and files. Implement `src/types.ts` and `src/constants.ts` fully. Make `pnpm build` and `pnpm test` work with empty stubs.

### Step 2: Project Loader

Implement `src/utils/project-loader.ts` — use `ts-morph` to load a TypeScript project from a path. Handle missing tsconfig.json by creating a default strict config. Return a ts-morph `Project` instance.

### Step 3: Strict Config Analyzer

Implement `src/analyzers/strict-config.ts`. Parse tsconfig, score flags per the `STRICT_FLAGS` table. Write tests against fixture tsconfig files.

### Step 4: Type Coverage Analyzer

Implement `src/analyzers/type-coverage.ts`. Walk identifiers, resolve types, count any vs non-any. Write tests against fixtures.

### Step 5: Type Precision Analyzer

Implement `src/analyzers/type-precision.ts` with `classifyTypePrecision()` and `isDiscriminatedUnion()`. This is the hardest and most important step. Write thorough tests against all fixture types — verify that each `TypePrecisionLevel` is correctly identified. Test that `'active' | 'inactive'` scores higher than `string`. Test that `UserId` branded type scores higher than `string`. Test that discriminated unions are detected.

### Step 6: Unsoundness Detector

Implement `src/analyzers/unsoundness.ts`. Walk AST for type assertions, non-null assertions, `@ts-ignore`. Write tests against the `unsound` fixture.

### Step 7: Runtime Validation Analyzer

Implement `src/analyzers/runtime-validation.ts`. Check package.json deps, count type guards and assertion functions, detect unvalidated JSON.parse/fetch. Write tests.

### Step 8: Export Quality Analyzer

Implement `src/analyzers/export-quality.ts`. Analyze exported API for explicit return types, typed params, JSDoc. Write tests.

### Step 9: Scorer + Orchestrator

Implement `src/scorer.ts` (weighted composite) and `src/analyzer.ts` (runs all analyzers, assembles `AnalysisResult`). Write tests that run end-to-end against fixture projects and verify overall scores land in expected ranges.

### Step 10: CLI + Terminal Output

Implement `src/cli.ts` with commander. Implement `src/utils/format.ts` for the pretty terminal output with bars and colors. Wire `src/index.ts` as entry point. `--json` for machine output, `--min-score` for CI.

### Step 11: Package Scoring

Implement `src/package-scorer.ts`. Support both `tsguard score <npm-name>` (npm install to tmp) and `tsguard score <local-path>` (direct analysis). Handle `@types/*` detection, scoped packages, missing types.

### Step 12: E2E Tests + README

Write e2e tests running the full CLI against fixtures. Verify terminal output format. Verify JSON output schema. Verify `--min-score` exit codes. Write README with usage examples, scoring methodology explanation, and "how to improve your score" guide.

---

## Key Design Decisions

1. **Only analyze exported API surface for type precision.** Internal types matter less — the exported API is what consumers (humans and AI agents) code against.

2. **Use ts-morph, not raw compiler API.** It wraps the TS compiler with methods like `type.isStringLiteral()`, `type.isUnion()`, `type.getUnionTypes()`, `type.getConstraint()`. Saves huge boilerplate.

3. **Score 0-100 per dimension, then weighted average.** Normalized and debuggable.

4. **Actionable output.** Every issue includes file, line, column, and a concrete recommendation.

5. **Exclude node_modules, test files, generated files by default.** Only `.ts` and `.tsx` source files.

---

## Dependencies

```json
{
  "name": "tsguard",
  "version": "0.1.0",
  "description": "TypeScript type-safety and precision analyzer",
  "type": "module",
  "bin": { "tsguard": "./dist/index.js" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "ts-morph": "^25.0.0",
    "picocolors": "^1.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

---

## What "Done" Looks Like

- `npx tsguard` analyzes current directory and prints a scored report
- `npx tsguard score zod` installs zod to tmp, analyzes its .d.ts files, prints score
- `npx tsguard score ./node_modules/@tanstack/react-router` analyzes local package
- Type precision correctly differentiates: `string` < `enum` < `'a' | 'b'` < branded type
- Discriminated unions, constrained generics, and template literal types are detected and scored high
- `--json` outputs machine-readable results
- `--min-score N` works as CI gate
- Tests cover all type classification cases
- README explains scoring methodology
