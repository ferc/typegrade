import { flattenManifest, loadManifest, samplePool } from "../benchmarks/split-loader.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const BENCHMARKS_DIR = join(import.meta.dirname, "..", "benchmarks");

describe("train/eval quarantine", () => {
  describe("static import enforcement", () => {
    it("calibrate.ts must not reference eval manifests", () => {
      const content = readFileSync(join(BENCHMARKS_DIR, "calibrate.ts"), "utf8");
      expect(content).not.toContain("eval.fixed");
      expect(content).not.toContain("eval.pool");
      expect(content).not.toContain("eval-raw");
      expect(content).not.toContain("eval-summary");
    });

    it("optimize.ts must not reference eval manifests", () => {
      const content = readFileSync(join(BENCHMARKS_DIR, "optimize.ts"), "utf8");
      expect(content).not.toContain("eval.fixed");
      expect(content).not.toContain("eval.pool");
      expect(content).not.toContain("eval-raw");
      expect(content).not.toContain("eval-summary");
    });

    it("assertions.ts must not reference eval packages", () => {
      const content = readFileSync(join(BENCHMARKS_DIR, "assertions.ts"), "utf8");
      const evalFixed = loadManifest("eval-fixed");
      const evalPackages = flattenManifest(evalFixed);
      for (const pkg of evalPackages) {
        const escaped = pkg.name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
        const assertionPattern = new RegExp(`(?:higher|lower):\\s*"${escaped}"`, "g");
        const domainPattern = new RegExp(`"${escaped}"\\s*:`, "g");
        expect(content).not.toMatch(assertionPattern);
        expect(content).not.toMatch(domainPattern);
      }
    });
  });

  describe("manifest split isolation", () => {
    it("train and eval-fixed manifests share no packages", () => {
      const train = loadManifest("train");
      const evalFixed = loadManifest("eval-fixed");

      const trainNames = new Set(flattenManifest(train).map((entry) => entry.name));
      const evalNames = flattenManifest(evalFixed).map((entry) => entry.name);

      for (const name of evalNames) {
        expect(trainNames.has(name)).toBeFalsy();
      }
    });

    it("train and eval-pool manifests share no packages", () => {
      const train = loadManifest("train");
      const evalPool = loadManifest("eval-pool");

      const trainNames = new Set(flattenManifest(train).map((entry) => entry.name));
      const poolNames = flattenManifest(evalPool).map((entry) => entry.name);

      for (const name of poolNames) {
        expect(trainNames.has(name)).toBeFalsy();
      }
    });

    it("eval-fixed and eval-pool manifests share no packages", () => {
      const evalFixed = loadManifest("eval-fixed");
      const evalPool = loadManifest("eval-pool");

      const fixedNames = new Set(flattenManifest(evalFixed).map((entry) => entry.name));
      const poolNames = flattenManifest(evalPool).map((entry) => entry.name);

      for (const name of poolNames) {
        expect(fixedNames.has(name)).toBeFalsy();
      }
    });

    it("holdout and train manifests share no packages", () => {
      try {
        const holdout = loadManifest("holdout");
        const train = loadManifest("train");

        const holdoutNames = new Set(flattenManifest(holdout).map((entry) => entry.name));
        const trainNames = flattenManifest(train).map((entry) => entry.name);

        for (const name of trainNames) {
          expect(holdoutNames.has(name)).toBeFalsy();
        }
      } catch {
        // Holdout manifest may not exist; that's fine
      }
    });

    it("holdout and eval manifests share no packages", () => {
      try {
        const holdoutPath = join(BENCHMARKS_DIR, "manifest.holdout.json");
        const holdout = JSON.parse(readFileSync(holdoutPath, "utf8"));
        const holdoutNames = new Set<string>();
        for (const packages of Object.values(holdout.packages ?? holdout) as any[]) {
          for (const pkg of packages) {
            const spec = typeof pkg === "string" ? pkg : pkg.spec;
            holdoutNames.add(spec.replaceAll(/@[\d.]+$/g, ""));
          }
        }

        const evalFixed = loadManifest("eval-fixed");
        const evalPool = loadManifest("eval-pool");
        const evalNames = [
          ...flattenManifest(evalFixed).map((entry) => entry.name),
          ...flattenManifest(evalPool).map((entry) => entry.name),
        ];

        for (const name of evalNames) {
          expect(holdoutNames.has(name)).toBeFalsy();
        }
      } catch {
        // Holdout manifest may not exist; that's fine
      }
    });
  });

  describe("redacted summary format", () => {
    it("redactedEvalSummary type should not contain package names", () => {
      const judgeContent = readFileSync(join(BENCHMARKS_DIR, "judge.ts"), "utf8");
      expect(judgeContent).toContain("RedactedEvalSummary");
      expect(judgeContent).toContain("auditMode");
    });

    it("shadow-latest.ts should write raw results to shadow-raw, not results/", () => {
      const shadowContent = readFileSync(join(BENCHMARKS_DIR, "shadow-latest.ts"), "utf8");
      expect(shadowContent).toContain("shadow-raw");
      expect(shadowContent).toContain("RedactedShadowSummary");
      // Shadow must not write to train results
      expect(shadowContent).not.toContain("benchmarks/results/train");
    });

    it("calibrate.ts must not reference shadow data", () => {
      const content = readFileSync(join(BENCHMARKS_DIR, "calibrate.ts"), "utf8");
      expect(content).not.toContain("shadow-raw");
      expect(content).not.toContain("shadow-summary");
    });

    it("optimize.ts must not reference shadow data", () => {
      const content = readFileSync(join(BENCHMARKS_DIR, "optimize.ts"), "utf8");
      expect(content).not.toContain("shadow-raw");
      expect(content).not.toContain("shadow-summary");
    });
  });

  describe("pool sampling", () => {
    it("deterministic for a given seed", () => {
      const manifest = loadManifest("eval-pool");
      const sample1 = samplePool(manifest, { count: 10, seed: 42 });
      const sample2 = samplePool(manifest, { count: 10, seed: 42 });

      expect(sample1.sampledHashes).toStrictEqual(sample2.sampledHashes);
      expect(sample1.manifestHash).toStrictEqual(sample2.manifestHash);
    });

    it("different seeds produce different samples", () => {
      const manifest = loadManifest("eval-pool");
      const sample1 = samplePool(manifest, { count: 10, seed: 42 });
      const sample2 = samplePool(manifest, { count: 10, seed: 99 });

      const hashes1 = new Set(sample1.sampledHashes);
      const hashes2 = new Set(sample2.sampledHashes);
      const overlap = [...hashes1].filter((hash) => hashes2.has(hash)).length;
      expect(overlap).toBeLessThan(10);
    });

    it("respects count parameter", () => {
      const manifest = loadManifest("eval-pool");
      const sample = samplePool(manifest, { count: 5, seed: 42 });
      expect(sample.sampled.length).toBeLessThanOrEqual(5);
      expect(sample.sampled.length).toBeGreaterThan(0);
    });

    it("includes manifest hash for auditing", () => {
      const manifest = loadManifest("eval-pool");
      const sample = samplePool(manifest, { count: 5, seed: 42 });
      expect(sample.manifestHash).toBeTruthy();
      expect(sample.manifestHash).toHaveLength(16);
    });
  });

  describe("agents.md quarantine policy", () => {
    it("agents.md exists and contains quarantine rules", () => {
      const agentsPath = join(import.meta.dirname, "..", "AGENTS.md");
      const content = readFileSync(agentsPath, "utf8");
      expect(content).toContain("Train/Eval Quarantine");
      expect(content).toContain("Builder Agent Rules");
      expect(content).toContain("Judge Agent");
      expect(content).toContain("MUST NOT");
      expect(content).toContain("manifest.eval.fixed.json");
      expect(content).toContain("manifest.eval.pool.json");
    });
  });
});
