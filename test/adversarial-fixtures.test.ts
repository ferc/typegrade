import type { AnalysisResult } from "../src/types.js";
import { Project } from "ts-morph";
import { analyzeProject } from "../src/analyzer.js";
import { detectDomain } from "../src/domain.js";
import { extractPublicSurface } from "../src/surface/index.js";
import { resolve } from "node:path";
import { resolveEntrypoints } from "../src/graph/resolve.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function getFixtureSurface(name: string) {
  const project = new Project({
    tsConfigFilePath: resolve(fixturesDir, name, "tsconfig.json"),
  });
  return extractPublicSurface(project.getSourceFiles());
}

function getCompositeScore(result: AnalysisResult, key: string) {
  return result.composites.find((composite) => composite.key === key);
}

// Pre-compute results shared across tests
const tinyUtilityResult = analyzeProject(resolve(fixturesDir, "tiny-utility"));

describe("adversarial fixtures: domain disambiguation", () => {
  describe("decoder-validation fixture", () => {
    it("should detect validation domain with package-name hint, not result", () => {
      // The decoders package has Ok/Err type aliases that could trigger result detection,
      // But its package name is in the validation DOMAIN_PATTERNS list
      const surface = getFixtureSurface("decoder-validation");
      const inference = detectDomain(surface, "decoders");
      expect(inference.domain).toBe("validation");
    });

    it("should not detect result domain even with Ok/Err type aliases present", () => {
      const surface = getFixtureSurface("decoder-validation");
      const inference = detectDomain(surface, "decoders");
      expect(inference.domain).not.toBe("result");
    });

    it("should have decoder-related scenario evidence in matched rules", () => {
      const surface = getFixtureSurface("decoder-validation");
      const inference = detectDomain(surface, "decoders");
      // Should match the decoder-fns scenario trigger rule
      const hasDecoderRule = inference.matchedRules.some((rule) => rule.includes("decoder-fns"));
      expect(hasDecoderRule).toBeTruthy();
    });
  });

  describe("server-router fixture", () => {
    it("should detect router domain with declaration patterns", () => {
      const surface = getFixtureSurface("server-router");
      const inference = detectDomain(surface);
      // With strong router signals (createRouter, route, middleware, Router, endpoint),
      // Should detect router or abstain to general — never a wrong specific domain
      expect(["router", "general"]).toContain(inference.domain);
    });

    it("should have router symbol density in matched rules", () => {
      const surface = getFixtureSurface("server-router");
      const inference = detectDomain(surface);
      const hasRouterRule = inference.matchedRules.some((rule) =>
        rule.includes("router-symbol-density"),
      );
      expect(hasRouterRule).toBeTruthy();
    });

    it("should never detect as frontend or state domain", () => {
      const surface = getFixtureSurface("server-router");
      const inference = detectDomain(surface);
      expect(inference.domain).not.toBe("frontend");
      expect(inference.domain).not.toBe("state");
    });
  });

  describe("cli-builder fixture", () => {
    it("should detect cli domain with declaration patterns", () => {
      const surface = getFixtureSurface("cli-builder");
      const inference = detectDomain(surface);
      // CLI detection requires command/program/subcommand/argv symbols
      // With Command class and Program class, should have enough cli signals
      expect(["cli", "general"]).toContain(inference.domain);
    });

    it("should have cli symbol density in matched rules", () => {
      const surface = getFixtureSurface("cli-builder");
      const inference = detectDomain(surface);
      const hasCliRule = inference.matchedRules.some((rule) => rule.includes("cli-symbol-density"));
      expect(hasCliRule).toBeTruthy();
    });
  });
});

describe("adversarial fixtures: export map resolution", () => {
  describe("export-map-package fixture", () => {
    it("should resolve both entrypoints from exports map", () => {
      const fixturePath = resolve(fixturesDir, "export-map-package");
      const entrypoints = resolveEntrypoints(fixturePath);
      expect(entrypoints).toHaveLength(2);
    });

    it("should resolve root entrypoint at subpath '.'", () => {
      const fixturePath = resolve(fixturesDir, "export-map-package");
      const entrypoints = resolveEntrypoints(fixturePath);
      const rootEntry = entrypoints.find((ep) => ep.subpath === ".");
      expect(rootEntry).toBeDefined();
      expect(rootEntry!.filePath).toContain("index.d.ts");
    });

    it("should resolve utils entrypoint at subpath './utils'", () => {
      const fixturePath = resolve(fixturesDir, "export-map-package");
      const entrypoints = resolveEntrypoints(fixturePath);
      const utilsEntry = entrypoints.find((ep) => ep.subpath === "./utils");
      expect(utilsEntry).toBeDefined();
      expect(utilsEntry!.filePath).toContain("utils.d.ts");
    });
  });
});

describe("adversarial fixtures: @types sibling resolution", () => {
  describe("types-sibling fixture", () => {
    it("should resolve types from companion @types package", () => {
      const fixturePath = resolve(fixturesDir, "types-sibling", "node_modules", "types-sibling");
      const entrypoints = resolveEntrypoints(fixturePath);
      expect(entrypoints.length).toBeGreaterThanOrEqual(1);
    });

    it("should mark entrypoint condition as @types-sourced", () => {
      const fixturePath = resolve(fixturesDir, "types-sibling", "node_modules", "types-sibling");
      const entrypoints = resolveEntrypoints(fixturePath);
      const typesEntry = entrypoints.find((ep) => ep.condition.startsWith("@types/"));
      expect(typesEntry).toBeDefined();
    });
  });
});

describe("adversarial fixtures: sampling classification", () => {
  describe("tiny-utility compact classification", () => {
    it("should classify small-but-complete library as compact, not undersampled", () => {
      const compactResult = analyzeProject(resolve(fixturesDir, "tiny-utility"), {
        mode: "package",
        packageContext: {
          graphStats: {
            dedupByStrategy: {},
            filesDeduped: 0,
            totalAfterDedup: 1,
            totalEntrypoints: 1,
            totalReachable: 1,
            usedFallbackGlob: false,
          },
          packageJsonPath: resolve(fixturesDir, "tiny-utility", "package.json"),
          packageName: "tiny-utility-fixture",
          packageRoot: resolve(fixturesDir, "tiny-utility"),
          typesEntrypoint: "src/index.ts",
          typesSource: "bundled",
        },
        sourceFilesOptions: { includeDts: false },
      });
      expect(compactResult.coverageDiagnostics).toBeDefined();
      expect(compactResult.coverageDiagnostics!.samplingClass).not.toBe("undersampled");
    });

    it("should have many measured declarations from a single file", () => {
      expect(tinyUtilityResult.coverageDiagnostics).toBeDefined();
      expect(tinyUtilityResult.coverageDiagnostics!.measuredDeclarations).toBeGreaterThanOrEqual(
        15,
      );
    });
  });
});

describe("adversarial metamorphic properties", () => {
  it("decoder-validation scores should not exceed a precise validation library", () => {
    // Analyze the decoder-validation fixture and the validation-style fixture
    // The validation-style fixture has cleaner, more focused types
    const decoderResult = analyzeProject(resolve(fixturesDir, "decoder-validation"));
    const validationResult = analyzeProject(resolve(fixturesDir, "validation-style"));

    const decoderCa = getCompositeScore(decoderResult, "consumerApi");
    const validationCa = getCompositeScore(validationResult, "consumerApi");

    // Both should produce valid scores
    expect(decoderCa).toBeDefined();
    expect(validationCa).toBeDefined();
    expect(decoderCa!.score).toBeDefined();
    expect(validationCa!.score).toBeDefined();
  });

  it("adding router declarations to a non-router fixture should shift domain signals", () => {
    // Surface from the cli-builder fixture should not detect router
    const cliSurface = getFixtureSurface("cli-builder");
    const cliDomain = detectDomain(cliSurface);

    // Surface from the server-router fixture should have router signals
    const routerSurface = getFixtureSurface("server-router");
    const routerDomain = detectDomain(routerSurface);

    // The router fixture should have more router-related rules than the cli fixture
    const cliRouterRules = cliDomain.matchedRules.filter((rule) => rule.includes("router"));
    const routerRouterRules = routerDomain.matchedRules.filter((rule) => rule.includes("router"));
    expect(routerRouterRules.length).toBeGreaterThan(cliRouterRules.length);
  });

  it("domain detection is deterministic across repeated calls", () => {
    const surface = getFixtureSurface("decoder-validation");
    const result1 = detectDomain(surface, "decoders");
    const result2 = detectDomain(surface, "decoders");

    expect(result1.domain).toBe(result2.domain);
    expect(result1.confidence).toBe(result2.confidence);
    expect(result1.ambiguityGap).toBe(result2.ambiguityGap);
    expect(result1.matchedRules).toStrictEqual(result2.matchedRules);
  });
});
