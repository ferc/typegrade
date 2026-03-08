import type { AnalysisResult, CompositeScore } from "../src/types.js";
import { analyzeProject } from "../src/analyzer.js";
import { resolve } from "node:path";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

function getComposite(result: AnalysisResult, key: string): CompositeScore | undefined {
  return result.composites.find((composite) => composite.key === key);
}

// Pre-compute all results at module level to share across tests
const preciseResult = analyzeProject(resolve(fixturesDir, "metamorphic-precise"));
const anyResult = analyzeProject(resolve(fixturesDir, "metamorphic-any"));
const constrainedResult = analyzeProject(resolve(fixturesDir, "metamorphic-constrained"));
const unconstrainedResult = analyzeProject(resolve(fixturesDir, "metamorphic-unconstrained"));
const fullCoverageResult = analyzeProject(resolve(fixturesDir, "metamorphic-full-coverage"));
const partialCoverageResult = analyzeProject(resolve(fixturesDir, "metamorphic-partial-coverage"));
const compactResult = analyzeProject(resolve(fixturesDir, "metamorphic-compact"));
const typedReturnsResult = analyzeProject(resolve(fixturesDir, "metamorphic-typed-returns"));
const anyReturnsResult = analyzeProject(resolve(fixturesDir, "metamorphic-any-returns"));

describe("metamorphic: scoring invariants", () => {
  describe("replacing precise types with any must not improve score", () => {
    it("precise fixture has consumerApi >= any fixture", () => {
      const preciseCa = getComposite(preciseResult, "consumerApi")!;
      const anyCa = getComposite(anyResult, "consumerApi")!;
      expect(preciseCa.score!).toBeGreaterThanOrEqual(anyCa.score!);
    });

    it("precise fixture has typeSafety >= any fixture", () => {
      const preciseTs = getComposite(preciseResult, "typeSafety")!;
      const anyTs = getComposite(anyResult, "typeSafety")!;
      expect(preciseTs.score!).toBeGreaterThanOrEqual(anyTs.score!);
    });
  });

  describe("replacing constrained generics with unconstrained must not improve score", () => {
    it("constrained fixture has consumerApi >= unconstrained fixture", () => {
      const constrainedCa = getComposite(constrainedResult, "consumerApi")!;
      const unconstrainedCa = getComposite(unconstrainedResult, "consumerApi")!;
      expect(constrainedCa.score!).toBeGreaterThanOrEqual(unconstrainedCa.score!);
    });
  });

  describe("reducing coverage must not increase confidence", () => {
    it("full coverage has sampleCoverage >= partial coverage", () => {
      const fullConf = fullCoverageResult.confidenceSummary;
      const partialConf = partialCoverageResult.confidenceSummary;
      expect(fullConf).toBeDefined();
      expect(partialConf).toBeDefined();
      // Fixture with more declarations should have equal or higher coverage
      expect(fullConf!.sampleCoverage).toBeGreaterThanOrEqual(partialConf!.sampleCoverage);
    });
  });

  describe("compact single-file library is not undersampled", () => {
    it("compact fixture has samplingClass that is not undersampled", () => {
      // Score in package mode with single reachable file to trigger compact classification
      const compactPkgResult = analyzeProject(resolve(fixturesDir, "metamorphic-compact"), {
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
          packageJsonPath: "",
          packageName: "metamorphic-compact",
          packageRoot: resolve(fixturesDir, "metamorphic-compact"),
          typesEntrypoint: null,
          typesSource: "bundled",
        },
        sourceFilesOptions: { includeDts: false },
      });
      expect(compactPkgResult.coverageDiagnostics).toBeDefined();
      expect(compactPkgResult.coverageDiagnostics!.samplingClass).not.toBe("undersampled");
    });

    it("compact fixture in source mode has many declarations", () => {
      expect(compactResult.coverageDiagnostics).toBeDefined();
      expect(compactResult.coverageDiagnostics!.measuredDeclarations).toBeGreaterThanOrEqual(10);
    });
  });

  describe("more any in return types must lower typeSafety", () => {
    it("typed returns fixture has higher typeSafety than any returns fixture", () => {
      const typedTs = getComposite(typedReturnsResult, "typeSafety")!;
      const anyTs = getComposite(anyReturnsResult, "typeSafety")!;
      expect(typedTs.score!).toBeGreaterThan(anyTs.score!);
    });
  });
});
