import { analyzePrecision, isDiscriminatedUnion } from "../src/utils/type-utils.js";
import { Project } from "ts-morph";

function getTypeFromCode(code: string, typeName = "T") {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile("test.ts", code);
  const alias = sf.getTypeAlias(typeName);
  if (!alias) {
    throw new Error(`Type alias '${typeName}' not found`);
  }
  return alias.getType();
}

function getParamType(code: string, fnName: string, paramIndex = 0) {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile("test.ts", code);
  const fn = sf.getFunction(fnName);
  if (!fn) {
    throw new Error(`Function '${fnName}' not found`);
  }
  return fn.getParameters()[paramIndex].getType();
}

describe(analyzePrecision, () => {
  it("scores any as 0", () => {
    const result = analyzePrecision(getTypeFromCode("type T = any;"));
    expect(result.score).toBe(0);
    expect(result.containsAny).toBeTruthy();
  });

  it("scores unknown as 25", () => {
    const result = analyzePrecision(getTypeFromCode("type T = unknown;"));
    expect(result.score).toBe(25);
    expect(result.containsUnknown).toBeTruthy();
  });

  it("scores never as 90", () => {
    const result = analyzePrecision(getTypeFromCode("type T = never;"));
    expect(result.score).toBe(90);
  });

  it("scores wide primitives as 40", () => {
    expect(analyzePrecision(getTypeFromCode("type T = string;")).score).toBe(40);
    expect(analyzePrecision(getTypeFromCode("type T = number;")).score).toBe(40);
    expect(analyzePrecision(getTypeFromCode("type T = boolean;")).score).toBe(40);
  });

  it("scores string literals as 85", () => {
    const result = analyzePrecision(getTypeFromCode('type T = "active";'));
    expect(result.score).toBe(85);
  });

  it("scores number literals as 85", () => {
    const result = analyzePrecision(getTypeFromCode("type T = 42;"));
    expect(result.score).toBe(85);
  });

  it("scores template literals as 85", () => {
    const result = analyzePrecision(getTypeFromCode("type T = `/api/${string}`;"));
    expect(result.score).toBe(85);
  });

  it("scores enum types as 70", () => {
    const result = analyzePrecision(getTypeFromCode("enum E { A, B }\ntype T = E;"));
    expect(result.score).toBe(70);
  });

  it("scores constrained generics with basic constraint as 62", () => {
    const result = analyzePrecision(
      getParamType("function test<T extends string>(x: T): T { return x; }", "test"),
    );
    expect(result.score).toBe(62);
    expect(result.features).toContain("constrained-generic");
    expect(result.features).toContain("constraint-basic");
  });

  it("scores constrained generics with strong constraint as 70", () => {
    const result = analyzePrecision(
      getParamType(
        "interface Opts { x: number }\nfunction test<T extends Opts>(x: T): T { return x; }",
        "test",
      ),
    );
    expect(result.score).toBe(70);
    expect(result.features).toContain("constraint-strong");
  });

  it("scores unconstrained generics as 35", () => {
    const result = analyzePrecision(
      getParamType("function test<T>(x: T): T { return x; }", "test"),
    );
    expect(result.score).toBe(35);
  });

  it("scores literal unions higher than wide primitives", () => {
    const literalUnion = analyzePrecision(
      getTypeFromCode('type T = "active" | "inactive" | "pending";'),
    );
    const widePrimitive = analyzePrecision(getTypeFromCode("type T = string;"));
    expect(literalUnion.score).toBeGreaterThan(widePrimitive.score);
  });

  it("scores discriminated unions highly", () => {
    const result = analyzePrecision(
      getTypeFromCode(
        'type T = { kind: "circle"; radius: number } | { kind: "square"; side: number };',
      ),
    );
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.features).toContain("discriminated-union");
  });

  it("scores branded types highly", () => {
    const result = analyzePrecision(getTypeFromCode('type T = string & { __brand: "UserId" };'));
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.features).toContain("branded");
  });

  it("detects any in containers (Array<any>)", () => {
    const result = analyzePrecision(getTypeFromCode("type T = Array<any>;"));
    expect(result.containsAny).toBeTruthy();
    expect(result.score).toBeLessThan(30);
  });

  it("detects any in Record<string, any>", () => {
    const result = analyzePrecision(getTypeFromCode("type T = Record<string, any>;"));
    expect(result.containsAny).toBeTruthy();
    expect(result.score).toBeLessThan(20);
  });

  it("scores Record<string, string> lower than specific interfaces", () => {
    const record = analyzePrecision(getTypeFromCode("type T = Record<string, string>;"));
    const specific = analyzePrecision(getTypeFromCode("type T = { name: string; age: number };"));
    expect(record.score).toBeLessThan(specific.score);
  });

  it("scores Promise<string> using container formula", () => {
    const result = analyzePrecision(getTypeFromCode("type T = Promise<string>;"));
    // 0.35 * 45 + 0.65 * 40 = 15.75 + 26 = 41.75 -> 42
    expect(result.score).toBeGreaterThanOrEqual(35);
    expect(result.score).toBeLessThanOrEqual(50);
  });

  it("maintains ordering: branded > literal > interface > wide-primitive > any", () => {
    const branded = analyzePrecision(getTypeFromCode('type T = string & { __brand: "Id" };'));
    const literal = analyzePrecision(getTypeFromCode('type T = "active";'));
    const iface = analyzePrecision(getTypeFromCode("type T = { name: string; age: number };"));
    const wide = analyzePrecision(getTypeFromCode("type T = string;"));
    const any_ = analyzePrecision(getTypeFromCode("type T = any;"));

    expect(branded.score).toBeGreaterThan(literal.score);
    expect(literal.score).toBeGreaterThan(iface.score);
    expect(iface.score).toBeGreaterThan(wide.score);
    expect(wide.score).toBeGreaterThan(any_.score);
  });
});

describe(isDiscriminatedUnion, () => {
  it("detects discriminated unions", () => {
    const type = getTypeFromCode('type T = { kind: "a"; x: number } | { kind: "b"; y: string };');
    const members = type.getUnionTypes();
    expect(isDiscriminatedUnion(members)).toBeTruthy();
  });

  it("rejects non-discriminated unions", () => {
    const type = getTypeFromCode("type T = { x: number } | { y: string };");
    const members = type.getUnionTypes();
    expect(isDiscriminatedUnion(members)).toBeFalsy();
  });

  it("rejects single-member unions", () => {
    const type = getTypeFromCode('type T = { kind: "a" };');
    expect(type.isUnion()).toBeFalsy();
  });
});
