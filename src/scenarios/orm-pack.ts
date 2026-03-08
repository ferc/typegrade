import type { PublicSurface, SurfaceDeclaration } from "../surface/types.js";
import type { ScenarioPack, ScenarioTest } from "./types.js";
import type { ScenarioResult } from "../types.js";

/**
 * ORM scenario pack.
 *
 * Tests how well an ORM library preserves type information
 * from schema definitions through query builders to result types.
 *
 * Rubric per scenario (approximate):
 *   40% compile-success analogue  (surface has declarations matching the pattern)
 *   25% compile-failure analogue  (constraints/narrow types reject wrong usage)
 *   25% inferred-type exactness   (precision features of relevant types)
 *   10% wrong-path prevention     (few ambiguous alternatives)
 */

interface MakeResultOpts {
  name: string;
  passed: boolean;
  reason: string;
  score: number;
}

function makeResult(opts: MakeResultOpts): ScenarioResult {
  return { name: opts.name, passed: opts.passed, reason: opts.reason, score: opts.score };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSchemaRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("schema") ||
    lower.includes("table") ||
    lower.includes("column") ||
    lower.includes("model") ||
    lower.includes("entity") ||
    lower.includes("define") ||
    lower.includes("pgTable") ||
    lower.includes("mysqlTable") ||
    lower.includes("sqliteTable")
  );
}

function isQueryRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("query") ||
    lower.includes("select") ||
    lower.includes("find") ||
    lower.includes("where") ||
    lower.includes("from") ||
    lower.includes("insert") ||
    lower.includes("update") ||
    lower.includes("delete") ||
    lower.includes("builder")
  );
}

function isJoinRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("join") ||
    lower.includes("leftjoin") ||
    lower.includes("innerjoin") ||
    lower.includes("rightjoin") ||
    lower.includes("fulljoin") ||
    lower.includes("relation") ||
    lower.includes("include") ||
    lower.includes("with")
  );
}

function isSelectRelated(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("select") ||
    lower.includes("pick") ||
    lower.includes("column") ||
    lower.includes("returning") ||
    lower.includes("project")
  );
}

/** Check if type params reference each other (correlated generics) */
function hasCorrelatedParams(decl: SurfaceDeclaration): boolean {
  for (const tp of decl.typeParameters) {
    if (!tp.constraintNode) {
      continue;
    }
    const constraintText = tp.constraintNode.getText();
    for (const other of decl.typeParameters) {
      if (other.name !== tp.name && constraintText.includes(other.name)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers: constraint checking (extracted to reduce nesting depth)
// ---------------------------------------------------------------------------

/** Check whether any type parameter's constraint references a schema/table type */
function countSchemaReferencingParams(decl: SurfaceDeclaration): number {
  let count = 0;
  for (const tp of decl.typeParameters) {
    if (!tp.constraintNode) {
      continue;
    }
    const constraintText = tp.constraintNode.getText();
    if (
      constraintText.includes("Table") ||
      constraintText.includes("Schema") ||
      constraintText.includes("Model") ||
      constraintText.includes("Entity")
    ) {
      count++;
    }
  }
  return count;
}

/** Count keyof constraints on type parameters */
function countKeyofConstraints(decl: {
  typeParameters: SurfaceDeclaration["typeParameters"];
}): number {
  let count = 0;
  for (const tp of decl.typeParameters) {
    const constraintText = tp.constraintNode?.getText() ?? "";
    if (constraintText.includes("keyof")) {
      count++;
    }
    // Check for array of keyof
    if (constraintText.includes("Array<keyof") || constraintText.includes("(keyof")) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Scenario 1: Schema to query inference
// ---------------------------------------------------------------------------

const schemaToQueryInference: ScenarioTest = {
  description:
    "Schema/table definitions with typed columns should flow into query builder result types via generics",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let schemaDecls = 0;
    let genericSchemaDecls = 0;
    let queryDecls = 0;
    let genericQueryDecls = 0;
    let schemaWithTypedColumns = 0;
    let queryReferencingSchemaParam = 0;

    for (const decl of surface.declarations) {
      // Schema detection
      if (isSchemaRelated(decl.name)) {
        schemaDecls++;
        if (decl.typeParameters.length > 0) {
          genericSchemaDecls++;
        }

        // Check for typed column definitions (positions with specific types, not just any/unknown)
        const typedPositions = decl.positions.filter((pos) => {
          const text = pos.type.getText();
          return text !== "any" && text !== "unknown" && pos.role === "property";
        });
        if (typedPositions.length > 0) {
          schemaWithTypedColumns++;
        }

        // Check methods for column definitions
        if (decl.methods) {
          const columnMethods = decl.methods.filter((method) => {
            const mn = method.name.toLowerCase();
            return (
              mn.includes("column") ||
              mn.includes("field") ||
              mn.includes("integer") ||
              mn.includes("varchar") ||
              mn.includes("text") ||
              mn.includes("boolean")
            );
          });
          if (columnMethods.length > 0) {
            schemaWithTypedColumns++;
          }
        }
      }

      // Query detection
      if (isQueryRelated(decl.name)) {
        queryDecls++;
        if (decl.typeParameters.length > 0) {
          genericQueryDecls++;
          // Check if query type params reference a table/schema type
          queryReferencingSchemaParam += countSchemaReferencingParams(decl);
        }
      }
    }

    // Also check methods on query builder interfaces
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (isQueryRelated(method.name)) {
          queryDecls++;
          if (method.typeParameters.length > 0) {
            genericQueryDecls++;
          }
        }
      }
    }

    // 40% compile-success: schema + query declarations exist, queries are generic
    let compileScore = 0;
    if (schemaDecls > 0 && genericQueryDecls > 0) {
      compileScore = 40;
    } else if (genericQueryDecls > 0) {
      compileScore = 30;
    } else if (schemaDecls > 0 && queryDecls > 0) {
      compileScore = 20;
    } else if (schemaDecls > 0 || queryDecls > 0) {
      compileScore = 10;
    }

    // 25% compile-failure: constrained query params reference schema types
    let failureScore = 0;
    if (queryReferencingSchemaParam > 0) {
      failureScore += 15;
    }
    if (genericSchemaDecls > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: typed columns in schema
    let exactnessScore = 0;
    if (schemaWithTypedColumns > 0) {
      exactnessScore += 12;
    }
    if (genericQueryDecls >= 3) {
      exactnessScore += 8;
    }
    if (queryReferencingSchemaParam > 0) {
      exactnessScore += 5;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention: few untyped queries
    let wrongPathScore = 0;
    const untypedQueries = queryDecls - genericQueryDecls;
    if (untypedQueries === 0 && queryDecls > 0) {
      wrongPathScore = 10;
    } else if (untypedQueries < queryDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "schemaToQueryInference",
      passed,
      reason: passed
        ? `${schemaDecls} schema defs (${schemaWithTypedColumns} with typed columns), ${genericQueryDecls}/${queryDecls} generic queries, ${queryReferencingSchemaParam} schema-referencing`
        : "Limited schema-to-query type flow",
      score,
    });
  },
  name: "schemaToQueryInference",
};

// ---------------------------------------------------------------------------
// Scenario 2: Join precision
// ---------------------------------------------------------------------------

const joinPrecision: ScenarioTest = {
  description:
    "Join methods should have generic params that combine table types into a merged result, not just any",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let joinDecls = 0;
    let genericJoins = 0;
    let constrainedJoins = 0;
    let multiParamJoins = 0;
    let intersectionReturns = 0;

    for (const decl of surface.declarations) {
      if (!isJoinRelated(decl.name)) {
        continue;
      }
      joinDecls++;
      if (decl.typeParameters.length > 0) {
        genericJoins++;
        if (decl.typeParameters.length >= 2) {
          multiParamJoins++;
        }
        if (decl.typeParameters.some((tp) => tp.hasConstraint)) {
          constrainedJoins++;
        }
        if (hasCorrelatedParams(decl)) {
          constrainedJoins++;
        }
      }

      // Check return type for intersection (&) or merged object types
      for (const pos of decl.positions) {
        if (pos.role !== "return") {
          continue;
        }
        const typeText = pos.type.getText();
        if (
          typeText.includes("&") ||
          typeText.includes("Merge") ||
          typeText.includes("Intersect")
        ) {
          intersectionReturns++;
        }
      }
    }

    // Also check methods on query builder interfaces
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (!isJoinRelated(method.name)) {
          continue;
        }
        joinDecls++;
        if (method.typeParameters.length > 0) {
          genericJoins++;
          if (method.typeParameters.length >= 2) {
            multiParamJoins++;
          }
          if (method.typeParameters.some((tp) => tp.hasConstraint)) {
            constrainedJoins++;
          }
        }
        // Check return type for combined types
        for (const pos of method.positions) {
          if (pos.role !== "return") {
            continue;
          }
          const typeText = pos.type.getText();
          if (typeText.includes("&") || typeText.includes("Merge")) {
            intersectionReturns++;
          }
        }
      }
    }

    if (joinDecls === 0) {
      return makeResult({
        name: "joinPrecision",
        passed: false,
        reason: "No join declarations found",
        score: 30,
      });
    }

    // 40% compile-success: join declarations with generics
    let compileScore = 0;
    if (genericJoins > 0) {
      compileScore = 40;
    } else if (joinDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: constrained joins reject wrong table types
    let failureScore = 0;
    if (constrainedJoins > 0) {
      failureScore += 15;
    }
    if (multiParamJoins > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: intersection returns = precise merge
    let exactnessScore = 0;
    if (intersectionReturns > 0) {
      exactnessScore += 15;
    }
    if (multiParamJoins > 0) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedJoins = joinDecls - genericJoins;
    if (untypedJoins === 0 && joinDecls > 0) {
      wrongPathScore = 10;
    } else if (untypedJoins < joinDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "joinPrecision",
      passed,
      reason: passed
        ? `${genericJoins}/${joinDecls} generic joins, ${multiParamJoins} multi-param, ${intersectionReturns} intersection returns`
        : "Join results lack type precision",
      score,
    });
  },
  name: "joinPrecision",
};

// ---------------------------------------------------------------------------
// Scenario 3: Column narrowing
// ---------------------------------------------------------------------------

const columnNarrowing: ScenarioTest = {
  description:
    "Select methods should narrow result types to selected columns only, using keyof constraints or mapped types",
  evaluate: (surface: PublicSurface): ScenarioResult => {
    let selectDecls = 0;
    let genericSelectDecls = 0;
    let keyofConstraints = 0;
    let pickPatterns = 0;
    let mappedTypeNarrowing = 0;

    for (const decl of surface.declarations) {
      if (!isSelectRelated(decl.name)) {
        continue;
      }
      selectDecls++;

      if (decl.typeParameters.length > 0) {
        genericSelectDecls++;
        // Check for keyof constraints
        keyofConstraints += countKeyofConstraints(decl);
      }

      // Check return type for Pick pattern
      for (const pos of decl.positions) {
        if (pos.role !== "return") {
          continue;
        }
        const typeText = pos.type.getText();
        if (typeText.includes("Pick<") || typeText.includes("Omit<")) {
          pickPatterns++;
        }
      }

      // Check body of type aliases for mapped type narrowing
      if (decl.kind === "type-alias" && decl.bodyTypeNode) {
        const bodyText = decl.bodyTypeNode.getText();
        if (
          bodyText.includes("Pick<") ||
          bodyText.includes("Omit<") ||
          /\[\s*K\s+in\s+/.test(bodyText)
        ) {
          mappedTypeNarrowing++;
        }
      }
    }

    // Also check methods on query builder interfaces
    for (const decl of surface.declarations) {
      if (!decl.methods) {
        continue;
      }
      for (const method of decl.methods) {
        if (!isSelectRelated(method.name)) {
          continue;
        }
        selectDecls++;
        if (method.typeParameters.length > 0) {
          genericSelectDecls++;
          keyofConstraints += countKeyofConstraints(method);
        }
        for (const pos of method.positions) {
          if (pos.role !== "return") {
            continue;
          }
          const typeText = pos.type.getText();
          if (typeText.includes("Pick<") || typeText.includes("Omit<")) {
            pickPatterns++;
          }
        }
      }
    }

    if (selectDecls === 0) {
      return makeResult({
        name: "columnNarrowing",
        passed: false,
        reason: "No select/column declarations found",
        score: 25,
      });
    }

    // 40% compile-success: select declarations with generics
    let compileScore = 0;
    if (genericSelectDecls > 0) {
      compileScore = 40;
    } else if (selectDecls >= 2) {
      compileScore = 15;
    }

    // 25% compile-failure: keyof constraints reject invalid column names
    let failureScore = 0;
    if (keyofConstraints > 0) {
      failureScore += 15;
    }
    if (pickPatterns > 0 || mappedTypeNarrowing > 0) {
      failureScore += 10;
    }
    failureScore = Math.min(25, failureScore);

    // 25% inferred-type exactness: Pick/Omit in return types = precise narrowing
    let exactnessScore = 0;
    if (pickPatterns > 0) {
      exactnessScore += 15;
    }
    if (keyofConstraints > 0) {
      exactnessScore += 10;
    }
    exactnessScore = Math.min(25, exactnessScore);

    // 10% wrong-path prevention
    let wrongPathScore = 0;
    const untypedSelects = selectDecls - genericSelectDecls;
    if (untypedSelects === 0 && selectDecls > 0) {
      wrongPathScore = 10;
    } else if (untypedSelects < selectDecls / 2) {
      wrongPathScore = 5;
    }

    const score = Math.min(100, compileScore + failureScore + exactnessScore + wrongPathScore);
    const passed = score >= 40;

    return makeResult({
      name: "columnNarrowing",
      passed,
      reason: passed
        ? `${genericSelectDecls}/${selectDecls} generic selects, ${keyofConstraints} keyof constraints, ${pickPatterns} Pick patterns`
        : "Select operations lack column narrowing",
      score,
    });
  },
  name: "columnNarrowing",
};

// ---------------------------------------------------------------------------
// Pack export
// ---------------------------------------------------------------------------

export const ORM_PACK: ScenarioPack = {
  description:
    "Tests ORM libraries for schema-to-query inference, join precision, and column narrowing",
  domain: "orm",
  isApplicable: (surface) => {
    const ormNames = [
      "column",
      "migration",
      "table",
      "entity",
      "relation",
      "select",
      "where",
      "join",
    ];
    const matchCount = surface.declarations.filter((decl) =>
      ormNames.some((nm) => decl.name.toLowerCase().includes(nm)),
    ).length;
    const hasBuilderMethods = surface.declarations.some((decl) =>
      (decl.methods ?? []).some((mt) => /^(select|where|join|from)$/.test(mt.name)),
    );
    return {
      applicable: matchCount >= 2 || hasBuilderMethods,
      reason:
        matchCount >= 2 || hasBuilderMethods
          ? "ORM/query patterns detected"
          : "No ORM-related declarations found",
    };
  },
  name: "orm",
  scenarios: [schemaToQueryInference, joinPrecision, columnNarrowing],
};
