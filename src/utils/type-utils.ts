import { Type, TypeFlags } from "ts-morph";
import type { TypePrecisionLevel } from "../types.js";
import { PRECISION_SCORES } from "../constants.js";

export function classifyTypePrecision(type: Type): TypePrecisionLevel {
  const flags = type.getFlags();

  if (flags & TypeFlags.Any) return "any";
  if (flags & TypeFlags.Unknown) return "unknown";
  if (flags & TypeFlags.Never) return "never";

  // Unions — check subtypes
  if (type.isUnion()) {
    const members = type.getUnionTypes();

    // `boolean` is internally `true | false` — treat as wide primitive
    if (
      members.length === 2 &&
      members.every((m) => m.isBooleanLiteral())
    ) {
      return "wide-primitive";
    }

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
  if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral()) {
    return "literal";
  }

  // Template literal types
  if (type.isTemplateLiteral()) return "template-literal";

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
            (p) =>
              p.getName().startsWith("__") || p.getName() === "_brand",
          ),
    );
    if (hasPrimitive && hasBrand) return "branded";
  }

  // Enums
  if (flags & TypeFlags.Enum || flags & TypeFlags.EnumLiteral) return "enum";

  // Generics
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    if (constraint && !(constraint.getFlags() & TypeFlags.Unknown)) {
      return "generic-bound";
    }
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

  // Void, null, undefined
  if (flags & (TypeFlags.Void | TypeFlags.Null | TypeFlags.Undefined)) {
    return "wide-primitive";
  }

  return "wide-primitive";
}

export function isDiscriminatedUnion(members: Type[]): boolean {
  if (members.length < 2) return false;
  if (!members.every((m) => m.isObject())) return false;

  const firstProps = members[0].getProperties().map((p) => p.getName());

  for (const propName of firstProps) {
    const allHaveLiteral = members.every((member) => {
      const prop = member.getProperty(propName);
      if (!prop) return false;
      const decl = prop.getValueDeclaration();
      if (!decl) return false;
      const propType = decl.getType();
      return propType.isStringLiteral() || propType.isNumberLiteral();
    });

    if (allHaveLiteral) {
      const values = members.map((member) => {
        const prop = member.getProperty(propName);
        const decl = prop?.getValueDeclaration();
        return decl?.getType()?.getLiteralValue?.();
      });
      if (new Set(values).size === members.length) return true;
    }
  }
  return false;
}

export function getPrecisionScore(level: TypePrecisionLevel): number {
  return PRECISION_SCORES[level];
}
