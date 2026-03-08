import type {
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  MethodSignature,
  Node,
  SourceFile,
  Type,
  TypeAliasDeclaration,
  TypeNode,
  TypeParameterDeclaration,
  VariableDeclaration,
  VariableStatement,
} from "ts-morph";
import type {
  PublicSurface,
  SurfaceDeclaration,
  SurfaceDeclarationKind,
  SurfaceMethod,
  SurfacePosition,
  SurfaceStats,
  SurfaceTypeParam,
} from "./types.js";

export function extractPublicSurface(sourceFiles: SourceFile[]): PublicSurface {
  const declarations: SurfaceDeclaration[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      declarations.push(extractFunction(fn, filePath));
    }

    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      declarations.push(extractInterface(iface, filePath));
    }

    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) {continue;}
      declarations.push(extractTypeAlias(alias, filePath));
    }

    for (const cls of sf.getClasses()) {
      if (!cls.isExported()) {continue;}
      declarations.push(extractClass(cls, filePath));
    }

    for (const en of sf.getEnums()) {
      if (!en.isExported()) {continue;}
      declarations.push(extractEnum(en, filePath));
    }

    for (const varStmt of sf.getVariableStatements()) {
      if (!varStmt.isExported()) {continue;}
      for (const decl of varStmt.getDeclarations()) {
        declarations.push(extractVariable(decl, varStmt, filePath));
      }
    }
  }

  const positions = declarations.flatMap((d) => d.positions);
  const stats = computeStats(declarations);

  return { declarations, positions, stats };
}

// --- Helpers ---

function nodeLocation(node: Node): { line: number; column: number } {
  return {
    column: node.getStart() - node.getStartLinePos() + 1,
    line: node.getStartLineNumber(),
  };
}

function makePosition(
  node: Node,
  role: SurfacePosition["role"],
  name: string,
  declarationName: string,
  declarationKind: SurfaceDeclarationKind,
  filePath: string,
  weight: number,
): SurfacePosition {
  const loc = nodeLocation(node);
  const typed = node as unknown as { getType(): Type; getTypeNode?: () => TypeNode | undefined };
  return {
    column: loc.column,
    declarationKind,
    declarationName,
    filePath,
    line: loc.line,
    name,
    node,
    role,
    type: typed.getType(),
    typeNode: typed.getTypeNode?.(),
    weight,
  };
}

function makeReturnPosition(
  owner: Node,
  returnType: Type,
  returnTypeNode: TypeNode | undefined,
  declarationName: string,
  declarationKind: SurfaceDeclarationKind,
  filePath: string,
  weight: number,
): SurfacePosition {
  const loc = nodeLocation(owner);
  return {
    column: loc.column,
    declarationKind,
    declarationName,
    filePath,
    line: loc.line,
    name: "return",
    node: owner,
    role: "return",
    type: returnType,
    typeNode: returnTypeNode,
    weight,
  };
}

function extractTypeParams(params: TypeParameterDeclaration[]): SurfaceTypeParam[] {
  return params.map((tp) => ({
    constraintNode: tp.getConstraint(),
    hasConstraint: tp.getConstraint() !== undefined,
    name: tp.getName(),
  }));
}

// --- Extractors ---

function extractFunction(fn: FunctionDeclaration, filePath: string): SurfaceDeclaration {
  const name = fn.getName() ?? "<anonymous>";
  const positions: SurfacePosition[] = [];

  for (const param of fn.getParameters()) {
    positions.push(makePosition(param, "param", param.getName(), name, "function", filePath, 1.0));
  }

  positions.push(
    makeReturnPosition(fn, fn.getReturnType(), fn.getReturnTypeNode(), name, "function", filePath, 1.25),
  );

  const overloads = fn.getOverloads();
  return {
    allParamsTyped: fn.getParameters().every((p) => p.getTypeNode() !== undefined),
    filePath,
    hasExplicitReturnType: fn.getReturnTypeNode() !== undefined,
    hasJSDoc: fn.getJsDocs().length > 0,
    kind: "function",
    line: fn.getStartLineNumber(),
    name,
    node: fn,
    overloadCount: overloads.length,
    paramTypeNodes: fn.getParameters().map((p) => ({
      name: p.getName(),
      typeNode: p.getTypeNode(),
    })),
    positions,
    returnTypeNode: fn.getReturnTypeNode(),
    typeParameters: extractTypeParams(fn.getTypeParameters()),
  };
}

function extractInterface(iface: InterfaceDeclaration, filePath: string): SurfaceDeclaration {
  const name = iface.getName();
  const positions: SurfacePosition[] = [];

  for (const prop of iface.getProperties()) {
    positions.push(makePosition(prop, "property", prop.getName(), name, "interface", filePath, 0.75));
  }

  const methods: SurfaceMethod[] = [];
  for (const method of iface.getMethods()) {
    methods.push(extractMethodSignature(method, name, filePath));
  }

  return {
    filePath,
    hasJSDoc: iface.getJsDocs().length > 0,
    kind: "interface",
    line: iface.getStartLineNumber(),
    methods,
    name,
    node: iface,
    positions,
    typeParameters: extractTypeParams(iface.getTypeParameters()),
  };
}

function extractMethodSignature(method: MethodSignature, parentName: string, filePath: string): SurfaceMethod {
  const name = method.getName();
  const qualifiedName = `${parentName}.${name}`;
  const positions: SurfacePosition[] = [];

  for (const param of method.getParameters()) {
    positions.push(makePosition(param, "param", param.getName(), qualifiedName, "interface", filePath, 1.0));
  }

  positions.push(
    makeReturnPosition(method, method.getReturnType(), method.getReturnTypeNode(), qualifiedName, "interface", filePath, 1.25),
  );

  return {
    allParamsTyped: method.getParameters().every((p) => p.getTypeNode() !== undefined),
    hasExplicitReturnType: method.getReturnTypeNode() !== undefined,
    hasJSDoc: method.getJsDocs().length > 0,
    isPrivate: false,
    name,
    overloadCount: 0,
    paramTypeNodes: method.getParameters().map((p) => ({
      name: p.getName(),
      typeNode: p.getTypeNode(),
    })),
    positions,
    returnTypeNode: method.getReturnTypeNode(),
    typeParameters: extractTypeParams(method.getTypeParameters()),
  };
}

function extractTypeAlias(alias: TypeAliasDeclaration, filePath: string): SurfaceDeclaration {
  const name = alias.getName();
  const loc = nodeLocation(alias);

  const positions: SurfacePosition[] = [
    {
      column: loc.column,
      declarationKind: "type-alias",
      declarationName: name,
      filePath,
      line: loc.line,
      name,
      node: alias,
      role: "type-body",
      type: alias.getType(),
      typeNode: alias.getTypeNode(),
      weight: 0.75,
    },
  ];

  return {
    bodyTypeNode: alias.getTypeNode(),
    filePath,
    hasJSDoc: alias.getJsDocs().length > 0,
    kind: "type-alias",
    line: loc.line,
    name,
    node: alias,
    positions,
    typeParameters: extractTypeParams(alias.getTypeParameters()),
  };
}

function extractClass(cls: ClassDeclaration, filePath: string): SurfaceDeclaration {
  const name = cls.getName() ?? "<anonymous>";
  const positions: SurfacePosition[] = [];
  const methods: SurfaceMethod[] = [];

  // Constructors
  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      positions.push(makePosition(param, "ctor-param", param.getName(), name, "class", filePath, 1.0));
    }
  }

  // Methods
  for (const method of cls.getMethods()) {
    if (!method.getScope || method.getScope() === "private") {continue;}
    const m = extractClassMethod(method, name, filePath);
    methods.push(m);
    positions.push(...m.positions);
  }

  // Properties
  for (const prop of cls.getProperties()) {
    if (prop.getScope() === "private") {continue;}
    positions.push(makePosition(prop, "property", prop.getName(), name, "class", filePath, 0.75));
  }

  // Getters
  for (const getter of cls.getGetAccessors()) {
    if (getter.getScope() === "private") {continue;}
    positions.push(
      makeReturnPosition(getter, getter.getReturnType(), getter.getReturnTypeNode(), name, "class", filePath, 1.0),
    );
    // Override role to "getter" (makeReturnPosition uses "return")
    positions[positions.length - 1]!.role = "getter";
  }

  // Setters
  for (const setter of cls.getSetAccessors()) {
    if (setter.getScope() === "private") {continue;}
    for (const param of setter.getParameters()) {
      positions.push(makePosition(param, "setter-param", param.getName(), name, "class", filePath, 1.0));
    }
  }

  return {
    filePath,
    hasJSDoc: cls.getJsDocs().length > 0,
    kind: "class",
    line: cls.getStartLineNumber(),
    methods,
    name,
    node: cls,
    positions,
    typeParameters: extractTypeParams(cls.getTypeParameters()),
  };
}

function extractClassMethod(method: MethodDeclaration, className: string, filePath: string): SurfaceMethod {
  const name = method.getName();
  const qualifiedName = `${className}.${name}`;
  const positions: SurfacePosition[] = [];

  for (const param of method.getParameters()) {
    positions.push(makePosition(param, "param", param.getName(), qualifiedName, "class", filePath, 1.0));
  }

  positions.push(
    makeReturnPosition(method, method.getReturnType(), method.getReturnTypeNode(), qualifiedName, "class", filePath, 1.25),
  );

  const overloads = method.getOverloads();
  return {
    allParamsTyped: method.getParameters().every((p) => p.getTypeNode() !== undefined),
    hasExplicitReturnType: method.getReturnTypeNode() !== undefined,
    hasJSDoc: method.getJsDocs().length > 0,
    isPrivate: false,
    name,
    overloadCount: overloads.length,
    paramTypeNodes: method.getParameters().map((p) => ({
      name: p.getName(),
      typeNode: p.getTypeNode(),
    })),
    positions,
    returnTypeNode: method.getReturnTypeNode(),
    typeParameters: extractTypeParams(method.getTypeParameters()),
  };
}

function extractEnum(en: EnumDeclaration, filePath: string): SurfaceDeclaration {
  return {
    filePath,
    hasJSDoc: en.getJsDocs().length > 0,
    kind: "enum",
    line: en.getStartLineNumber(),
    name: en.getName(),
    node: en,
    positions: [],
    typeParameters: [],
  };
}

function extractVariable(decl: VariableDeclaration, stmt: VariableStatement, filePath: string): SurfaceDeclaration {
  const name = decl.getName();
  return {
    filePath,
    hasJSDoc: stmt.getJsDocs().length > 0,
    kind: "variable",
    line: decl.getStartLineNumber(),
    name,
    node: decl,
    positions: [makePosition(decl, "variable", name, name, "variable", filePath, 1.0)],
    typeParameters: [],
  };
}

// --- Stats ---

function computeStats(declarations: SurfaceDeclaration[]): SurfaceStats {
  let functionCount = 0;
  let interfaceCount = 0;
  let classCount = 0;
  let typeAliasCount = 0;
  let enumCount = 0;
  let variableCount = 0;
  let totalOverloads = 0;
  let totalMethods = 0;
  let totalPositions = 0;

  for (const d of declarations) {
    totalPositions += d.positions.length;
    switch (d.kind) {
      case "function":
        functionCount++;
        totalOverloads += d.overloadCount ?? 0;
        break;
      case "interface":
        interfaceCount++;
        totalMethods += d.methods?.length ?? 0;
        break;
      case "class":
        classCount++;
        if (d.methods) {
          totalMethods += d.methods.length;
          for (const m of d.methods) {
            totalOverloads += m.overloadCount;
          }
        }
        break;
      case "type-alias":
        typeAliasCount++;
        break;
      case "enum":
        enumCount++;
        break;
      case "variable":
        variableCount++;
        break;
    }
  }

  return {
    classCount,
    enumCount,
    functionCount,
    interfaceCount,
    totalDeclarations: declarations.length,
    totalMethods,
    totalOverloads,
    totalPositions,
    typeAliasCount,
    variableCount,
  };
}
