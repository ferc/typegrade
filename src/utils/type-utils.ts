import { type Symbol as MorphSymbol, Node, type Type, TypeFlags } from "ts-morph";
import type { PrecisionFeatures } from "../types.js";

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 20;

export function analyzePrecision(
  type: Type,
  depth = 0,
  visited = new Map<number, PrecisionFeatures>(),
): PrecisionFeatures {
  if (depth > MAX_DEPTH) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["depth cap"],
      score: 45,
    };
  }

  // Cache by compiler type id (internal ts API, not in public ts.Type)
  const typeId: number | undefined = (type.compilerType as { id?: number }).id;
  if (typeId !== undefined && visited.has(typeId)) {
    return visited.get(typeId)!;
  }

  // Reserve spot to handle circular references
  const placeholder: PrecisionFeatures = {
    containsAny: false,
    containsUnknown: false,
    features: [],
    reasons: [],
    score: 45,
  };
  if (typeId !== undefined) {
    visited.set(typeId, placeholder);
  }

  const result = computePrecision(type, depth, visited);

  if (typeId !== undefined) {
    visited.set(typeId, result);
  }
  return result;
}

function computePrecision(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const flags = type.getFlags();

  // Any
  if (flags & TypeFlags.Any) {
    return { containsAny: true, containsUnknown: false, features: [], reasons: ["any"], score: 0 };
  }

  // Unknown
  if (flags & TypeFlags.Unknown) {
    return {
      containsAny: false,
      containsUnknown: true,
      features: [],
      reasons: ["unknown"],
      score: 25,
    };
  }

  // Never
  if (flags & TypeFlags.Never) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["never"],
      reasons: ["never"],
      score: 90,
    };
  }

  // Void
  if (flags & TypeFlags.Void) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["void"],
      score: 60,
    };
  }

  // Null, undefined
  if (flags & (TypeFlags.Null | TypeFlags.Undefined)) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["null/undefined"],
      score: 30,
    };
  }

  // Literals
  if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral()) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["literal"],
      reasons: ["literal type"],
      score: 85,
    };
  }

  // Template literal
  if (type.isTemplateLiteral()) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["template-literal"],
      reasons: ["template literal type"],
      score: 85,
    };
  }

  // Enum / enum literal
  if (flags & TypeFlags.Enum || flags & TypeFlags.EnumLiteral) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["enum"],
      reasons: ["enum type"],
      score: 70,
    };
  }

  // Type parameter (generic)
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown)) {
      const constraintLevel = classifyConstraint(constraint);
      return {
        containsAny: false,
        containsUnknown: false,
        featureCounts: { [constraintLevel.feature]: 1 },
        features: ["constrained-generic", constraintLevel.feature],
        reasons: [`constrained generic (${constraintLevel.level})`],
        score: constraintLevel.score,
      };
    }
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["unconstrained-generic"],
      reasons: ["unconstrained generic"],
      score: 35,
    };
  }

  // Union types
  if (type.isUnion()) {
    return analyzeUnion(type, depth, visited);
  }

  // Intersection types
  if (type.isIntersection()) {
    return analyzeIntersection(type, depth, visited);
  }

  // Check for Record alias before resolving to object
  const aliasName = type.getAliasSymbol()?.getName();
  if (aliasName === "Record") {
    return analyzeRecord(type, depth, visited);
  }

  // Arrays and tuples
  if (type.isTuple()) {
    return analyzeTuple(type, depth, visited);
  }
  if (type.isArray()) {
    return analyzeContainer(type, depth, visited);
  }

  // Check for known container types: Promise, Set, Map, ReadonlyArray
  const symbolName = type.getSymbol()?.getName();
  if (symbolName === "Promise" || symbolName === "Set" || symbolName === "ReadonlyArray") {
    return analyzeContainer(type, depth, visited);
  }
  if (symbolName === "Map") {
    return analyzeMap(type, depth, visited);
  }

  // Object/interface types
  if (type.isObject() || type.isInterface()) {
    return analyzeObject(type, depth, visited);
  }

  // Wide primitives
  if (flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt)) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["wide primitive"],
      score: 40,
    };
  }

  return {
    containsAny: false,
    containsUnknown: false,
    features: [],
    reasons: ["fallback"],
    score: 40,
  };
}

function analyzeUnion(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const members = type.getUnionTypes();

  // Boolean is internally `true | false` — treat as wide primitive
  if (members.length === 2 && members.every((member) => member.isBooleanLiteral())) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["boolean (wide primitive)"],
      score: 40,
    };
  }

  const childResults = members.map((member) => analyzePrecision(member, depth + 1, visited));
  const avgScore = childResults.reduce((sum, cr) => sum + cr.score, 0) / childResults.length;
  let score = Math.round(avgScore);
  const features: string[] = [];
  const reasons: string[] = [];
  const containsAny = childResults.some((cr) => cr.containsAny);
  const containsUnknown = childResults.some((cr) => cr.containsUnknown);

  // All literal members bonus
  if (
    members.every(
      (member) => member.isStringLiteral() || member.isNumberLiteral() || member.isBooleanLiteral(),
    )
  ) {
    score += 10;
    features.push("literal-union");
    reasons.push("+10 all literal members");
  }

  // Discriminated union bonus
  if (isDiscriminatedUnion(members)) {
    score += 15;
    features.push("discriminated-union");
    reasons.push("+15 discriminated union");
  }

  // Penalties
  if (containsAny) {
    score -= 20;
    reasons.push("-20 member contains any");
  }

  // Mix of broad primitives + broad objects
  const hasBroadPrimitive = members.some((member) => {
    const flags = member.getFlags();
    return Boolean(
      flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt),
    );
  });
  const hasBroadObject = members.some((member) => {
    if (!member.isObject()) {
      return false;
    }
    const props = member.getProperties();
    return props.length === 0;
  });
  if (hasBroadPrimitive && hasBroadObject) {
    score -= 10;
    reasons.push("-10 mix of broad primitives and objects");
  }

  score = clamp(score);
  return { containsAny, containsUnknown, features, reasons, score };
}

function analyzeIntersection(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const members = type.getIntersectionTypes();
  const childResults = members.map((member) => analyzePrecision(member, depth + 1, visited));
  const avgScore = childResults.reduce((sum, cr) => sum + cr.score, 0) / childResults.length;
  let score = Math.round(avgScore);
  const features: string[] = [];
  const reasons: string[] = [];
  const containsAny = childResults.some((cr) => cr.containsAny);
  const containsUnknown = childResults.some((cr) => cr.containsUnknown);

  // Branded type detection: primitive + object with __brand
  const hasPrimitive = members.some(
    (member) => member.getFlags() & (TypeFlags.String | TypeFlags.Number),
  );
  const hasBrand = members.some(
    (member) =>
      member.isObject() &&
      member
        .getProperties()
        .some((prop) => prop.getName().startsWith("__") || prop.getName() === "_brand"),
  );
  if (hasPrimitive && hasBrand) {
    score += 25;
    features.push("branded");
    reasons.push("+25 branded type");
  }

  score = clamp(score);
  return { containsAny, containsUnknown, features, reasons, score };
}

function analyzeContainer(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const name = type.isArray() ? "Array" : (type.getSymbol()?.getName() ?? "Container");
  const [firstArg] = type.getTypeArguments();
  if (!firstArg) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [name.toLowerCase()],
      reasons: [`${name} with no type arg`],
      score: 45,
    };
  }

  const child = analyzePrecision(firstArg, depth + 1, visited);
  // Container formula: 0.35 * 45 + 0.65 * child
  const score = clamp(Math.round(0.35 * 45 + 0.65 * child.score));
  return {
    containsAny: child.containsAny,
    containsUnknown: child.containsUnknown,
    features: [name.toLowerCase(), ...child.features],
    reasons: [`${name}<${child.score}>`, ...child.reasons],
    score,
  };
}

function analyzeMap(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const [mapKeyArg, mapValueArg] = type.getTypeArguments();
  if (!mapKeyArg || !mapValueArg) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["map"],
      reasons: ["Map with missing type args"],
      score: 45,
    };
  }

  const key = analyzePrecision(mapKeyArg, depth + 1, visited);
  const value = analyzePrecision(mapValueArg, depth + 1, visited);
  // Map formula: 15 + 0.25 * key + 0.60 * value
  const score = clamp(Math.round(15 + 0.25 * key.score + 0.6 * value.score));
  return {
    containsAny: key.containsAny || value.containsAny,
    containsUnknown: key.containsUnknown || value.containsUnknown,
    features: ["map", ...key.features, ...value.features],
    reasons: [`Map<${key.score}, ${value.score}>`],
    score,
  };
}

function analyzeRecord(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const [recKeyArg, recValueArg] = type.getAliasTypeArguments();
  if (!recKeyArg || !recValueArg) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["record"],
      reasons: ["Record with missing type args"],
      score: 45,
    };
  }

  const key = analyzePrecision(recKeyArg, depth + 1, visited);
  const value = analyzePrecision(recValueArg, depth + 1, visited);
  // Record formula: 10 + 0.35 * key + 0.55 * value, then -15 if key is plain string/number
  let score = Math.round(10 + 0.35 * key.score + 0.55 * value.score);

  const keyFlags = recKeyArg.getFlags();
  if (keyFlags & (TypeFlags.String | TypeFlags.Number)) {
    score -= 15;
  }

  score = clamp(score);
  return {
    containsAny: key.containsAny || value.containsAny,
    containsUnknown: key.containsUnknown || value.containsUnknown,
    features: ["record", ...key.features, ...value.features],
    reasons: [`Record<${key.score}, ${value.score}>`],
    score,
  };
}

function analyzeTuple(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const elements = type.getTupleElements();
  if (elements.length === 0) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["tuple"],
      reasons: ["empty tuple"],
      score: 65,
    };
  }

  const childResults = elements.map((el) => analyzePrecision(el, depth + 1, visited));
  const avgScore = childResults.reduce((sum, cr) => sum + cr.score, 0) / childResults.length;

  let score = Math.round(20 + avgScore);
  // Fixed-length bonus
  score += 5;
  // Readonly check (via type text heuristic)
  const typeText = type.getText();
  if (typeText.startsWith("readonly ") || typeText.startsWith("Readonly<")) {
    score += 5;
  }

  score = clamp(score);
  const features = ["tuple", ...childResults.flatMap((cr) => cr.features)];
  return {
    containsAny: childResults.some((cr) => cr.containsAny),
    containsUnknown: childResults.some((cr) => cr.containsUnknown),
    features,
    reasons: [`tuple of ${elements.length} elements`],
    score,
  };
}

function analyzeObject(
  type: Type,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const properties = type.getProperties().slice(0, MAX_PROPERTIES);
  const features: string[] = [];
  const reasons: string[] = [];

  // Detect Record-like mapped types: index signature + no named properties
  const indexType = type.getStringIndexType() || type.getNumberIndexType();
  if (indexType && properties.length === 0) {
    const valueResult = analyzePrecision(indexType, depth + 1, visited);
    // Treat as Record<string/number, V>: use Record-like formula
    let score = Math.round(10 + 0.55 * valueResult.score);
    // Penalty for broad key (string/number index = broad key)
    score -= 15;
    score = clamp(score);
    return {
      containsAny: valueResult.containsAny,
      containsUnknown: valueResult.containsUnknown,
      features: ["record-like", ...valueResult.features],
      reasons: [`Record-like index signature (value=${valueResult.score})`],
      score,
    };
  }

  // Check declaration syntax for advanced types
  let shapeBonus = 40;
  const declarations = getTypeDeclarations(type);
  const syntaxResult = detectAdvancedSyntax(declarations);

  if (syntaxResult.hasAdvancedSyntax) {
    features.push(...syntaxResult.features);
    shapeBonus += 10;
    reasons.push("+10 advanced type syntax");
  }

  // Count constrained type params and detect default generics
  const typeParams = getTypeParameters(type);
  let constrainedCount = 0;
  let hasDefaultGeneric = false;
  for (const tp of typeParams) {
    const constraint = tp.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown)) {
      constrainedCount++;
    }
    // Check for default type parameter via declaration nodes
    const tpDecls = tp.getSymbol()?.getDeclarations() ?? [];
    for (const tpDecl of tpDecls) {
      if (Node.isTypeParameterDeclaration(tpDecl) && tpDecl.getDefault()) {
        hasDefaultGeneric = true;
      }
    }
  }
  if (constrainedCount > 0) {
    const paramBonus = Math.min(constrainedCount * 5, 15);
    shapeBonus += paramBonus;
    features.push("constrained-generic");
    reasons.push(`+${paramBonus} constrained type params`);
  }
  if (hasDefaultGeneric) {
    features.push("default-generic-widening");
    reasons.push("has default type parameter");
  }

  // No index signature + reasonable prop count bonus
  if (!indexType && properties.length > 0 && properties.length <= 12) {
    shapeBonus += 10;
    reasons.push("+10 no index signature, shaped object");
  }

  // Score properties recursively
  let propertyAvg = 50;
  let containsAny = false;
  let containsUnknown = false;

  if (properties.length > 0) {
    const propResults: PrecisionFeatures[] = [];
    for (const prop of properties) {
      const propType = getPropertyType(prop);
      if (propType) {
        const result = analyzePrecision(propType, depth + 1, visited);
        propResults.push(result);
      }
    }
    if (propResults.length > 0) {
      propertyAvg = propResults.reduce((sum, pr) => sum + pr.score, 0) / propResults.length;
      containsAny = propResults.some((pr) => pr.containsAny);
      containsUnknown = propResults.some((pr) => pr.containsUnknown);
    }
  }

  // Index signature analysis (for objects that have BOTH properties and index signatures)
  if (indexType) {
    const idxResult = analyzePrecision(indexType, depth + 1, visited);
    if (idxResult.score < 50) {
      shapeBonus -= 15;
      reasons.push("-15 weak index signature");
    }
    containsAny = containsAny || idxResult.containsAny;
    containsUnknown = containsUnknown || idxResult.containsUnknown;
  }

  // Apply containsAny/containsUnknown penalties AFTER all children analyzed
  if (containsAny) {
    shapeBonus -= 25;
    reasons.push("-25 member contains any");
  }
  if (containsUnknown) {
    shapeBonus -= 10;
    reasons.push("-10 member contains unknown");
  }

  // All members primitive with no computed-type syntax
  if (properties.length > 0 && !syntaxResult.hasAdvancedSyntax) {
    const allPrimitive = properties.every((prop) => {
      const propType = getPropertyType(prop);
      if (!propType) {
        return false;
      }
      const propFlags = propType.getFlags();
      return Boolean(
        propFlags &
        (TypeFlags.String |
          TypeFlags.Number |
          TypeFlags.Boolean |
          TypeFlags.BigInt |
          TypeFlags.StringLiteral |
          TypeFlags.NumberLiteral |
          TypeFlags.BooleanLiteral),
      );
    });
    if (allPrimitive) {
      shapeBonus -= 10;
      reasons.push("-10 all primitive members, no computed types");
    }
  }

  shapeBonus = Math.max(0, Math.min(100, shapeBonus));
  const score = clamp(Math.round(20 + 0.6 * propertyAvg + 0.4 * shapeBonus));

  return { containsAny, containsUnknown, features, reasons, score };
}

function detectAdvancedSyntaxInDecl(decl: Node): string[] {
  const features: string[] = [];
  decl.forEachDescendant?.((node) => {
    if (Node.isMappedTypeNode(node)) {
      features.push("mapped-type");
      // Key remapping: mapped type with `as` clause
      if (node.getNameTypeNode()) {
        features.push("key-remapping");
      }
    }
    if (Node.isConditionalTypeNode(node)) {
      features.push("conditional-type");
    }
    if (Node.isIndexedAccessTypeNode(node)) {
      features.push("indexed-access");
    }
    if (Node.isInferTypeNode(node)) {
      features.push("infer");
    }
  });
  return features;
}

function detectAdvancedSyntax(declarations: Node[]): {
  hasAdvancedSyntax: boolean;
  features: string[];
} {
  const features = declarations.flatMap((decl) => detectAdvancedSyntaxInDecl(decl));

  // Recursive type detection: check if a type alias references itself in its body
  for (const decl of declarations) {
    if (Node.isTypeAliasDeclaration(decl)) {
      const aliasName = decl.getName();
      const bodyText = decl.getTypeNode()?.getText() ?? "";
      // Check if the alias name appears as a standalone type reference in the body
      const selfRefPattern = new RegExp(`\\b${aliasName}\\b`);
      if (selfRefPattern.test(bodyText)) {
        features.push("recursive-type");
      }
    }
  }

  return { features, hasAdvancedSyntax: features.length > 0 };
}

function getTypeDeclarations(type: Type): Node[] {
  const nodes: Node[] = [];
  const aliasDecls = type.getAliasSymbol()?.getDeclarations();
  if (aliasDecls) {
    nodes.push(...aliasDecls);
  }
  const symDecls = type.getSymbol()?.getDeclarations();
  if (symDecls) {
    nodes.push(...symDecls);
  }
  // For instantiated generics, check target type
  const targetType = type.getTargetType();
  if (targetType) {
    const targetDecls = targetType.getSymbol()?.getDeclarations();
    if (targetDecls) {
      nodes.push(...targetDecls);
    }
  }
  return nodes;
}

function getTypeParameters(type: Type): Type[] {
  const params: Type[] = [];
  const declarations = getTypeDeclarations(type);
  for (const decl of declarations) {
    if (
      Node.isInterfaceDeclaration(decl) ||
      Node.isTypeAliasDeclaration(decl) ||
      Node.isClassDeclaration(decl)
    ) {
      for (const tp of decl.getTypeParameters()) {
        params.push(tp.getType());
      }
    }
  }
  return params;
}

function getPropertyType(prop: MorphSymbol): Type | undefined {
  const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
  return decl?.getType();
}

export function isDiscriminatedUnion(members: Type[]): boolean {
  if (members.length < 2) {
    return false;
  }
  if (!members.every((member) => member.isObject())) {
    return false;
  }

  const [firstMember] = members;
  if (!firstMember) {
    return false;
  }
  const firstProps = firstMember.getProperties().map((prop) => prop.getName());

  for (const propName of firstProps) {
    const allHaveLiteral = members.every((member) => {
      const prop = member.getProperty(propName);
      if (!prop) {
        return false;
      }
      const decl = prop.getValueDeclaration();
      if (!decl) {
        return false;
      }
      const propType = decl.getType();
      return propType.isStringLiteral() || propType.isNumberLiteral();
    });

    if (allHaveLiteral) {
      const values = members.map((member) => {
        const prop = member.getProperty(propName);
        const decl = prop?.getValueDeclaration();
        return decl?.getType()?.getLiteralValue?.();
      });
      if (new Set(values).size === members.length) {
        return true;
      }
    }
  }
  return false;
}

function classifyConstraint(constraint: Type): { level: string; feature: string; score: number } {
  const flags = constraint.getFlags();

  // Strong: extends a concrete named type (e.g., `<T extends SomeInterface>`)
  if (constraint.isObject() || constraint.isInterface()) {
    const props = constraint.getProperties();
    if (props.length > 0) {
      return { feature: "constraint-strong", level: "strong", score: 70 };
    }
  }

  // Structural: extends `readonly unknown[]`, arrays, tuples
  if (constraint.isArray() || constraint.isTuple()) {
    return { feature: "constraint-structural", level: "structural", score: 68 };
  }
  const constraintText = constraint.getText();
  if (constraintText.includes("readonly") && constraintText.includes("[]")) {
    return { feature: "constraint-structural", level: "structural", score: 68 };
  }

  // Union/intersection constraints
  if (constraint.isUnion() || constraint.isIntersection()) {
    return { feature: "constraint-structural", level: "structural", score: 68 };
  }

  // Basic: extends a wide primitive like `object`, `string`, `number`
  if (flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt)) {
    return { feature: "constraint-basic", level: "basic", score: 62 };
  }

  // `object` constraint
  if (constraintText === "object") {
    return { feature: "constraint-basic", level: "basic", score: 62 };
  }

  // Default: some constraint but not classifiable as strong
  return { feature: "constraint-basic", level: "basic", score: 65 };
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}
