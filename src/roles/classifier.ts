import type { CentralityWeight, ExportRole, RoleClassification } from "../types.js";
import type { PublicSurface, SurfaceDeclaration } from "../surface/types.js";

const SCHEMA_CONSTRUCTOR_PATTERN =
  /schema|type|object|string|number|boolean|array|tuple|union|intersect|literal|enum|optional|nullable|pipe|transform/i;

const DSL_BUILDER_PATTERN = /builder|chain|pipe|flow|compose/i;

const QUERY_BUILDER_PATTERN = /query|select|where|from|join|orderBy|groupBy|having/i;

const STATE_PRIMITIVE_PATTERN = /store|atom|signal|ref|computed|derived|selector|slice|state/i;

const TRANSPORT_BOUNDARY_PATTERN =
  /handler|middleware|endpoint|route|controller|resolver|procedure/i;

const NAVIGATION_HELPER_PATTERN = /router|route|link|navigate|redirect|outlet|loader|action/i;

const PUBLIC_CONSTRUCTOR_PATTERN = /^create|^make|^build|^new|^init|^setup|^define|^configure/i;

const INTERNAL_HELPER_PATTERN = /^_|internal|private|impl$/i;

const CENTRALITY_BY_ROLE: Record<ExportRole, number> = {
  "ancillary-helper": 0.5,
  "dsl-builder": 1.4,
  "internal-helper": 0.3,
  "navigation-helper": 1,
  "public-constructor": 1.5,
  "query-builder": 1.3,
  "schema-constructor": 1.3,
  "state-primitive": 1.2,
  "transport-boundary": 1.1,
  "type-utility": 0.9,
  "ui-component": 0.8,
};

function hasBuilderPattern(decl: SurfaceDeclaration): boolean {
  const { methods } = decl;
  if (!methods || methods.length === 0) {
    return false;
  }

  // Count methods whose return type text includes the declaration name (builder pattern)
  const returnTypeCounts = new Map<string, number>();
  for (const method of methods) {
    const { returnTypeNode } = method;
    if (returnTypeNode) {
      const text = returnTypeNode.getText();
      returnTypeCounts.set(text, (returnTypeCounts.get(text) ?? 0) + 1);
    }
  }

  // Check if any return type appears 3+ times
  for (const count of returnTypeCounts.values()) {
    if (count >= 3) {
      return true;
    }
  }
  return false;
}

function hasPropsParam(decl: SurfaceDeclaration): boolean {
  return decl.positions.some((pos) => pos.role === "param" && /props/i.test(pos.declarationName));
}

function hasReturnTypeReference(decl: SurfaceDeclaration, pattern: RegExp): boolean {
  const { returnTypeNode } = decl;
  if (returnTypeNode) {
    return pattern.test(returnTypeNode.getText());
  }
  return false;
}

export function classifyDeclarationRole(decl: SurfaceDeclaration): RoleClassification {
  const { kind, methods, name, typeParameters } = decl;
  const hasTypeParams = typeParameters.length > 0;
  const hasMethods = (methods?.length ?? 0) > 0;

  // 1. Schema-constructor
  if (
    hasTypeParams &&
    (SCHEMA_CONSTRUCTOR_PATTERN.test(name) || hasReturnTypeReference(decl, /Schema|Type/))
  ) {
    return { confidence: 0.85, reasons: ["schema-constructor-match"], role: "schema-constructor" };
  }

  // 2. DSL-builder
  if ((hasMethods && hasBuilderPattern(decl)) || DSL_BUILDER_PATTERN.test(name)) {
    return { confidence: 0.8, reasons: ["dsl-builder-match"], role: "dsl-builder" };
  }

  // 3. Query-builder
  if (QUERY_BUILDER_PATTERN.test(name) && hasMethods) {
    return { confidence: 0.8, reasons: ["query-builder-match"], role: "query-builder" };
  }

  // 4. State-primitive
  if (STATE_PRIMITIVE_PATTERN.test(name) && (kind === "function" || kind === "variable")) {
    return { confidence: 0.75, reasons: ["state-primitive-match"], role: "state-primitive" };
  }

  // 5. Transport-boundary
  if (TRANSPORT_BOUNDARY_PATTERN.test(name)) {
    return { confidence: 0.75, reasons: ["transport-boundary-match"], role: "transport-boundary" };
  }

  // 6. Navigation-helper
  if (NAVIGATION_HELPER_PATTERN.test(name) && (kind === "function" || kind === "variable")) {
    return { confidence: 0.7, reasons: ["navigation-helper-match"], role: "navigation-helper" };
  }

  // 7. UI-component
  if (/^[A-Z]/.test(name) && kind === "function" && hasPropsParam(decl)) {
    return { confidence: 0.7, reasons: ["ui-component-match"], role: "ui-component" };
  }

  // 8. Type-utility
  if (kind === "type-alias" && hasTypeParams) {
    return { confidence: 0.7, reasons: ["type-utility-match"], role: "type-utility" };
  }

  // 9. Public-constructor
  if (kind === "function" && PUBLIC_CONSTRUCTOR_PATTERN.test(name)) {
    return { confidence: 0.75, reasons: ["public-constructor-match"], role: "public-constructor" };
  }

  // 10. Internal-helper
  if (name.startsWith("_") || INTERNAL_HELPER_PATTERN.test(name)) {
    return { confidence: 0.85, reasons: ["internal-helper-match"], role: "internal-helper" };
  }

  // 11. Ancillary-helper
  if (kind === "function" && !hasTypeParams && !hasMethods && decl.positions.length <= 4) {
    return { confidence: 0.6, reasons: ["ancillary-helper-match"], role: "ancillary-helper" };
  }

  // 12. Default fallback
  return { confidence: 0.5, reasons: ["default-fallback"], role: "public-constructor" };
}

export function classifyPublicSurface(surface: PublicSurface): CentralityWeight[] {
  const weights: CentralityWeight[] = [];

  for (const decl of surface.declarations) {
    const classification = classifyDeclarationRole(decl);
    let centrality = CENTRALITY_BY_ROLE[classification.role];

    // Boost generics by 1.2x
    if (decl.typeParameters.length > 0) {
      centrality *= 1.2;
    }

    weights.push({
      centralityWeight: centrality,
      declarationName: decl.name,
      isEntrypoint: false,
      isReexported: false,
      role: classification.role,
    });
  }

  return weights;
}

export function computeRoleBreakdown(
  weights: CentralityWeight[],
): { role: ExportRole; count: number; avgCentrality: number }[] {
  const grouped = new Map<ExportRole, { count: number; total: number }>();

  for (const wt of weights) {
    const existing = grouped.get(wt.role);
    if (existing) {
      existing.count += 1;
      existing.total += wt.centralityWeight;
    } else {
      grouped.set(wt.role, { count: 1, total: wt.centralityWeight });
    }
  }

  const result: { role: ExportRole; count: number; avgCentrality: number }[] = [];
  for (const [role, stats] of grouped) {
    result.push({
      avgCentrality: stats.total / stats.count,
      count: stats.count,
      role,
    });
  }

  // Sort by count descending
  result.sort((aa, bb) => bb.count - aa.count);
  return result;
}
