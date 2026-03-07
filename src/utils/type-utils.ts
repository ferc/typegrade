import { type Type, type Symbol as MorphSymbol, TypeFlags, Node } from "ts-morph";
import type { PrecisionFeatures } from "../types.js";

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 20;

export function analyzePrecision(
  type: Type,
  depth: number = 0,
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

  // Cache by compiler type id
  const {compilerType} = (type as any);
  const typeId: number | undefined = compilerType?.id;
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
      return {
        containsAny: false,
        containsUnknown: false,
        features: ["constrained-generic"],
        reasons: ["constrained generic"],
        score: 65,
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
    return analyzeContainer(type, "Array", depth, visited);
  }

  // Check for known container types: Promise, Set, Map, ReadonlyArray
  const symbolName = type.getSymbol()?.getName();
  if (symbolName === "Promise" || symbolName === "Set" || symbolName === "ReadonlyArray") {
    return analyzeContainer(type, symbolName, depth, visited);
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
  if (members.length === 2 && members.every((m) => m.isBooleanLiteral())) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [],
      reasons: ["boolean (wide primitive)"],
      score: 40,
    };
  }

  const childResults = members.map((m) => analyzePrecision(m, depth + 1, visited));
  const avgScore = childResults.reduce((sum, c) => sum + c.score, 0) / childResults.length;
  let score = Math.round(avgScore);
  const features: string[] = [];
  const reasons: string[] = [];
  const containsAny = childResults.some((c) => c.containsAny);
  const containsUnknown = childResults.some((c) => c.containsUnknown);

  // All literal members bonus
  if (members.every((m) => m.isStringLiteral() || m.isNumberLiteral() || m.isBooleanLiteral())) {
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
  const hasBroadPrimitive = members.some((m) => {
    const f = m.getFlags();
    return Boolean(f & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt));
  });
  const hasBroadObject = members.some((m) => {
    if (!m.isObject()) {return false;}
    const props = m.getProperties();
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
  const childResults = members.map((m) => analyzePrecision(m, depth + 1, visited));
  const avgScore = childResults.reduce((sum, c) => sum + c.score, 0) / childResults.length;
  let score = Math.round(avgScore);
  const features: string[] = [];
  const reasons: string[] = [];
  const containsAny = childResults.some((c) => c.containsAny);
  const containsUnknown = childResults.some((c) => c.containsUnknown);

  // Branded type detection: primitive + object with __brand
  const hasPrimitive = members.some((m) => m.getFlags() & (TypeFlags.String | TypeFlags.Number));
  const hasBrand = members.some(
    (m) =>
      m.isObject() &&
      m.getProperties().some((p) => p.getName().startsWith("__") || p.getName() === "_brand"),
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
  name: string,
  depth: number,
  visited: Map<number, PrecisionFeatures>,
): PrecisionFeatures {
  const typeArgs = type.getTypeArguments();
  if (typeArgs.length === 0) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: [name.toLowerCase()],
      reasons: [`${name} with no type arg`],
      score: 45,
    };
  }

  const child = analyzePrecision(typeArgs[0], depth + 1, visited);
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
  const typeArgs = type.getTypeArguments();
  if (typeArgs.length < 2) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["map"],
      reasons: ["Map with missing type args"],
      score: 45,
    };
  }

  const key = analyzePrecision(typeArgs[0], depth + 1, visited);
  const value = analyzePrecision(typeArgs[1], depth + 1, visited);
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
  const typeArgs = type.getAliasTypeArguments();
  if (typeArgs.length < 2) {
    return {
      containsAny: false,
      containsUnknown: false,
      features: ["record"],
      reasons: ["Record with missing type args"],
      score: 45,
    };
  }

  const key = analyzePrecision(typeArgs[0], depth + 1, visited);
  const value = analyzePrecision(typeArgs[1], depth + 1, visited);
  // Record formula: 10 + 0.35 * key + 0.55 * value, then -15 if key is plain string/number
  let score = Math.round(10 + 0.35 * key.score + 0.55 * value.score);

  const keyFlags = typeArgs[0].getFlags();
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

  const childResults = elements.map((e) => analyzePrecision(e, depth + 1, visited));
  const avgScore = childResults.reduce((sum, c) => sum + c.score, 0) / childResults.length;

  let score = Math.round(20 + avgScore);
  // Fixed-length bonus
  score += 5;
  // Readonly check (via type text heuristic)
  const typeText = type.getText();
  if (typeText.startsWith("readonly ") || typeText.startsWith("Readonly<")) {
    score += 5;
  }

  score = clamp(score);
  const features = ["tuple", ...childResults.flatMap((c) => c.features)];
  return {
    containsAny: childResults.some((c) => c.containsAny),
    containsUnknown: childResults.some((c) => c.containsUnknown),
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

  // Count constrained type params
  const typeParams = getTypeParameters(type);
  let constrainedCount = 0;
  for (const tp of typeParams) {
    const constraint = tp.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown)) {
      constrainedCount++;
    }
  }
  if (constrainedCount > 0) {
    const paramBonus = Math.min(constrainedCount * 5, 15);
    shapeBonus += paramBonus;
    features.push("constrained-generic");
    reasons.push(`+${paramBonus} constrained type params`);
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
        const r = analyzePrecision(propType, depth + 1, visited);
        propResults.push(r);
      }
    }
    if (propResults.length > 0) {
      propertyAvg = propResults.reduce((sum, r) => sum + r.score, 0) / propResults.length;
      containsAny = propResults.some((r) => r.containsAny);
      containsUnknown = propResults.some((r) => r.containsUnknown);
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
    const allPrimitive = properties.every((p) => {
      const t = getPropertyType(p);
      if (!t) {return false;}
      const f = t.getFlags();
      return Boolean(f &
        (TypeFlags.String |
          TypeFlags.Number |
          TypeFlags.Boolean |
          TypeFlags.BigInt |
          TypeFlags.StringLiteral |
          TypeFlags.NumberLiteral |
          TypeFlags.BooleanLiteral));
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
    if (Node.isMappedTypeNode(node)) {features.push("mapped-type");}
    if (Node.isConditionalTypeNode(node)) {features.push("conditional-type");}
    if (Node.isIndexedAccessTypeNode(node)) {features.push("indexed-access");}
    if (Node.isInferTypeNode(node)) {features.push("infer");}
  });
  return features;
}

function detectAdvancedSyntax(declarations: Node[]): { hasAdvancedSyntax: boolean; features: string[] } {
  const features = declarations.flatMap((decl) => detectAdvancedSyntaxInDecl(decl));
  return { hasAdvancedSyntax: features.length > 0, features };
}

function getTypeDeclarations(type: Type): Node[] {
  const nodes: Node[] = [];
  const aliasDecls = type.getAliasSymbol()?.getDeclarations();
  if (aliasDecls) {nodes.push(...aliasDecls);}
  const symDecls = type.getSymbol()?.getDeclarations();
  if (symDecls) {nodes.push(...symDecls);}
  // For instantiated generics, check target type
  const targetType = (type as any).getTargetType?.();
  if (targetType) {
    const targetDecls = targetType.getSymbol?.()?.getDeclarations?.();
    if (targetDecls) {nodes.push(...targetDecls);}
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
  if (members.length < 2) {return false;}
  if (!members.every((m) => m.isObject())) {return false;}

  const firstProps = members[0].getProperties().map((p) => p.getName());

  for (const propName of firstProps) {
    const allHaveLiteral = members.every((member) => {
      const prop = member.getProperty(propName);
      if (!prop) {return false;}
      const decl = prop.getValueDeclaration();
      if (!decl) {return false;}
      const propType = decl.getType();
      return propType.isStringLiteral() || propType.isNumberLiteral();
    });

    if (allHaveLiteral) {
      const values = members.map((member) => {
        const prop = member.getProperty(propName);
        const decl = prop?.getValueDeclaration();
        return decl?.getType()?.getLiteralValue?.();
      });
      if (new Set(values).size === members.length) {return true;}
    }
  }
  return false;
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}
