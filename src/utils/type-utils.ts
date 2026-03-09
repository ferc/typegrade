import { type Symbol as MorphSymbol, Node, type Type, TypeFlags } from "ts-morph";
import type { PrecisionFeatures } from "../types.js";

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 20;
const MAX_ANY_PATHS = 3;
const NODE_MODULES_SEGMENT = "/node_modules/";

interface PrecisionCtx {
  depth: number;
  visited: Map<number, PrecisionFeatures>;
  path: string[];
}

function childCtx(ctx: PrecisionCtx, segment: string): PrecisionCtx {
  return { depth: ctx.depth + 1, path: [...ctx.path, segment], visited: ctx.visited };
}

export function analyzePrecision(
  type: Type,
  depth = 0,
  visited = new Map<number, PrecisionFeatures>(),
): PrecisionFeatures {
  return analyzePrecisionWithPath(type, { depth, path: [], visited });
}

function analyzePrecisionWithPath(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
  if (ctx.depth > MAX_DEPTH) {
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
  if (typeId !== undefined && ctx.visited.has(typeId)) {
    return ctx.visited.get(typeId)!;
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
    ctx.visited.set(typeId, placeholder);
  }

  const result = computePrecision(type, ctx);

  if (typeId !== undefined) {
    ctx.visited.set(typeId, result);
  }
  return result;
}

function computePrecision(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
  const flags = type.getFlags();

  // Any
  if (flags & TypeFlags.Any) {
    const anyPath = [...ctx.path, "any"];
    const origin = resolveAnyOrigin(type);
    return {
      ...(origin ? { anyOrigin: origin } : {}),
      anyPaths: [anyPath],
      containsAny: true,
      containsUnknown: false,
      features: [],
      reasons: ["any"],
      score: 0,
    };
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
    return analyzeUnion(type, ctx);
  }

  // Intersection types
  if (type.isIntersection()) {
    return analyzeIntersection(type, ctx);
  }

  // Check for Record alias before resolving to object
  const aliasName = type.getAliasSymbol()?.getName();
  if (aliasName === "Record") {
    return analyzeRecord(type, ctx);
  }

  // Arrays and tuples
  if (type.isTuple()) {
    return analyzeTuple(type, ctx);
  }
  if (type.isArray()) {
    return analyzeContainer(type, ctx);
  }

  // Check for known container types: Promise, Set, Map, ReadonlyArray
  const symbolName = type.getSymbol()?.getName();
  if (symbolName === "Promise" || symbolName === "Set" || symbolName === "ReadonlyArray") {
    return analyzeContainer(type, ctx);
  }
  if (symbolName === "Map") {
    return analyzeMap(type, ctx);
  }

  // Object/interface types
  if (type.isObject() || type.isInterface()) {
    return analyzeObject(type, ctx);
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

function analyzeUnion(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
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

  const childResults = members.map((member, idx) =>
    analyzePrecisionWithPath(member, childCtx(ctx, `|${idx}`)),
  );
  const avgScore = childResults.reduce((sum, cr) => sum + cr.score, 0) / childResults.length;
  let score = Math.round(avgScore);
  const features: string[] = [];
  const reasons: string[] = [];
  const anyMemberCount = childResults.filter((cr) => cr.containsAny).length;
  const containsAny = anyMemberCount > 0;
  const containsUnknown = childResults.some((cr) => cr.containsUnknown);
  const unionAnyDensity = childResults.length > 0 ? anyMemberCount / childResults.length : 0;

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

  // Density-proportional any penalty
  if (containsAny) {
    const anyPenalty = Math.round(20 * unionAnyDensity);
    score -= anyPenalty;
    reasons.push(`-${anyPenalty} any density (${anyMemberCount}/${childResults.length})`);
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
  return {
    ...collectAnyMeta(childResults),
    ...(childResults.length > 0 ? { anyDensity: unionAnyDensity } : {}),
    containsAny,
    containsUnknown,
    features,
    reasons,
    score,
  };
}

function analyzeIntersection(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
  const members = type.getIntersectionTypes();
  const childResults = members.map((member, idx) =>
    analyzePrecisionWithPath(member, childCtx(ctx, `&${idx}`)),
  );
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
  return {
    ...collectAnyMeta(childResults),
    containsAny,
    containsUnknown,
    features,
    reasons,
    score,
  };
}

function analyzeContainer(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
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

  const child = analyzePrecisionWithPath(firstArg, childCtx(ctx, "[element]"));
  // Container formula: 0.35 * 45 + 0.65 * child
  const score = clamp(Math.round(0.35 * 45 + 0.65 * child.score));
  const origin = child.anyOrigin ?? (child.containsAny ? resolveTypeOrigin(type) : undefined);
  return {
    ...(origin ? { anyOrigin: origin } : {}),
    ...(child.anyPaths ? { anyPaths: child.anyPaths } : {}),
    containsAny: child.containsAny,
    containsUnknown: child.containsUnknown,
    features: [name.toLowerCase(), ...child.features],
    reasons: [`${name}<${child.score}>`, ...child.reasons],
    score,
  };
}

function analyzeMap(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
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

  const key = analyzePrecisionWithPath(mapKeyArg, childCtx(ctx, "[key]"));
  const value = analyzePrecisionWithPath(mapValueArg, childCtx(ctx, "[value]"));
  // Map formula: 15 + 0.25 * key + 0.60 * value
  const score = clamp(Math.round(15 + 0.25 * key.score + 0.6 * value.score));
  return {
    ...collectAnyMeta([key, value]),
    containsAny: key.containsAny || value.containsAny,
    containsUnknown: key.containsUnknown || value.containsUnknown,
    features: ["map", ...key.features, ...value.features],
    reasons: [`Map<${key.score}, ${value.score}>`],
    score,
  };
}

function analyzeRecord(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
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

  const key = analyzePrecisionWithPath(recKeyArg, childCtx(ctx, "[key]"));
  const value = analyzePrecisionWithPath(recValueArg, childCtx(ctx, "[value]"));
  // Record formula: 10 + 0.35 * key + 0.55 * value, then -15 if key is plain string/number
  let score = Math.round(10 + 0.35 * key.score + 0.55 * value.score);

  const keyFlags = recKeyArg.getFlags();
  if (keyFlags & (TypeFlags.String | TypeFlags.Number)) {
    score -= 15;
  }

  score = clamp(score);
  return {
    ...collectAnyMeta([key, value]),
    containsAny: key.containsAny || value.containsAny,
    containsUnknown: key.containsUnknown || value.containsUnknown,
    features: ["record", ...key.features, ...value.features],
    reasons: [`Record<${key.score}, ${value.score}>`],
    score,
  };
}

function analyzeTuple(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
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

  const childResults = elements.map((el, idx) =>
    analyzePrecisionWithPath(el, childCtx(ctx, `[${idx}]`)),
  );
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
    ...collectAnyMeta(childResults),
    containsAny: childResults.some((cr) => cr.containsAny),
    containsUnknown: childResults.some((cr) => cr.containsUnknown),
    features,
    reasons: [`tuple of ${elements.length} elements`],
    score,
  };
}

function analyzeObject(type: Type, ctx: PrecisionCtx): PrecisionFeatures {
  const properties = type.getProperties().slice(0, MAX_PROPERTIES);
  const features: string[] = [];
  const reasons: string[] = [];

  // Detect Record-like mapped types: index signature + no named properties
  const indexType = type.getStringIndexType() || type.getNumberIndexType();
  if (indexType && properties.length === 0) {
    const valueResult = analyzePrecisionWithPath(indexType, childCtx(ctx, "[index]"));
    // Treat as Record<string/number, V>: use Record-like formula
    let score = Math.round(10 + 0.55 * valueResult.score);
    // Penalty for broad key (string/number index = broad key)
    score -= 15;
    score = clamp(score);
    return {
      ...(valueResult.anyOrigin ? { anyOrigin: valueResult.anyOrigin } : {}),
      ...(valueResult.anyPaths ? { anyPaths: valueResult.anyPaths } : {}),
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
  let anyCount = 0;
  let unknownCount = 0;
  const allPropResults: PrecisionFeatures[] = [];

  if (properties.length > 0) {
    const propResults: PrecisionFeatures[] = [];
    for (const prop of properties) {
      const propType = getPropertyType(prop);
      if (propType) {
        const result = analyzePrecisionWithPath(propType, childCtx(ctx, `.${prop.getName()}`));
        propResults.push(result);
        if (result.containsAny) {
          anyCount++;
        } else if (result.containsUnknown) {
          unknownCount++;
        }
      }
    }
    if (propResults.length > 0) {
      propertyAvg = propResults.reduce((sum, pr) => sum + pr.score, 0) / propResults.length;
      containsAny = anyCount > 0;
      containsUnknown = unknownCount > 0;
      allPropResults.push(...propResults);
    }
  }

  // Index signature analysis (for objects that have BOTH properties and index signatures)
  if (indexType) {
    const idxResult = analyzePrecisionWithPath(indexType, childCtx(ctx, "[index]"));
    if (idxResult.score < 50) {
      shapeBonus -= 15;
      reasons.push("-15 weak index signature");
    }
    if (idxResult.containsAny) {
      anyCount++;
    } else if (idxResult.containsUnknown) {
      unknownCount++;
    }
    containsAny = containsAny || idxResult.containsAny;
    containsUnknown = containsUnknown || idxResult.containsUnknown;
    allPropResults.push(idxResult);
  }

  // Apply density-proportional containsAny/containsUnknown penalties
  const totalChildren = allPropResults.length;
  const objAnyDensity = totalChildren > 0 ? anyCount / totalChildren : 0;
  const objUnknownDensity = totalChildren > 0 ? unknownCount / totalChildren : 0;

  if (objAnyDensity > 0) {
    const anyPenalty = Math.round(25 * objAnyDensity);
    shapeBonus -= anyPenalty;
    reasons.push(`-${anyPenalty} any density (${anyCount}/${totalChildren})`);
  }
  if (objUnknownDensity > 0) {
    const unknownPenalty = Math.round(10 * objUnknownDensity);
    shapeBonus -= unknownPenalty;
    reasons.push(`-${unknownPenalty} unknown density (${unknownCount}/${totalChildren})`);
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

  const anyMeta = collectAnyMeta(allPropResults);
  // If any was found in children but no origin detected, check the parent type itself
  const finalOrigin = anyMeta.anyOrigin ?? (containsAny ? resolveTypeOrigin(type) : undefined);

  return {
    ...anyMeta,
    ...(finalOrigin ? { anyOrigin: finalOrigin } : {}),
    ...(totalChildren > 0 ? { anyDensity: objAnyDensity } : {}),
    containsAny,
    containsUnknown,
    features,
    reasons,
    score,
    ...(totalChildren > 0 ? { unknownDensity: objUnknownDensity } : {}),
  };
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

/**
 * Collect anyPaths and anyOrigin from child results, capped at MAX_ANY_PATHS.
 */
function collectAnyMeta(
  children: PrecisionFeatures[],
): Pick<PrecisionFeatures, "anyOrigin" | "anyPaths"> {
  const paths: string[][] = [];
  let origin: PrecisionFeatures["anyOrigin"] = undefined;
  for (const child of children) {
    if (child.anyPaths) {
      for (const ap of child.anyPaths) {
        if (paths.length < MAX_ANY_PATHS) {
          paths.push(ap);
        }
      }
    }
    if (!origin && child.anyOrigin) {
      origin = child.anyOrigin;
    }
  }
  return {
    ...(origin ? { anyOrigin: origin } : {}),
    ...(paths.length > 0 ? { anyPaths: paths } : {}),
  };
}

/**
 * When a type is `any`, check its declaration source to detect dependency origin.
 * Note: bare `any` is intrinsic and has no useful declarations, so this only
 * catches explicitly aliased `any` types. Container-level origin detection
 * in analyzeObject/analyzeContainer handles the common case.
 */
function resolveAnyOrigin(type: Type): PrecisionFeatures["anyOrigin"] {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (!symbol) {
    return undefined;
  }
  for (const decl of symbol.getDeclarations()) {
    const filePath = decl.getSourceFile().getFilePath();
    if (filePath.includes(NODE_MODULES_SEGMENT)) {
      return { packageName: extractPackageFromPath(filePath), sourceFilePath: filePath };
    }
  }
  return undefined;
}

/**
 * Check if a type is declared in node_modules and return its origin info.
 */
function resolveTypeOrigin(type: Type): PrecisionFeatures["anyOrigin"] {
  const declarations = getTypeDeclarations(type);
  for (const decl of declarations) {
    const filePath = decl.getSourceFile().getFilePath();
    if (filePath.includes(NODE_MODULES_SEGMENT)) {
      return { packageName: extractPackageFromPath(filePath), sourceFilePath: filePath };
    }
  }
  return undefined;
}

/**
 * Extract package name from a node_modules file path.
 */
function extractPackageFromPath(filePath: string): string | undefined {
  const nmIdx = filePath.lastIndexOf("node_modules/");
  if (nmIdx === -1) {
    return undefined;
  }
  const afterNm = filePath.slice(nmIdx + "node_modules/".length);
  if (afterNm.startsWith("@")) {
    const parts = afterNm.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  const slashIdx = afterNm.indexOf("/");
  return slashIdx > 0 ? afterNm.slice(0, slashIdx) : afterNm;
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}
