import type { Node, Type, TypeNode } from "ts-morph";

/** Role of a type position in the public API */
export type PositionRole =
  | "param"
  | "return"
  | "property"
  | "type-body"
  | "variable"
  | "enum"
  | "getter"
  | "setter-param"
  | "ctor-param"
  | "index-sig"
  | "call-sig"
  | "construct-sig";

export type SurfaceDeclarationKind =
  | "function"
  | "interface"
  | "type-alias"
  | "class"
  | "enum"
  | "variable";

/** A single measurable type position in the public API */
export interface SurfacePosition {
  role: PositionRole;
  name: string;
  declarationName: string;
  declarationKind: SurfaceDeclarationKind;
  type: Type;
  typeNode: TypeNode | undefined;
  node: Node;
  filePath: string;
  line: number;
  column: number;
  weight: number;
}

/** Type parameter metadata */
export interface SurfaceTypeParam {
  name: string;
  hasConstraint: boolean;
  constraintNode: TypeNode | undefined;
}

/** A method in an interface or class */
export interface SurfaceMethod {
  name: string;
  isPrivate: boolean;
  hasJSDoc: boolean;
  hasExplicitReturnType: boolean;
  allParamsTyped: boolean;
  overloadCount: number;
  typeParameters: SurfaceTypeParam[];
  positions: SurfacePosition[];
  paramTypeNodes: Array<{ name: string; typeNode: TypeNode | undefined }>;
  returnTypeNode: TypeNode | undefined;
}

/** A top-level exported declaration */
export interface SurfaceDeclaration {
  kind: SurfaceDeclarationKind;
  name: string;
  filePath: string;
  line: number;
  node: Node;
  hasJSDoc: boolean;
  positions: SurfacePosition[];
  typeParameters: SurfaceTypeParam[];
  // Function-specific
  hasExplicitReturnType?: boolean;
  allParamsTyped?: boolean;
  overloadCount?: number;
  paramTypeNodes?: Array<{ name: string; typeNode: TypeNode | undefined }>;
  returnTypeNode?: TypeNode | undefined;
  // Interface/class-specific
  methods?: SurfaceMethod[];
  // Type-alias specific
  bodyTypeNode?: TypeNode;
}

/** Aggregate stats for the surface */
export interface SurfaceStats {
  totalDeclarations: number;
  totalPositions: number;
  functionCount: number;
  interfaceCount: number;
  classCount: number;
  typeAliasCount: number;
  enumCount: number;
  variableCount: number;
  totalOverloads: number;
  totalMethods: number;
}

/** The full public API surface extracted from source files */
export interface PublicSurface {
  declarations: SurfaceDeclaration[];
  positions: SurfacePosition[];
  stats: SurfaceStats;
}
