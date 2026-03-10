import { Project } from "ts-morph";
import { extractPublicSurface } from "../src/surface/index.js";
import { resolve } from "node:path";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function getSourceFiles(fixtureName: string) {
  const project = new Project({
    tsConfigFilePath: resolve(fixturesDir, fixtureName, "tsconfig.json"),
  });
  return project.getSourceFiles();
}

function getSurfaceFromCode(code: string) {
  const project = new Project({
    compilerOptions: { module: 99, strict: true, target: 2 },
    useInMemoryFileSystem: true,
  });
  project.createSourceFile("test.ts", code);
  return extractPublicSurface(project.getSourceFiles());
}

describe(extractPublicSurface, () => {
  describe("index signatures", () => {
    it("extracts index signatures from interfaces", () => {
      const surface = getSurfaceFromCode(`
        export interface StringMap {
          [key: string]: string;
        }
      `);
      const indexPositions = surface.positions.filter((pos) => pos.role === "index-sig");
      expect(indexPositions).toHaveLength(1);
      expect(indexPositions[0]!.name).toBe("[index]");
      expect(indexPositions[0]!.weight).toBe(0.75);
    });

    it("extracts index signatures alongside properties", () => {
      const surface = getSurfaceFromCode(`
        export interface Config {
          name: string;
          [key: string]: string;
        }
      `);
      const props = surface.positions.filter((pos) => pos.role === "property");
      const indexSigs = surface.positions.filter((pos) => pos.role === "index-sig");
      expect(props).toHaveLength(1);
      expect(indexSigs).toHaveLength(1);
    });

    it("extracts from index-signatures fixture", () => {
      const sourceFiles = getSourceFiles("index-signatures");
      const surface = extractPublicSurface(sourceFiles);
      const indexPositions = surface.positions.filter((pos) => pos.role === "index-sig");
      // StringMap(1) + Config(1) + Complex(1) = 3
      expect(indexPositions).toHaveLength(3);
    });
  });

  describe("call signatures", () => {
    it("extracts call signatures from interfaces", () => {
      const surface = getSurfaceFromCode(`
        export interface Callable {
          (arg: string): number;
        }
      `);
      const callSigPositions = surface.positions.filter((pos) => pos.role === "call-sig");
      expect(callSigPositions).toHaveLength(1);
      // Params from call signature
      const paramPositions = surface.positions.filter((pos) => pos.role === "param");
      expect(paramPositions).toHaveLength(1);
      expect(paramPositions[0]!.name).toBe("arg");
    });

    it("extracts from index-signatures fixture (Complex has call sig)", () => {
      const sourceFiles = getSourceFiles("index-signatures");
      const surface = extractPublicSurface(sourceFiles);
      const callSigPositions = surface.positions.filter((pos) => pos.role === "call-sig");
      // Callable(1) + Complex(1) = 2
      expect(callSigPositions).toHaveLength(2);
    });
  });

  describe("construct signatures", () => {
    it("extracts construct signatures from interfaces", () => {
      const surface = getSurfaceFromCode(`
        export interface Constructable {
          new (name: string): { name: string };
        }
      `);
      const ctorSigPositions = surface.positions.filter((pos) => pos.role === "construct-sig");
      expect(ctorSigPositions).toHaveLength(1);
    });

    it("extracts from index-signatures fixture (Complex + Constructable)", () => {
      const sourceFiles = getSourceFiles("index-signatures");
      const surface = extractPublicSurface(sourceFiles);
      const ctorSigPositions = surface.positions.filter((pos) => pos.role === "construct-sig");
      // Constructable(1) + Complex(1) = 2
      expect(ctorSigPositions).toHaveLength(2);
    });
  });

  describe("namespace exports", () => {
    it("extracts declarations from exported namespaces", () => {
      const sourceFiles = getSourceFiles("namespace-export");
      const surface = extractPublicSurface(sourceFiles);
      const nsDecls = surface.declarations.filter((decl) => decl.name.startsWith("Utils."));
      expect(nsDecls.length).toBeGreaterThanOrEqual(2);
      const fnDecl = nsDecls.find((decl) => decl.name === "Utils.parse");
      expect(fnDecl).toBeDefined();
      expect(fnDecl!.kind).toBe("function");
      const ifaceDecl = nsDecls.find((decl) => decl.name === "Utils.Options");
      expect(ifaceDecl).toBeDefined();
      expect(ifaceDecl!.kind).toBe("interface");
    });

    it("extracts namespace type aliases", () => {
      const sourceFiles = getSourceFiles("namespace-export");
      const surface = extractPublicSurface(sourceFiles);
      const resultDecl = surface.declarations.find((decl) => decl.name === "Utils.Result");
      expect(resultDecl).toBeDefined();
      expect(resultDecl!.kind).toBe("type-alias");
    });
  });

  describe("export assignments", () => {
    it("extracts the underlying public surface for export-equals functions", () => {
      const surface = getSurfaceFromCode(`
        declare function Builder(input: string, options?: { dryRun: boolean }): number;
        export = Builder;
      `);
      const builderDecl = surface.declarations.find((decl) => decl.name === "Builder");
      expect(builderDecl).toBeDefined();
      expect(builderDecl!.kind).toBe("function");
      expect(builderDecl!.positions.some((pos) => pos.role === "return")).toBeTruthy();
      expect(builderDecl!.positions.filter((pos) => pos.role === "param")).toHaveLength(2);
    });

    it("falls back to a variable surface when export assignment target is opaque", () => {
      const surface = getSurfaceFromCode(`
        const runtimeValue = { enabled: true } as const;
        export default runtimeValue;
      `);
      expect(surface.declarations.some((decl) => decl.kind === "variable")).toBeTruthy();
      expect(surface.positions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("re-exports", () => {
    it("extracts export-star surfaces from JS-specifier entrypoints", () => {
      const project = new Project({
        compilerOptions: { module: 99, strict: true, target: 2 },
        useInMemoryFileSystem: true,
      });
      project.createSourceFile(
        "core.ts",
        `
        export interface Shared { id: string; }
        export function create(input: string): Shared {
          throw new Error("runtime");
        }
      `,
      );
      const entry = project.createSourceFile("index.ts", `export * from "./core.js";`);

      const surface = extractPublicSurface([entry]);
      expect(surface.declarations.some((decl) => decl.name === "create")).toBeTruthy();
      expect(surface.declarations.some((decl) => decl.name === "Shared")).toBeTruthy();
    });

    it("extracts named re-export aliases from JS-specifier entrypoints", () => {
      const project = new Project({
        compilerOptions: { module: 99, strict: true, target: 2 },
        useInMemoryFileSystem: true,
      });
      project.createSourceFile(
        "core.ts",
        `
        export interface Shared { id: string; }
        export function create(input: string): Shared {
          throw new Error("runtime");
        }
      `,
      );
      const entry = project.createSourceFile(
        "index.ts",
        `export { create as make, Shared as MakeResult } from "./core.js";`,
      );

      const surface = extractPublicSurface([entry]);
      expect(surface.declarations.some((decl) => decl.name === "make")).toBeTruthy();
      expect(surface.declarations.some((decl) => decl.name === "MakeResult")).toBeTruthy();
    });
  });

  describe("merged declarations", () => {
    it("deduplicates identical declarations from multiple sources", () => {
      const project = new Project({
        compilerOptions: { module: 99, strict: true, target: 2 },
        useInMemoryFileSystem: true,
      });
      project.createSourceFile(
        "a.ts",
        `
        export interface Shared { x: number; }
      `,
      );
      project.createSourceFile(
        "b.ts",
        `
        export interface Shared { y: string; }
      `,
      );
      const surface = extractPublicSurface(project.getSourceFiles());
      // Should merge into a single declaration
      const sharedDecls = surface.declarations.filter((decl) => decl.name === "Shared");
      expect(sharedDecls).toHaveLength(1);
      // Should have positions from both
      expect(sharedDecls[0]!.positions).toHaveLength(2);
    });
  });

  describe("stats", () => {
    it("counts new position types in stats", () => {
      const sourceFiles = getSourceFiles("index-signatures");
      const surface = extractPublicSurface(sourceFiles);
      expect(surface.stats.totalPositions).toBeGreaterThan(0);
      expect(surface.stats.interfaceCount).toBeGreaterThanOrEqual(4);
    });
  });
});
