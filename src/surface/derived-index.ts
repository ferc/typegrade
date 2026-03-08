import type {
  PublicSurface,
  SurfaceDeclaration,
  SurfaceDeclarationKind,
  SurfaceMethod,
  SurfacePosition,
} from "./types.js";

/** Pre-aggregated counts by declaration kind */
export interface KindCounts {
  function: number;
  interface: number;
  "type-alias": number;
  class: number;
  enum: number;
  variable: number;
}

/** Pre-aggregated position counts by role */
export interface RoleCounts {
  param: number;
  return: number;
  property: number;
  "type-body": number;
  variable: number;
  enum: number;
  getter: number;
  "setter-param": number;
  "ctor-param": number;
  "index-sig": number;
  "call-sig": number;
  "construct-sig": number;
}

/** Pre-aggregated function and method statistics */
export interface FunctionStats {
  /** Total top-level function declarations */
  topLevelFunctions: number;
  /** Total methods across all interfaces and classes */
  totalMethods: number;
  /** Combined: top-level functions + methods */
  allCallables: number;
  /** Total overload count (across functions and methods) */
  totalOverloads: number;
  /** Functions/methods with explicit return types */
  explicitReturnCount: number;
  /** Functions/methods where all params are typed */
  fullyTypedParamCount: number;
  /** Functions/methods with JSDoc */
  jsDocCount: number;
}

/** Pre-aggregated generic parameter statistics */
export interface GenericStats {
  /** Total type parameters across all declarations */
  totalTypeParams: number;
  /** Type params with constraints */
  constrainedCount: number;
  /** Type params without constraints */
  unconstrainedCount: number;
}

/**
 * A derived index computed once from the PublicSurface,
 * providing precomputed aggregates consumed by multiple analyzers.
 */
export interface DerivedSurfaceIndex {
  /** Declaration counts by kind */
  kindCounts: KindCounts;
  /** Position counts by role */
  roleCounts: RoleCounts;
  /** Function and method statistics */
  functionStats: FunctionStats;
  /** Generic parameter statistics */
  genericStats: GenericStats;
  /** All methods extracted from interfaces and classes */
  allMethods: SurfaceMethod[];
  /** Declarations filtered by kind (pre-grouped for quick access) */
  byKind: Record<SurfaceDeclarationKind, SurfaceDeclaration[]>;
  /** Positions grouped by role */
  positionsByRole: Map<string, SurfacePosition[]>;
}

/**
 * Build the derived surface index from a PublicSurface.
 * Called once per analysis run in the orchestrator.
 */
export function buildDerivedIndex(surface: PublicSurface): DerivedSurfaceIndex {
  const kindCounts: KindCounts = {
    class: 0,
    enum: 0,
    function: 0,
    interface: 0,
    "type-alias": 0,
    variable: 0,
  };

  const roleCounts: RoleCounts = {
    "call-sig": 0,
    "construct-sig": 0,
    "ctor-param": 0,
    enum: 0,
    getter: 0,
    "index-sig": 0,
    param: 0,
    property: 0,
    return: 0,
    "setter-param": 0,
    "type-body": 0,
    variable: 0,
  };

  const byKind: Record<SurfaceDeclarationKind, SurfaceDeclaration[]> = {
    class: [],
    enum: [],
    function: [],
    interface: [],
    "type-alias": [],
    variable: [],
  };

  const positionsByRole = new Map<string, SurfacePosition[]>();

  function addPositions(positions: SurfacePosition[]) {
    for (const pos of positions) {
      const { role } = pos;
      roleCounts[role as keyof RoleCounts]++;
      let arr = positionsByRole.get(role);
      if (!arr) {
        arr = [];
        positionsByRole.set(role, arr);
      }
      arr.push(pos);
    }
  }

  const typeParamStats = { constrained: 0, total: 0, unconstrained: 0 };

  function addTypeParams(params: { hasConstraint: boolean }[]) {
    for (const tp of params) {
      typeParamStats.total++;
      if (tp.hasConstraint) {
        typeParamStats.constrained++;
      } else {
        typeParamStats.unconstrained++;
      }
    }
  }

  const allMethods: SurfaceMethod[] = [];
  let topLevelFunctions = 0;
  let totalMethods = 0;
  let totalOverloads = 0;
  let explicitReturnCount = 0;
  let fullyTypedParamCount = 0;
  let jsDocCount = 0;

  for (const decl of surface.declarations) {
    // Kind counts and grouping
    kindCounts[decl.kind]++;
    byKind[decl.kind].push(decl);

    // Position role counts
    addPositions(decl.positions);

    // Type parameter counts
    addTypeParams(decl.typeParameters);

    // Function-specific stats
    if (decl.kind === "function") {
      topLevelFunctions++;
      if (decl.hasExplicitReturnType) {
        explicitReturnCount++;
      }
      if (decl.allParamsTyped) {
        fullyTypedParamCount++;
      }
      if (decl.hasJSDoc) {
        jsDocCount++;
      }
      totalOverloads += decl.overloadCount ?? 0;
    }

    // Collect methods from interfaces and classes
    if (decl.methods) {
      for (const method of decl.methods) {
        allMethods.push(method);
        totalMethods++;
        if (method.hasExplicitReturnType) {
          explicitReturnCount++;
        }
        if (method.allParamsTyped) {
          fullyTypedParamCount++;
        }
        if (method.hasJSDoc) {
          jsDocCount++;
        }
        totalOverloads += method.overloadCount;

        addTypeParams(method.typeParameters);

        addPositions(method.positions);
      }
    }
  }

  return {
    allMethods,
    byKind,
    functionStats: {
      allCallables: topLevelFunctions + totalMethods,
      explicitReturnCount,
      fullyTypedParamCount,
      jsDocCount,
      topLevelFunctions,
      totalMethods,
      totalOverloads,
    },
    genericStats: {
      constrainedCount: typeParamStats.constrained,
      totalTypeParams: typeParamStats.total,
      unconstrainedCount: typeParamStats.unconstrained,
    },
    kindCounts,
    positionsByRole,
    roleCounts,
  };
}
