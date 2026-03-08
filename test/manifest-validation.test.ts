import {
  EXPECTED_DOMAINS,
  PAIRWISE_ASSERTIONS,
  SCENARIO_ASSERTIONS,
} from "../benchmarks/assertions.js";
import { existsSync, readFileSync } from "node:fs";
import { flattenManifest, loadManifest } from "../benchmarks/split-loader.js";
import type { BenchmarkManifestV2 } from "../benchmarks/types.js";
import { join } from "node:path";

const BENCHMARKS_DIR = join(import.meta.dirname, "..", "benchmarks");

/**
 * Extract all package names from a manifest.
 * Handles both V1 (string) and V2 (object) entry formats.
 */
function extractPackageNames(manifest: BenchmarkManifestV2): string[] {
  return flattenManifest(manifest).map((entry) => entry.name);
}

describe("manifest validation", () => {
  describe("no duplicate packages within a manifest", () => {
    it("train manifest has no duplicates", () => {
      const train = loadManifest("train");
      const names = extractPackageNames(train);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const name of names) {
        if (seen.has(name)) {
          duplicates.push(name);
        }
        seen.add(name);
      }
      expect(duplicates).toStrictEqual([]);
    });

    it("eval-fixed manifest has no duplicates", () => {
      const evalFixed = loadManifest("eval-fixed");
      const names = extractPackageNames(evalFixed);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const name of names) {
        if (seen.has(name)) {
          duplicates.push(name);
        }
        seen.add(name);
      }
      expect(duplicates).toStrictEqual([]);
    });

    it("eval-pool manifest has no duplicates", () => {
      const evalPool = loadManifest("eval-pool");
      const names = extractPackageNames(evalPool);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const name of names) {
        if (seen.has(name)) {
          duplicates.push(name);
        }
        seen.add(name);
      }
      expect(duplicates).toStrictEqual([]);
    });
  });

  describe("all manifests are valid json with expected structure", () => {
    it.each(["manifest.train.json", "manifest.eval.fixed.json", "manifest.eval.pool.json"])(
      "%s is parseable and has packages",
      (file) => {
        const filePath = join(BENCHMARKS_DIR, file);
        expect(existsSync(filePath)).toBeTruthy();
        const raw = JSON.parse(readFileSync(filePath, "utf8"));
        expect(raw.packages).toBeDefined();
        expect(raw.packages).toBeTypeOf("object");

        // At least one tier with at least one package
        const tiers = Object.keys(raw.packages);
        expect(tiers.length).toBeGreaterThan(0);

        let totalPackages = 0;
        for (const tier of tiers) {
          expect(Array.isArray(raw.packages[tier])).toBeTruthy();
          totalPackages += raw.packages[tier].length;
        }
        expect(totalPackages).toBeGreaterThan(0);
      },
    );

    it("holdout manifest exists and is valid", () => {
      const filePath = join(BENCHMARKS_DIR, "manifest.holdout.json");
      if (!existsSync(filePath)) {
        // Holdout is optional
        return;
      }
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      expect(raw.packages).toBeDefined();
    });
  });

  describe("train manifest coverage", () => {
    it("every train package has an expected domain in EXPECTED_DOMAINS", () => {
      const train = loadManifest("train");
      const names = extractPackageNames(train);
      const missing: string[] = [];
      for (const name of names) {
        if (!EXPECTED_DOMAINS[name]) {
          missing.push(name);
        }
      }
      expect(missing).toStrictEqual([]);
    });

    it("every EXPECTED_DOMAINS entry is a train package", () => {
      const train = loadManifest("train");
      const trainNames = new Set(extractPackageNames(train));
      const orphaned: string[] = [];
      for (const name of Object.keys(EXPECTED_DOMAINS)) {
        if (!trainNames.has(name)) {
          orphaned.push(name);
        }
      }
      expect(orphaned).toStrictEqual([]);
    });

    it("every train package appears in at least one pairwise or scenario assertion", () => {
      const train = loadManifest("train");
      const trainNames = extractPackageNames(train);

      const assertionPackages = new Set<string>();
      for (const assertion of PAIRWISE_ASSERTIONS) {
        assertionPackages.add(assertion.higher);
        assertionPackages.add(assertion.lower);
      }
      for (const assertion of SCENARIO_ASSERTIONS) {
        assertionPackages.add(assertion.higher);
        assertionPackages.add(assertion.lower);
      }

      const uncovered: string[] = [];
      for (const name of trainNames) {
        if (!assertionPackages.has(name)) {
          uncovered.push(name);
        }
      }
      expect(uncovered).toStrictEqual([]);
    });

    it("all assertion packages are in the train manifest", () => {
      const train = loadManifest("train");
      const trainNames = new Set(extractPackageNames(train));

      const missingHigher: string[] = [];
      const missingLower: string[] = [];

      for (const assertion of PAIRWISE_ASSERTIONS) {
        if (!trainNames.has(assertion.higher)) {
          missingHigher.push(assertion.higher);
        }
        if (!trainNames.has(assertion.lower)) {
          missingLower.push(assertion.lower);
        }
      }

      expect([...new Set(missingHigher)]).toStrictEqual([]);
      expect([...new Set(missingLower)]).toStrictEqual([]);
    });
  });

  describe("cross-manifest disjointness", () => {
    it("no package appears in all three main manifests", () => {
      const train = new Set(extractPackageNames(loadManifest("train")));
      const evalFixed = new Set(extractPackageNames(loadManifest("eval-fixed")));
      const evalPool = new Set(extractPackageNames(loadManifest("eval-pool")));

      const inAll: string[] = [];
      for (const name of train) {
        if (evalFixed.has(name) && evalPool.has(name)) {
          inAll.push(name);
        }
      }
      expect(inAll).toStrictEqual([]);
    });

    it("holdout is disjoint from train", () => {
      const holdoutPath = join(BENCHMARKS_DIR, "manifest.holdout.json");
      if (!existsSync(holdoutPath)) {
        return;
      }
      const holdoutRaw = JSON.parse(readFileSync(holdoutPath, "utf8")) as BenchmarkManifestV2;
      const holdoutNames = new Set(extractPackageNames(holdoutRaw));
      const trainNames = extractPackageNames(loadManifest("train"));

      const overlap: string[] = [];
      for (const name of trainNames) {
        if (holdoutNames.has(name)) {
          overlap.push(name);
        }
      }
      expect(overlap).toStrictEqual([]);
    });
  });

  describe("tier balance", () => {
    it("train manifest has at least 3 tiers", () => {
      const train = loadManifest("train");
      const tiers = Object.keys(train.packages);
      expect(tiers.length).toBeGreaterThanOrEqual(3);
    });

    it("no single train tier has more than 60% of packages", () => {
      const train = loadManifest("train");
      const flat = flattenManifest(train);
      const total = flat.length;

      for (const [, packages] of Object.entries(train.packages)) {
        const ratio = packages.length / total;
        expect(ratio).toBeLessThanOrEqual(0.6);
      }
    });

    it("eval-pool has at least 50 packages for meaningful sampling", () => {
      const pool = loadManifest("eval-pool");
      const names = extractPackageNames(pool);
      expect(names.length).toBeGreaterThanOrEqual(50);
    });
  });
});
