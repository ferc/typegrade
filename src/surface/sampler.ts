import {
  type ClassDeclaration,
  type EnumDeclaration,
  type ExportDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ModuleDeclaration,
  Node,
  type SourceFile,
  type Type,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeParameterDeclaration,
  type VariableDeclaration,
  type VariableStatement,
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
  // Track resolved re-export files to prevent circularity
  const visited = new Set<string>();

  for (const sf of sourceFiles) {
    visited.add(sf.getFilePath());
  }

  for (const sf of sourceFiles) {
    extractFromSourceFile(sf, declarations);

    // Handle `export *` re-exports — resolve target and merge declarations
    for (const exportDecl of sf.getExportDeclarations()) {
      if (
        exportDecl.isNamespaceExport() ||
        (exportDecl.getNamedExports().length === 0 && !exportDecl.getModuleSpecifier())
      ) {
        const resolved = resolveReExportTarget(exportDecl);
        if (resolved && !visited.has(resolved.getFilePath())) {
          visited.add(resolved.getFilePath());
          extractFromSourceFile(resolved, declarations);
        }
      }
    }

    // Handle namespace exports
    for (const mod of sf.getModules()) {
      if (!mod.isExported()) {
        continue;
      }
      extractNamespaceExports(mod, sf.getFilePath(), declarations);
    }
  }

  // Deduplicate merged declarations (same name from multiple declaration sources)
  const deduped = deduplicateMergedDeclarations(declarations);

  const positions = deduped.flatMap((decl) => decl.positions);
  const stats = computeStats(deduped);

  return { declarations: deduped, positions, stats };
}

function extractFromSourceFile(sf: SourceFile, declarations: SurfaceDeclaration[]): void {
  const filePath = sf.getFilePath();

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) {
      continue;
    }
    declarations.push(extractFunction(fn, filePath));
  }

  for (const iface of sf.getInterfaces()) {
    if (!iface.isExported()) {
      continue;
    }
    declarations.push(extractInterface(iface, filePath));
  }

  for (const alias of sf.getTypeAliases()) {
    if (!alias.isExported()) {
      continue;
    }
    declarations.push(extractTypeAlias(alias, filePath));
  }

  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) {
      continue;
    }
    declarations.push(extractClass(cls, filePath));
  }

  for (const en of sf.getEnums()) {
    if (!en.isExported()) {
      continue;
    }
    declarations.push(extractEnum(en, filePath));
  }

  for (const varStmt of sf.getVariableStatements()) {
    if (!varStmt.isExported()) {
      continue;
    }
    for (const decl of varStmt.getDeclarations()) {
      declarations.push(extractVariable(decl, varStmt, filePath));
    }
  }
}

function resolveReExportTarget(exportDecl: ExportDeclaration): SourceFile | undefined {
  try {
    const moduleSpecifier = exportDecl.getModuleSpecifierSourceFile();
    return moduleSpecifier ?? undefined;
  } catch {
    return undefined;
  }
}

function extractNamespaceExports(
  mod: ModuleDeclaration,
  filePath: string,
  declarations: SurfaceDeclaration[],
): void {
  const body = mod.getBody();
  if (!body || !Node.isModuleBlock(body)) {
    return;
  }
  const nsName = mod.getName().replaceAll(/["']/g, "");

  // Extract functions from namespace
  for (const fn of body.getFunctions() ?? []) {
    if (!fn.isExported()) {
      continue;
    }
    const decl = extractFunction(fn, filePath);
    decl.name = `${nsName}.${decl.name}`;
    for (const pos of decl.positions) {
      pos.declarationName = decl.name;
    }
    declarations.push(decl);
  }

  // Extract interfaces from namespace
  for (const iface of body.getInterfaces() ?? []) {
    if (!iface.isExported()) {
      continue;
    }
    const decl = extractInterface(iface, filePath);
    decl.name = `${nsName}.${decl.name}`;
    for (const pos of decl.positions) {
      pos.declarationName = decl.name;
    }
    declarations.push(decl);
  }

  // Extract type aliases from namespace
  for (const alias of body.getTypeAliases() ?? []) {
    if (!alias.isExported()) {
      continue;
    }
    const decl = extractTypeAlias(alias, filePath);
    decl.name = `${nsName}.${decl.name}`;
    for (const pos of decl.positions) {
      pos.declarationName = decl.name;
    }
    declarations.push(decl);
  }
}

function deduplicateMergedDeclarations(declarations: SurfaceDeclaration[]): SurfaceDeclaration[] {
  const seen = new Map<string, SurfaceDeclaration>();
  const result: SurfaceDeclaration[] = [];

  for (const decl of declarations) {
    const key = `${decl.kind}:${decl.name}`;
    const existing = seen.get(key);
    if (existing) {
      // Merge positions and methods from duplicate declaration
      for (const pos of decl.positions) {
        const isDuplicate = existing.positions.some(
          (ep) =>
            ep.name === pos.name &&
            ep.role === pos.role &&
            ep.filePath === pos.filePath &&
            ep.line === pos.line,
        );
        if (!isDuplicate) {
          existing.positions.push(pos);
        }
      }
      if (decl.methods) {
        existing.methods = existing.methods ?? [];
        const newMethods = decl.methods.filter(
          (method) => !existing.methods!.some((em) => em.name === method.name),
        );
        existing.methods.push(...newMethods);
      }
    } else {
      seen.set(key, decl);
      result.push(decl);
    }
  }

  return result;
}

// --- Helpers ---

function nodeLocation(node: Node): { line: number; column: number } {
  return {
    column: node.getStart() - node.getStartLinePos() + 1,
    line: node.getStartLineNumber(),
  };
}

interface MakePositionOpts {
  node: Node;
  role: SurfacePosition["role"];
  name: string;
  declarationName: string;
  declarationKind: SurfaceDeclarationKind;
  filePath: string;
  weight: number;
}

function makePosition(opts: MakePositionOpts): SurfacePosition {
  const { node, role, name, declarationName, declarationKind, filePath, weight } = opts;
  const loc = nodeLocation(node);
  const hasType = "getType" in node && typeof node.getType === "function";
  const hasTypeNode = "getTypeNode" in node && typeof node.getTypeNode === "function";
  return {
    column: loc.column,
    declarationKind,
    declarationName,
    filePath,
    line: loc.line,
    name,
    node,
    role,
    type: hasType ? (node.getType as () => Type)() : node.getType(),
    typeNode: hasTypeNode ? (node.getTypeNode as () => TypeNode | undefined)() : undefined,
    weight,
  };
}

interface MakeReturnPositionOpts {
  owner: Node;
  returnType: Type;
  returnTypeNode: TypeNode | undefined;
  declarationName: string;
  declarationKind: SurfaceDeclarationKind;
  filePath: string;
  weight: number;
}

function makeReturnPosition(opts: MakeReturnPositionOpts): SurfacePosition {
  const { owner, returnType, returnTypeNode, declarationName, declarationKind, filePath, weight } =
    opts;
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
    positions.push(
      makePosition({
        declarationKind: "function",
        declarationName: name,
        filePath,
        name: param.getName(),
        node: param,
        role: "param",
        weight: 1,
      }),
    );
  }

  positions.push(
    makeReturnPosition({
      declarationKind: "function",
      declarationName: name,
      filePath,
      owner: fn,
      returnType: fn.getReturnType(),
      returnTypeNode: fn.getReturnTypeNode(),
      weight: 1.25,
    }),
  );

  const overloads = fn.getOverloads();
  return {
    allParamsTyped: fn.getParameters().every((pm) => pm.getTypeNode() !== undefined),
    filePath,
    hasExplicitReturnType: fn.getReturnTypeNode() !== undefined,
    hasJSDoc: fn.getJsDocs().length > 0,
    kind: "function",
    line: fn.getStartLineNumber(),
    name,
    node: fn,
    overloadCount: overloads.length,
    paramTypeNodes: fn.getParameters().map((pm) => ({
      name: pm.getName(),
      typeNode: pm.getTypeNode(),
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
    positions.push(
      makePosition({
        declarationKind: "interface",
        declarationName: name,
        filePath,
        name: prop.getName(),
        node: prop,
        role: "property",
        weight: 0.75,
      }),
    );
  }

  // Index signatures: e.g., [key: string]: ValueType
  for (const indexSig of iface.getIndexSignatures()) {
    const loc = nodeLocation(indexSig);
    const returnType = indexSig.getReturnType();
    const returnTypeNode = indexSig.getReturnTypeNode();
    positions.push({
      column: loc.column,
      declarationKind: "interface",
      declarationName: name,
      filePath,
      line: loc.line,
      name: "[index]",
      node: indexSig,
      role: "index-sig",
      type: returnType,
      typeNode: returnTypeNode,
      weight: 0.75,
    });
  }

  // Call signatures: e.g., (arg: string): number
  for (const callSig of iface.getCallSignatures()) {
    for (const param of callSig.getParameters()) {
      positions.push(
        makePosition({
          declarationKind: "interface",
          declarationName: `${name}()`,
          filePath,
          name: param.getName(),
          node: param,
          role: "param",
          weight: 1,
        }),
      );
    }
    positions.push(
      makeReturnPosition({
        declarationKind: "interface",
        declarationName: `${name}()`,
        filePath,
        owner: callSig,
        returnType: callSig.getReturnType(),
        returnTypeNode: callSig.getReturnTypeNode(),
        weight: 1.25,
      }),
    );
    // Override role to call-sig for the return position
    positions.at(-1)!.role = "call-sig";
  }

  // Construct signatures: e.g., new (arg: string): Instance
  for (const ctorSig of iface.getConstructSignatures()) {
    for (const param of ctorSig.getParameters()) {
      positions.push(
        makePosition({
          declarationKind: "interface",
          declarationName: `new ${name}()`,
          filePath,
          name: param.getName(),
          node: param,
          role: "param",
          weight: 1,
        }),
      );
    }
    positions.push(
      makeReturnPosition({
        declarationKind: "interface",
        declarationName: `new ${name}()`,
        filePath,
        owner: ctorSig,
        returnType: ctorSig.getReturnType(),
        returnTypeNode: ctorSig.getReturnTypeNode(),
        weight: 1.25,
      }),
    );
    // Override role to construct-sig for the return position
    positions.at(-1)!.role = "construct-sig";
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

function extractMethodSignature(
  method: MethodSignature,
  parentName: string,
  filePath: string,
): SurfaceMethod {
  const name = method.getName();
  const qualifiedName = `${parentName}.${name}`;
  const positions: SurfacePosition[] = [];

  for (const param of method.getParameters()) {
    positions.push(
      makePosition({
        declarationKind: "interface",
        declarationName: qualifiedName,
        filePath,
        name: param.getName(),
        node: param,
        role: "param",
        weight: 1,
      }),
    );
  }

  positions.push(
    makeReturnPosition({
      declarationKind: "interface",
      declarationName: qualifiedName,
      filePath,
      owner: method,
      returnType: method.getReturnType(),
      returnTypeNode: method.getReturnTypeNode(),
      weight: 1.25,
    }),
  );

  return {
    allParamsTyped: method.getParameters().every((pm) => pm.getTypeNode() !== undefined),
    hasExplicitReturnType: method.getReturnTypeNode() !== undefined,
    hasJSDoc: method.getJsDocs().length > 0,
    isPrivate: false,
    name,
    overloadCount: 0,
    paramTypeNodes: method.getParameters().map((pm) => ({
      name: pm.getName(),
      typeNode: pm.getTypeNode(),
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
      positions.push(
        makePosition({
          declarationKind: "class",
          declarationName: name,
          filePath,
          name: param.getName(),
          node: param,
          role: "ctor-param",
          weight: 1,
        }),
      );
    }
  }

  // Methods
  for (const method of cls.getMethods()) {
    if (!method.getScope || method.getScope() === "private") {
      continue;
    }
    const classMethod = extractClassMethod(method, name, filePath);
    methods.push(classMethod);
    positions.push(...classMethod.positions);
  }

  // Properties
  for (const prop of cls.getProperties()) {
    if (prop.getScope() === "private") {
      continue;
    }
    positions.push(
      makePosition({
        declarationKind: "class",
        declarationName: name,
        filePath,
        name: prop.getName(),
        node: prop,
        role: "property",
        weight: 0.75,
      }),
    );
  }

  // Getters
  for (const getter of cls.getGetAccessors()) {
    if (getter.getScope() === "private") {
      continue;
    }
    positions.push(
      makeReturnPosition({
        declarationKind: "class",
        declarationName: name,
        filePath,
        owner: getter,
        returnType: getter.getReturnType(),
        returnTypeNode: getter.getReturnTypeNode(),
        weight: 1,
      }),
    );
    // Override role to "getter" (makeReturnPosition uses "return")
    positions.at(-1)!.role = "getter";
  }

  // Setters
  for (const setter of cls.getSetAccessors()) {
    if (setter.getScope() === "private") {
      continue;
    }
    for (const param of setter.getParameters()) {
      positions.push(
        makePosition({
          declarationKind: "class",
          declarationName: name,
          filePath,
          name: param.getName(),
          node: param,
          role: "setter-param",
          weight: 1,
        }),
      );
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

function extractClassMethod(
  method: MethodDeclaration,
  className: string,
  filePath: string,
): SurfaceMethod {
  const name = method.getName();
  const qualifiedName = `${className}.${name}`;
  const positions: SurfacePosition[] = [];

  for (const param of method.getParameters()) {
    positions.push(
      makePosition({
        declarationKind: "class",
        declarationName: qualifiedName,
        filePath,
        name: param.getName(),
        node: param,
        role: "param",
        weight: 1,
      }),
    );
  }

  positions.push(
    makeReturnPosition({
      declarationKind: "class",
      declarationName: qualifiedName,
      filePath,
      owner: method,
      returnType: method.getReturnType(),
      returnTypeNode: method.getReturnTypeNode(),
      weight: 1.25,
    }),
  );

  const overloads = method.getOverloads();
  return {
    allParamsTyped: method.getParameters().every((pm) => pm.getTypeNode() !== undefined),
    hasExplicitReturnType: method.getReturnTypeNode() !== undefined,
    hasJSDoc: method.getJsDocs().length > 0,
    isPrivate: false,
    name,
    overloadCount: overloads.length,
    paramTypeNodes: method.getParameters().map((pm) => ({
      name: pm.getName(),
      typeNode: pm.getTypeNode(),
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

function extractVariable(
  decl: VariableDeclaration,
  stmt: VariableStatement,
  filePath: string,
): SurfaceDeclaration {
  const name = decl.getName();
  return {
    filePath,
    hasJSDoc: stmt.getJsDocs().length > 0,
    kind: "variable",
    line: decl.getStartLineNumber(),
    name,
    node: decl,
    positions: [
      makePosition({
        declarationKind: "variable",
        declarationName: name,
        filePath,
        name,
        node: decl,
        role: "variable",
        weight: 1,
      }),
    ],
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

  for (const decl of declarations) {
    totalPositions += decl.positions.length;
    switch (decl.kind) {
      case "function": {
        functionCount++;
        totalOverloads += decl.overloadCount ?? 0;
        break;
      }
      case "interface": {
        interfaceCount++;
        totalMethods += decl.methods?.length ?? 0;
        break;
      }
      case "class": {
        classCount++;
        if (decl.methods) {
          totalMethods += decl.methods.length;
          for (const mt of decl.methods) {
            totalOverloads += mt.overloadCount;
          }
        }
        break;
      }
      case "type-alias": {
        typeAliasCount++;
        break;
      }
      case "enum": {
        enumCount++;
        break;
      }
      case "variable": {
        variableCount++;
        break;
      }
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
