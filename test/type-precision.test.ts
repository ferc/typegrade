import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { classifyTypePrecision, isDiscriminatedUnion } from "../src/utils/type-utils.js";

function getTypeFromCode(code: string, typeName: string = "T") {
  const project = new Project({
    compilerOptions: { strict: true, target: 2, module: 99 },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile("test.ts", code);
  const alias = sf.getTypeAlias(typeName);
  if (!alias) throw new Error(`Type alias '${typeName}' not found`);
  return alias.getType();
}

function getParamType(code: string, fnName: string, paramIndex: number = 0) {
  const project = new Project({
    compilerOptions: { strict: true, target: 2, module: 99 },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile("test.ts", code);
  const fn = sf.getFunction(fnName);
  if (!fn) throw new Error(`Function '${fnName}' not found`);
  return fn.getParameters()[paramIndex].getType();
}

function getReturnType(code: string, fnName: string) {
  const project = new Project({
    compilerOptions: { strict: true, target: 2, module: 99 },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile("test.ts", code);
  const fn = sf.getFunction(fnName);
  if (!fn) throw new Error(`Function '${fnName}' not found`);
  return fn.getReturnType();
}

describe("classifyTypePrecision", () => {
  it("classifies any", () => {
    const type = getTypeFromCode("type T = any;");
    expect(classifyTypePrecision(type)).toBe("any");
  });

  it("classifies unknown", () => {
    const type = getTypeFromCode("type T = unknown;");
    expect(classifyTypePrecision(type)).toBe("unknown");
  });

  it("classifies never", () => {
    const type = getTypeFromCode("type T = never;");
    expect(classifyTypePrecision(type)).toBe("never");
  });

  it("classifies wide primitives", () => {
    expect(classifyTypePrecision(getTypeFromCode("type T = string;"))).toBe(
      "wide-primitive",
    );
    expect(classifyTypePrecision(getTypeFromCode("type T = number;"))).toBe(
      "wide-primitive",
    );
    expect(classifyTypePrecision(getTypeFromCode("type T = boolean;"))).toBe(
      "wide-primitive",
    );
  });

  it("classifies string literals", () => {
    const type = getTypeFromCode('type T = "active";');
    expect(classifyTypePrecision(type)).toBe("literal");
  });

  it("classifies number literals", () => {
    const type = getTypeFromCode("type T = 42;");
    expect(classifyTypePrecision(type)).toBe("literal");
  });

  it("classifies literal unions", () => {
    const type = getTypeFromCode('type T = "active" | "inactive" | "pending";');
    expect(classifyTypePrecision(type)).toBe("literal-union");
  });

  it("classifies primitive unions", () => {
    const type = getTypeFromCode("type T = string | number;");
    expect(classifyTypePrecision(type)).toBe("primitive-union");
  });

  it("classifies interfaces", () => {
    const type = getTypeFromCode("type T = { name: string; age: number; }");
    expect(classifyTypePrecision(type)).toBe("interface");
  });

  it("classifies discriminated unions", () => {
    const type = getTypeFromCode(
      'type T = { kind: "circle"; radius: number } | { kind: "square"; side: number };',
    );
    expect(classifyTypePrecision(type)).toBe("discriminated-union");
  });

  it("classifies branded types", () => {
    const type = getTypeFromCode(
      'type T = string & { __brand: "UserId" };',
    );
    expect(classifyTypePrecision(type)).toBe("branded");
  });

  it("classifies template literal types", () => {
    const type = getTypeFromCode("type T = `/api/${string}`;");
    expect(classifyTypePrecision(type)).toBe("template-literal");
  });

  it("classifies bound generics", () => {
    const type = getParamType(
      "function test<T extends string>(x: T): T { return x; }",
      "test",
    );
    expect(classifyTypePrecision(type)).toBe("generic-bound");
  });

  it("classifies unbound generics", () => {
    const type = getParamType(
      "function test<T>(x: T): T { return x; }",
      "test",
    );
    expect(classifyTypePrecision(type)).toBe("generic-unbound");
  });

  it("scores branded > literal-union > interface > wide-primitive > any", async () => {
    const { getPrecisionScore } = await import("../src/utils/type-utils.js");
    expect(getPrecisionScore("branded")).toBeGreaterThan(
      getPrecisionScore("literal-union"),
    );
    expect(getPrecisionScore("literal-union")).toBeGreaterThan(
      getPrecisionScore("interface"),
    );
    expect(getPrecisionScore("interface")).toBeGreaterThan(
      getPrecisionScore("wide-primitive"),
    );
    expect(getPrecisionScore("wide-primitive")).toBeGreaterThan(
      getPrecisionScore("any"),
    );
  });
});

describe("isDiscriminatedUnion", () => {
  it("detects discriminated unions", () => {
    const type = getTypeFromCode(
      'type T = { kind: "a"; x: number } | { kind: "b"; y: string };',
    );
    const members = type.getUnionTypes();
    expect(isDiscriminatedUnion(members)).toBe(true);
  });

  it("rejects non-discriminated unions", () => {
    const type = getTypeFromCode(
      "type T = { x: number } | { y: string };",
    );
    const members = type.getUnionTypes();
    expect(isDiscriminatedUnion(members)).toBe(false);
  });

  it("rejects single-member unions", () => {
    const type = getTypeFromCode('type T = { kind: "a" };');
    // Single type — not a union
    expect(type.isUnion()).toBe(false);
  });
});
