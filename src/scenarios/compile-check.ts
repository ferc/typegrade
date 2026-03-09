import { Project } from "ts-morph";
import type { PublicSurface } from "../surface/types.js";
import type { ScenarioResult } from "../types.js";

/** A compile-backed test: TypeScript code that should or should not compile */
export interface CompileTest {
  /** Human-readable name */
  name: string;
  /** Code to compile (should succeed if positive, fail if negative) */
  code: string;
  /** Whether this test expects compilation success (true) or failure (false) */
  expectSuccess: boolean;
  /** Description of what this test verifies */
  description: string;
}

/** Result of running a compile test */
export interface CompileTestResult {
  name: string;
  passed: boolean;
  reason: string;
  diagnosticCount: number;
}

/**
 * Run a set of compile tests in an in-memory TypeScript project.
 *
 * Creates a virtual project, adds preamble declarations from the surface,
 * and checks whether each test code compiles or not.
 */
export function runCompileTests(tests: CompileTest[], surface: PublicSurface): CompileTestResult[] {
  const results: CompileTestResult[] = [];

  // Build a preamble from the public surface declarations
  const preamble = buildSurfacePreamble(surface);

  for (const test of tests) {
    const result = runSingleCompileTest(test, preamble);
    results.push(result);
  }

  return results;
}

/**
 * Build TypeScript declaration preamble from the public surface.
 *
 * Creates type stubs that approximate the library's exported API
 * so compile tests can reference them.
 */
function buildSurfacePreamble(surface: PublicSurface): string {
  const lines: string[] = ["// Auto-generated surface preamble"];

  for (const decl of surface.declarations) {
    switch (decl.kind) {
      case "function": {
        const typeParams =
          decl.typeParameters.length > 0
            ? `<${decl.typeParameters
                .map((tp) => {
                  let param = tp.name;
                  if (tp.hasConstraint && tp.constraintText) {
                    param += ` extends ${tp.constraintText}`;
                  }
                  if (tp.hasDefault && tp.defaultText) {
                    param += ` = ${tp.defaultText}`;
                  }
                  return param;
                })
                .join(", ")}>`
            : "";

        const params = decl.positions
          .filter((pos) => pos.role === "param")
          .map((pos) => `${pos.name}: ${pos.type.getText()}`)
          .join(", ");

        const returnType = decl.positions.find((pos) => pos.role === "return");
        const returnText = returnType ? returnType.type.getText() : "void";

        lines.push(`declare function ${decl.name}${typeParams}(${params}): ${returnText};`);
        break;
      }
      case "interface": {
        const typeParams =
          decl.typeParameters.length > 0
            ? `<${decl.typeParameters.map((tp) => tp.name).join(", ")}>`
            : "";
        lines.push(`declare interface ${decl.name}${typeParams} {`);
        if (decl.methods) {
          for (const method of decl.methods) {
            const mTypeParams =
              method.typeParameters.length > 0
                ? `<${method.typeParameters.map((tp) => tp.name).join(", ")}>`
                : "";
            lines.push(`  ${method.name}${mTypeParams}(...args: any[]): any;`);
          }
        }
        lines.push("}");
        break;
      }
      case "type-alias": {
        lines.push(`declare type ${decl.name} = any;`);
        break;
      }
      case "class": {
        lines.push(`declare class ${decl.name} {`);
        lines.push("  constructor(...args: any[]);");
        if (decl.methods) {
          for (const method of decl.methods) {
            lines.push(`  ${method.name}(...args: any[]): any;`);
          }
        }
        lines.push("}");
        break;
      }
      case "variable": {
        lines.push(`declare const ${decl.name}: any;`);
        break;
      }
      case "enum": {
        lines.push(`declare enum ${decl.name} {}`);
        break;
      }
    }
  }

  return lines.join("\n");
}

function runSingleCompileTest(test: CompileTest, preamble: string): CompileTestResult {
  try {
    const project = new Project({
      compilerOptions: {
        module: 99,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 2,
      },
      useInMemoryFileSystem: true,
    });

    // Add preamble
    project.createSourceFile("preamble.d.ts", preamble);

    // Add test code
    project.createSourceFile("test.ts", test.code);

    const diagnostics = project.getPreEmitDiagnostics();
    const diagnosticCount = diagnostics.length;
    const compiledSuccessfully = diagnosticCount === 0;

    const passed = test.expectSuccess ? compiledSuccessfully : !compiledSuccessfully;

    let reason = "";
    if (passed && test.expectSuccess) {
      reason = "Positive example compiled successfully";
    } else if (passed) {
      reason = `Negative example correctly failed (${diagnosticCount} error(s))`;
    } else if (test.expectSuccess) {
      reason = `Positive example failed to compile (${diagnosticCount} error(s))`;
    } else {
      reason = "Negative example unexpectedly compiled";
    }

    return {
      diagnosticCount,
      name: test.name,
      passed,
      reason,
    };
  } catch (error) {
    return {
      diagnosticCount: -1,
      name: test.name,
      passed: false,
      reason: `Compile check error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Score compile test results as part of a scenario evaluation.
 *
 * Returns a partial score (0-100) based on the pass rate
 * and a set of reasons.
 */
export function scoreCompileResults(
  results: CompileTestResult[],
  maxScore: number,
): { score: number; reasons: string[] } {
  if (results.length === 0) {
    return { reasons: ["No compile tests run"], score: 0 };
  }

  const passedCount = results.filter((rr) => rr.passed).length;
  const passRate = passedCount / results.length;
  const score = Math.round(passRate * maxScore);

  const reasons = results.filter((rr) => !rr.passed).map((rr) => `${rr.name}: ${rr.reason}`);

  if (reasons.length === 0) {
    reasons.push(`All ${results.length} compile test(s) passed`);
  }

  return { reasons, score };
}

/**
 * Generate basic compile tests from the public surface.
 *
 * Creates positive tests that verify declared functions can be called
 * with compatible types, and negative tests that verify type errors
 * are caught.
 */
export function generateBasicCompileTests(surface: PublicSurface): CompileTest[] {
  const tests: CompileTest[] = [];

  for (const decl of surface.declarations) {
    if (decl.kind !== "function") {
      continue;
    }

    // Skip if no meaningful type info
    const returnPos = decl.positions.find((pos) => pos.role === "return");
    if (!returnPos) {
      continue;
    }

    const returnText = returnPos.type.getText();

    // Only generate tests for functions with non-trivial return types
    if (returnText === "any" || returnText === "void" || returnText === "never") {
      continue;
    }

    // Positive: calling the function should work with correct types
    tests.push({
      code: `const result = ${decl.name}(${generateArgStubs(decl)});\nconst _check: ${returnText} = result;`,
      description: `${decl.name} should return ${returnText}`,
      expectSuccess: true,
      name: `positive-${decl.name}-return`,
    });

    // Negative: wrong return type assignment
    const wrongType = returnText === "string" ? "number" : "string";
    tests.push({
      code: `const result = ${decl.name}(${generateArgStubs(decl)});\nconst _check: ${wrongType} = result;`,
      description: `${decl.name} return should not be assignable to ${wrongType}`,
      expectSuccess: false,
      name: `negative-${decl.name}-wrong-type`,
    });
  }

  // Limit to avoid slow compile checks
  return tests.slice(0, 20);
}

function generateArgStubs(decl: {
  positions: { role: string; type: { getText(): string } }[];
}): string {
  const params = decl.positions.filter((pos) => pos.role === "param");
  return params
    .map((param) => {
      const typeText = param.type.getText();
      if (typeText === "string") {
        return '"test"';
      }
      if (typeText === "number") {
        return "0";
      }
      if (typeText === "boolean") {
        return "true";
      }
      if (typeText === "unknown") {
        return "undefined as unknown";
      }
      // Default: use any-casted undefined
      return "undefined as any";
    })
    .join(", ");
}

/** Options for creating a compile-backed scenario result */
export interface CompileBackedResultOpts {
  scenarioName: string;
  heuristicScore: number;
  compileResults: CompileTestResult[];
  compileWeight?: number;
}

/**
 * Create a compile-backed ScenarioResult from compile tests.
 */
export function compileBackedResult(opts: CompileBackedResultOpts): ScenarioResult {
  const { compileResults, heuristicScore, scenarioName } = opts;
  const compileWeight = opts.compileWeight ?? 0.3;
  const heuristicWeight = 1 - compileWeight;

  const { reasons, score: compileScore } = scoreCompileResults(compileResults, 100);

  const combinedScore = Math.round(heuristicScore * heuristicWeight + compileScore * compileWeight);
  const passed = combinedScore >= 40;

  const reason = passed
    ? `Heuristic: ${heuristicScore}, compile: ${compileScore} (${compileResults.filter((rr) => rr.passed).length}/${compileResults.length} passed)`
    : (reasons[0] ?? "Combined score below threshold");

  return {
    name: scenarioName,
    passed,
    reason,
    score: combinedScore,
  };
}
