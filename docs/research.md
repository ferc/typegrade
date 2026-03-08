# typegrade — Implementation Plan

## What This Is

A fast CLI tool that scores TypeScript projects and npm packages on **type precision quality** — not just "do you have types?" but "how narrow, specific, and useful are your types for AI agents and humans?"

This is a greenfield project. Start from scratch.

## Tech Stack

- **Language:** TypeScript (for the proof-of-concept / Phase 1)
- **Parser + Type Checker:** TypeScript Compiler API (`typescript` package)
- **AST Helper:** `ts-morph` (wraps the TS compiler API with a friendlier interface)
- **CLI Framework:** `commander` or `citty`
- **Output:** Terminal (colored), JSON, optional badge SVG
- **Package Manager:** pnpm
- **Build:** tsup (fast, zero-config bundler for TS libraries)
- **Test:** vitest

> **Why TypeScript first, not Go?** Fastest path to a working prototype. The TS compiler API gives full type resolution for free. Once the scoring model is validated, Phase 2 rewrites the hot path in Go using `typescript-go`. Don't optimize prematurely.

---

## Project Structure

```
typegrade/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts                  # CLI entry point
│   ├── cli.ts                    # CLI argument parsing, output formatting
│   ├── analyzer.ts               # Main orchestrator — runs all analyzers, produces final score
│   ├── scorer.ts                 # Weighted composite scoring logic
│   ├── types.ts                  # All shared TypeScript types/interfaces for the project
│   ├── analyzers/
│   │   ├── type-coverage.ts      # Dimension 1: any/unknown coverage
│   │   ├── strict-config.ts      # Dimension 2: tsconfig strictness
│   │   ├── type-precision.ts     # Dimension 3: type narrowness/specificity (THE KEY ONE)
│   │   ├── unsoundness.ts        # Dimension 4: unsafe pattern detection
│   │   ├── runtime-validation.ts # Dimension 5: Zod/Valibot/io-ts at boundaries
│   │   └── export-quality.ts     # Dimension 6: exported API surface analysis
│   ├── utils/
│   │   ├── project-loader.ts     # Load a TS project via ts-morph
│   │   ├── type-utils.ts         # Helpers: resolve type, classify type, compute precision
│   │   └── format.ts             # Terminal coloring, bar rendering, JSON output
│   └── constants.ts              # Scoring weights, precision values, flag lists
├── test/
│   ├── fixtures/                 # Small .ts files with known type qualities
│   │   ├── high-precision.ts     # Literal unions, branded types, discriminated unions
│   │   ├── low-precision.ts      # string, number, any everywhere
│   │   ├── medium-precision.ts   # Mix of wide and narrow types
│   │   ├── tanstack-style.ts     # Constrained generics, template literals
│   │   ├── unsound-patterns.ts   # Type assertions, non-null assertions
│   │   └── tsconfig-fixtures/    # Various tsconfig.json files with different strictness
│   ├── type-precision.test.ts
│   ├── strict-config.test.ts
│   ├── unsoundness.test.ts
│   ├── scorer.test.ts
│   └── e2e.test.ts               # Full CLI runs against fixture projects
└── scripts/
    └── score-popular-packages.ts  # Script to run typegrade against top npm packages for calibration
```

---

## Core Types (src/types.ts)

Define these first. Everything else implements against them.

```typescript
/** The precision level of a single resolved type */
export type TypePrecisionLevel =
  | "any" // 0 points - no information
  | "unknown" // 5 points - intentional opaque boundary
  | "wide-primitive" // 10 points - string, number, boolean, object
  | "primitive-union" // 15 points - string | number
  | "interface" // 18 points - named object shape
  | "generic-unbound" // 12 points - unconstrained generic <T>
  | "generic-bound" // 22 points - constrained generic <T extends Base>
  | "enum" // 20 points - string or numeric enum
  | "literal" // 25 points - specific literal: 'active', 42, true
  | "literal-union" // 28 points - 'a' | 'b' | 'c'
  | "template-literal" // 27 points - `prefix-${string}`
  | "branded" // 30 points - string & { __brand: 'X' }
  | "discriminated-union" // 30 points - { kind: 'a', ... } | { kind: 'b', ... }
  | "never"; // special - used for exhaustiveness

/** Result from a single analyzer dimension */
export interface DimensionResult {
  name: string;
  score: number; // 0-100
  weight: number; // 0-1, sums to 1 across all dimensions
  details: string[]; // Human-readable findings
  issues: Issue[]; // Actionable problems found
}

export interface Issue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  dimension: string;
}

/** Final analysis result */
export interface AnalysisResult {
  projectName: string;
  filesAnalyzed: number;
  timeMs: number;
  overallScore: number; // 0-100
  grade: string; // A+, A, B, C, D, F
  dimensions: DimensionResult[];
  topIssues: Issue[]; // Top 10 most impactful issues
  aiReadiness: "HIGH" | "MODERATE" | "LOW" | "POOR";
}

/** Configuration for scoring weights and thresholds */
export interface TsguardConfig {
  weights: {
    typeCoverage: number; // default 0.15
    strictConfig: number; // default 0.15
    typePrecision: number; // default 0.30 (THE MOST IMPORTANT)
    unsoundness: number; // default 0.15
    runtimeValidation: number; // default 0.10
    exportQuality: number; // default 0.15
  };
  include: string[];
  exclude: string[];
  thresholds: {
    literalUnionMaxMembers: number; // default 50, beyond this is a smell
    minScore: number; // default 0, CI fail threshold
  };
}
```

---

## Dimension Details — What Each Analyzer Does

### Dimension 1: Type Coverage (src/analyzers/type-coverage.ts)

Walk every identifier in the project. For each one, resolve its type via the checker. Classify it.

```
Score = (identifiers_not_any / total_identifiers) × 100
```

**Implementation:**

1. Use `ts-morph`'s `project.getSourceFiles()` to iterate files
2. For each source file, walk all `Identifier` nodes
3. Call `node.getType()` to get the resolved type
4. Check `type.getFlags()` — if `TypeFlags.Any`, it's uncovered
5. Distinguish explicit `any` (annotation) from implicit `any` (inference failure)
6. Count `unknown` separately as a positive signal

**Edge cases:**

- Ignore `catch (e)` — TypeScript types this as `unknown` in strict, `any` in non-strict
- Ignore `node_modules` — only analyze project source
- Count `as any` separately from parameter-level `any`

---

### Dimension 2: Strict Config (src/analyzers/strict-config.ts)

Parse `tsconfig.json` and score which strict flags are enabled.

**Implementation:**

1. Use `ts-morph`'s `project.compilerOptions` or directly read/parse `tsconfig.json`
2. Check each flag, assign points:

```typescript
const STRICT_FLAGS: Record<string, number> = {
  strict: 10, // umbrella — enables many below
  noImplicitAny: 10,
  strictNullChecks: 15, // most impactful single flag
  strictFunctionTypes: 10,
  strictBindCallApply: 5,
  strictPropertyInitialization: 5,
  noImplicitReturns: 8,
  noFallthroughCasesInSwitch: 5,
  noUncheckedIndexedAccess: 12, // very underused, very valuable
  exactOptionalPropertyTypes: 10,
  noImplicitOverride: 5,
  isolatedModules: 3,
  verbatimModuleSyntax: 2,
};
// Max possible: 100. Score = sum of enabled flags.
```

3. Bonus: check if `@ts-expect-error` is used instead of `@ts-ignore` (+5 bonus, capped at 100)
4. Penalty: if `skipLibCheck: true` and project has few `@types/*` deps, small penalty

---

### Dimension 3: Type Precision (src/analyzers/type-precision.ts)

**This is the core differentiator. This is the novel part.**

Analyze every exported function/method/variable and score the **narrowness** of its parameter types and return types.

**Implementation:**

1. Get all exported declarations from all source files
2. For each exported function:
   a. Get each parameter's resolved type
   b. Get the return type (explicit or inferred)
   c. Classify each type using the precision hierarchy
   d. Score it
3. For each exported interface/type alias:
   a. Walk each property's type
   b. Classify and score
4. Compute average precision across all exported API surface

**The classification function (the heart of the tool):**

```typescript
function classifyTypePrecision(type: Type): TypePrecisionLevel {
  const flags = type.getFlags();

  // any
  if (flags & TypeFlags.Any) return "any";

  // unknown
  if (flags & TypeFlags.Unknown) return "unknown";

  // never (exhaustiveness)
  if (flags & TypeFlags.Never) return "never";

  // Check if it's a union first
  if (type.isUnion()) {
    const members = type.getUnionTypes();

    // Check for discriminated union:
    // All members are object types with a common property whose type is a literal
    if (isDiscriminatedUnion(members)) return "discriminated-union";

    // Check if all members are string/number literals
    if (
      members.every(
        (m) =>
          m.isStringLiteral() || m.isNumberLiteral() || m.isBooleanLiteral(),
      )
    ) {
      return "literal-union";
    }

    // Mixed primitive union (string | number)
    return "primitive-union";
  }

  // Literal types
  if (
    type.isStringLiteral() ||
    type.isNumberLiteral() ||
    type.isBooleanLiteral()
  ) {
    return "literal";
  }

  // Template literal types
  if (type.isTemplateLiteral?.()) return "template-literal";

  // Check for branded types: intersection of primitive + object with __brand
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
            (p) =>
              p.getName().startsWith("__") ||
              p.getName() === "_brand" ||
              p.getName() === "__brand",
          ),
    );
    if (hasPrimitive && hasBrand) return "branded";
  }

  // Enum
  if (flags & TypeFlags.Enum || flags & TypeFlags.EnumLiteral) return "enum";

  // Generic type parameters
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown)) {
      return "generic-bound";
    }
    return "generic-unbound";
  }

  // Object/interface types
  if (type.isObject() || type.isInterface()) return "interface";

  // Wide primitives
  if (
    flags &
    (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt)
  ) {
    return "wide-primitive";
  }

  // Fallback
  return "wide-primitive";
}
```

**Detecting discriminated unions:**

```typescript
function isDiscriminatedUnion(members: Type[]): boolean {
  if (members.length < 2) return false;
  if (!members.every((m) => m.isObject())) return false;

  // Find common properties across all members
  const firstProps = members[0].getProperties().map((p) => p.getName());

  for (const propName of firstProps) {
    // Check if this property exists in ALL members with a literal type
    const allHaveLiteral = members.every((member) => {
      const prop = member.getProperty(propName);
      if (!prop) return false;
      const propType =
        prop.getValueDeclaration()?.getType() ?? prop.getDeclaredType?.();
      if (!propType) return false;
      return propType.isStringLiteral() || propType.isNumberLiteral();
    });

    // Check that the literal values are all DIFFERENT (actual discriminant)
    if (allHaveLiteral) {
      const values = members.map((member) => {
        const prop = member.getProperty(propName);
        const propType = prop?.getValueDeclaration()?.getType();
        return propType?.getLiteralValue?.();
      });
      const uniqueValues = new Set(values);
      if (uniqueValues.size === members.length) return true;
    }
  }

  return false;
}
```

**Scoring formula for type precision:**

```typescript
const PRECISION_SCORES: Record<TypePrecisionLevel, number> = {
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
  never: 90, // exhaustiveness signal
};

// Dimension score = average precision of all exported API types
```

---

### Dimension 4: Unsoundness Patterns (src/analyzers/unsoundness.ts)

Count occurrences of patterns that bypass the type system.

**What to detect (via AST walking):**

| Pattern                           | How to detect                                          | Severity  |
| --------------------------------- | ------------------------------------------------------ | --------- |
| `as SomeType`                     | `SyntaxKind.AsExpression`                              | warning   |
| `as any`                          | AsExpression where target type is `any`                | error     |
| `as unknown as X`                 | Two nested AsExpressions                               | error     |
| `<SomeType>value`                 | `SyntaxKind.TypeAssertionExpression`                   | warning   |
| `value!`                          | `SyntaxKind.NonNullExpression`                         | warning   |
| `@ts-ignore`                      | Comment text contains `@ts-ignore`                     | error     |
| `@ts-expect-error`                | Comment text contains `@ts-expect-error`               | info (OK) |
| `JSON.parse()` without validation | CallExpression to JSON.parse, no Zod/guard after       | warning   |
| `Object.keys()` without narrowing | CallExpression to Object.keys, used without type guard | info      |
| `delete obj.prop` on required     | Delete expression on non-optional property             | warning   |

**Scoring:**

```
penalty_per_error = 2.0 points
penalty_per_warning = 0.5 points
penalty_per_info = 0.1 points

raw_penalty = sum of all penalties
max_penalty = filesAnalyzed * 10  // normalize by project size

score = max(0, 100 - (raw_penalty / max_penalty) * 100)
```

---

### Dimension 5: Runtime Validation (src/analyzers/runtime-validation.ts)

Check whether the project validates data at I/O boundaries.

**Implementation:**

1. **Detect validation library usage:** Check `package.json` dependencies for: `zod`, `valibot`, `arktype`, `io-ts`, `yup`, `joi`, `superstruct`, `runtypes`, `typia`, `@effect/schema`
2. **Detect validation at boundaries:** Look for patterns where:
   - `fetch()` calls are followed by schema validation (`.parse()`, `.safeParse()`, `.validate()`)
   - `JSON.parse()` results are validated
   - Express/Fastify route handlers use validation middleware
3. **Detect type guards:** Count functions with `is` return type predicates
4. **Detect assertion functions:** Count functions with `asserts` return type
5. **Detect `satisfies` operator usage:** `SyntaxKind.SatisfiesExpression` (TS 4.9+)

**Scoring:**

```
hasValidationLib = +30 points
typeGuardCount > 0 = +20 points
assertFunctionCount > 0 = +15 points
satisfiesUsage > 0 = +10 points
fetchWithoutValidation penalty = -5 per occurrence (max -25)
jsonParseWithoutValidation penalty = -5 per occurrence (max -25)

score = clamp(0, 100, sum of above)
```

---

### Dimension 6: Export Quality (src/analyzers/export-quality.ts)

Analyze the public API surface specifically.

**Implementation:**

1. Get all exported functions, classes, interfaces, type aliases, variables
2. For each exported function:
   - Does it have an **explicit return type annotation**? (not inferred)
   - Are all parameters explicitly typed?
   - Does it use JSDoc `@param` / `@returns` tags?
3. For each exported interface/type:
   - Does it have JSDoc on the type itself?
   - Are property types narrow or wide?
4. Check `package.json` for `types` or `typings` field (bundled types = good)
5. Check if `@types/*` is used (community types = weaker signal)

**Scoring:**

```
exportedFnsWithExplicitReturn / totalExportedFns * 40
exportedFnsFullyTypedParams / totalExportedFns * 30
hasTypesFieldInPackageJson = +15
hasJSDocOnExports = +15

score = sum, capped at 100
```

---

## CLI Interface (src/cli.ts)

```
Usage: typegrade [command] [options]

Commands:
  analyze [path]       Analyze a local TypeScript project (default: .)
  score <package>      Analyze an npm package by name (future)
  init                 Create a .typegraderc.json with default config

Options:
  --json               Output as JSON
  --format <fmt>       Output format: terminal (default), json, markdown
  --min-score <n>      Exit with code 1 if score < n (for CI)
  --config <path>      Path to config file
  --include <glob>     Files to include
  --exclude <glob>     Files to exclude
  --verbose            Show per-file breakdown
  --no-color           Disable colored output

Examples:
  typegrade                          # Analyze current directory
  typegrade analyze ./src            # Analyze specific path
  typegrade --json > report.json     # JSON output
  typegrade --min-score 70           # CI gate: fail below 70
```

---

## Implementation Order (Give These to Claude Code as Tasks)

### Task 1: Project Scaffolding

Set up the project with pnpm, TypeScript, tsup, vitest. Create all directories and stub files. Create `src/types.ts` with all the types defined above. Create `src/constants.ts` with all the scoring constants. Make sure `pnpm build` and `pnpm test` work (even if tests are empty).

**Acceptance:** `pnpm build` produces a working `dist/index.js`. `pnpm test` runs vitest and passes.

### Task 2: Project Loader + Strict Config Analyzer

Build `src/utils/project-loader.ts` — use `ts-morph` to load a TypeScript project from a path. Handle missing tsconfig.json gracefully. Build `src/analyzers/strict-config.ts` — parse tsconfig and score strictness flags. Create test fixtures with different tsconfig files. Write tests.

**Acceptance:** Given a path with a tsconfig.json, returns a `DimensionResult` with correct score. Test with `strict: true` (should score high), `{}` empty config (should score low), and a mixed config.

### Task 3: Type Coverage Analyzer

Build `src/analyzers/type-coverage.ts`. Walk all identifiers, resolve types, count `any` vs non-`any`. Write test fixtures: a file with all explicit types, a file with `any` everywhere, a file with mixed.

**Acceptance:** A file with no `any` scores 100. A file with 50% `any` scores ~50.

### Task 4: Type Precision Analyzer (THE MOST IMPORTANT TASK)

Build `src/analyzers/type-precision.ts` with the `classifyTypePrecision` function and `isDiscriminatedUnion` helper.

Create these test fixtures:

```typescript
// test/fixtures/high-precision.ts
type Status = "active" | "inactive" | "pending"; // literal-union
type UserId = string & { __brand: "UserId" }; // branded

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }; // discriminated-union

type ApiPath = `/api/${string}`; // template-literal

function getUser(id: UserId): Shape {
  /* ... */
}

// test/fixtures/low-precision.ts
function getUser(id: string): object {
  /* ... */
}
function process(data: any): any {
  /* ... */
}
function handle(input: Record<string, any>): void {
  /* ... */
}

// test/fixtures/medium-precision.ts
interface User {
  name: string;
  age: number;
}
function getUser(id: number): User {
  /* ... */
}
enum Role {
  Admin,
  User,
  Guest,
}
function setRole(role: Role): void {
  /* ... */
}

// test/fixtures/tanstack-style.ts
function createRoute<
  TPath extends string,
  TParams extends Record<string, string>,
>(config: {
  path: TPath;
  parse: (raw: string) => TParams;
}): Route<TPath, TParams> {
  // constrained generics
}
```

**Acceptance:**

- `high-precision.ts` scores > 85
- `low-precision.ts` scores < 30
- `medium-precision.ts` scores between 45-65
- `tanstack-style.ts` scores > 70 (constrained generics detected)
- The `classifyTypePrecision` function correctly identifies all `TypePrecisionLevel` variants
- `isDiscriminatedUnion` correctly identifies `Shape` as discriminated and `User` as not

### Task 5: Unsoundness Pattern Detector

Build `src/analyzers/unsoundness.ts`. Walk AST looking for type assertions, non-null assertions, `@ts-ignore`, double casts.

Test fixture:

```typescript
// test/fixtures/unsound-patterns.ts
const x = JSON.parse("{}") as User; // as assertion
const y = input as unknown as SpecificType; // double assertion
const z = maybeNull!.property; // non-null assertion
// @ts-ignore
const broken = something.wrong;
// @ts-expect-error
const intentional = something.deliberate; // this one is OK
```

**Acceptance:** Detects all 4 bad patterns, does NOT flag `@ts-expect-error` as error.

### Task 6: Runtime Validation Analyzer

Build `src/analyzers/runtime-validation.ts`. Check package.json for validation libraries. Walk AST for validation patterns. Count type guards and assertion functions.

**Acceptance:** A project with `zod` in deps and `.parse()` calls scores higher than a project with raw `JSON.parse()` + cast.

### Task 7: Export Quality Analyzer

Build `src/analyzers/export-quality.ts`. Analyze exported API surface for explicit return types, parameter type quality, JSDoc.

**Acceptance:** A module with fully annotated explicit return types scores higher than one relying entirely on inference.

### Task 8: Scorer + Orchestrator

Build `src/scorer.ts` — takes all `DimensionResult[]`, applies weights, computes final score and grade. Build `src/analyzer.ts` — orchestrates all analyzers, produces `AnalysisResult`.

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

**Acceptance:** End-to-end: give it a fixture project path, get back a complete `AnalysisResult` with all 6 dimensions scored.

### Task 9: CLI + Terminal Output

Build `src/cli.ts` with `commander`. Build `src/utils/format.ts` for pretty terminal output.

The terminal output should look like this:

```
  typegrade v0.1.0

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
   ⚠  src/api.ts:23 — exported function getUser has return type `any`
   ⚠  src/handlers.ts:45 — JSON.parse() without runtime validation
   ⚠  src/utils.ts:12 — double type assertion (as unknown as X)
   ℹ  tsconfig.json — enable noUncheckedIndexedAccess for +12 strict score
```

Build `src/index.ts` as the entry point that wires CLI to analyzer.

**Acceptance:** `pnpm build && node dist/index.js analyze test/fixtures/sample-project` produces the formatted output above. `--json` flag outputs valid JSON. `--min-score 90` exits with code 1 for projects scoring below 90.

### Task 10: E2E Tests + Polish

Write e2e tests that run the full CLI against fixture projects and assert on output. Create a `test/fixtures/sample-project/` directory that is a complete mini TS project with tsconfig.json, package.json, and source files of varying quality.

Test scenarios:

1. A "fortress" project (strict config, branded types, Zod validation) → A+
2. A "bare minimum" project (no strict, all string/any) → D or F
3. A "typical" project (strict: true, interfaces, some any) → B or C

**Acceptance:** All e2e tests pass. README.md has usage examples. `npx typegrade` works.

---

## Scoring Weights (src/constants.ts)

```typescript
export const DEFAULT_WEIGHTS = {
  typePrecision: 0.3, // Most important — the novel part
  typeCoverage: 0.15,
  strictConfig: 0.15,
  unsoundness: 0.15,
  exportQuality: 0.15,
  runtimeValidation: 0.1,
} as const;
```

Type Precision gets the highest weight because it's what no other tool measures and what matters most for AI agent code quality.

---

## Key Design Decisions

1. **Only analyze exported API surface for type precision.** Internal types matter less — the exported API is what consumers (humans and AI agents) code against. Internal code is covered by the coverage and unsoundness analyzers.

2. **Use ts-morph, not raw compiler API.** ts-morph wraps the TS compiler API with methods like `type.isStringLiteral()`, `type.isUnion()`, `type.getUnionTypes()`, `type.isIntersection()`, `type.getConstraint()` etc. This saves enormous boilerplate vs. working with raw `TypeFlags` bitmasks.

3. **Score 0-100 per dimension, then weighted average.** Every dimension is normalized to 0-100 before the weighted composite. This keeps the scoring consistent and debuggable.

4. **Actionable output.** Every issue includes file, line, column, and a concrete recommendation. The tool should tell you what to DO, not just what's wrong.

5. **Fast by default.** Exclude `node_modules`, test files, and generated files by default. Only analyze `.ts` and `.tsx` files. Use ts-morph's lazy loading where possible.

6. **Config file is optional.** Everything works with sensible defaults. A `.typegraderc.json` can override weights and thresholds.

---

## Dependencies (package.json)

```json
{
  "name": "typegrade",
  "version": "0.1.0",
  "description": "TypeScript type-safety and precision analyzer for the AI agent era",
  "bin": {
    "typegrade": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "oxlint ."
  },
  "dependencies": {
    "commander": "^13.0.0",
    "ts-morph": "^25.0.0",
    "picocolors": "^1.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.0.0",
    "vitest": "^3.0.0",
    "oxlint": "^0.16.0"
  }
}
```

---

## What "Done" Looks Like for Phase 1

- [ ] `npx typegrade` analyzes the current directory and prints a score
- [ ] Score is reproducible — same input always gives same output
- [ ] All 6 dimensions produce meaningful scores
- [ ] Type precision correctly differentiates: `string` < `'a' | 'b'` < branded type
- [ ] Discriminated unions are detected and scored high
- [ ] Constrained generics score higher than unconstrained
- [ ] Template literal types are detected
- [ ] `--json` outputs machine-readable results
- [ ] `--min-score N` works as CI gate
- [ ] Test suite covers all type precision classification cases
- [ ] README explains the tool, scoring methodology, and how to improve scores

---

## Future (Not Phase 1 — Don't Build Yet)

- Go rewrite using `typescript-go` for 10x speed
- `typegrade score <npm-package>` — download and analyze npm packages
- Badge SVG generation for READMEs
- GitHub Action
- VS Code extension
- Public leaderboard website
- Auto-generate AGENTS.md from analysis results
- Oxlint plugin with "agent-ready" preset rules
- `typegrade fix` — auto-apply improvements (add explicit return types, suggest Zod schemas)
