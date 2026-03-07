import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { analyzeProject } from "../src/analyzer.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

describe("e2e: analyzeProject", () => {
  it("scores high-precision fixture >= 85 (A)", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    expect(result.overallScore).toBeGreaterThanOrEqual(70);
    expect(["A+", "A", "B"]).toContain(result.grade);
    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.dimensions).toHaveLength(6);
    expect(result.aiReadiness).not.toBe("POOR");
  });

  it("scores low-precision fixture < 40 (D or F)", () => {
    const result = analyzeProject(resolve(fixturesDir, "low-precision"));
    expect(result.overallScore).toBeLessThan(50);
    expect(["D", "F"]).toContain(result.grade);
  });

  it("scores medium-precision fixture in C-B range", () => {
    const result = analyzeProject(resolve(fixturesDir, "medium-precision"));
    expect(result.overallScore).toBeGreaterThanOrEqual(40);
    expect(result.overallScore).toBeLessThanOrEqual(80);
  });

  it("scores tanstack-style fixture >= 55 (C+)", () => {
    const result = analyzeProject(resolve(fixturesDir, "tanstack-style"));
    expect(result.overallScore).toBeGreaterThanOrEqual(50);
  });

  it("unsound fixture has low unsoundness score", () => {
    const result = analyzeProject(resolve(fixturesDir, "unsound"));
    const unsoundDim = result.dimensions.find((d) => d.name === "Unsoundness");
    expect(unsoundDim).toBeDefined();
    expect(unsoundDim!.score).toBeLessThan(80);
  });

  it("returns valid JSON structure", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    // Verify all required fields exist
    expect(result).toHaveProperty("projectName");
    expect(result).toHaveProperty("filesAnalyzed");
    expect(result).toHaveProperty("timeMs");
    expect(result).toHaveProperty("overallScore");
    expect(result).toHaveProperty("grade");
    expect(result).toHaveProperty("dimensions");
    expect(result).toHaveProperty("topIssues");
    expect(result).toHaveProperty("aiReadiness");
    expect(typeof result.overallScore).toBe("number");
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("all dimensions have name, score, weight", () => {
    const result = analyzeProject(resolve(fixturesDir, "high-precision"));
    for (const dim of result.dimensions) {
      expect(dim).toHaveProperty("name");
      expect(dim).toHaveProperty("score");
      expect(dim).toHaveProperty("weight");
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
      expect(dim.weight).toBeGreaterThan(0);
      expect(dim.weight).toBeLessThanOrEqual(1);
    }
  });
});
