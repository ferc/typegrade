import pc from "picocolors";
import type { AnalysisResult, DimensionResult } from "../types.js";

const BAR_WIDTH = 20;

function renderBar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const filledStr = "█".repeat(filled);
  const emptyStr = "░".repeat(empty);

  let color: (s: string) => string;
  if (score >= 80) color = pc.green;
  else if (score >= 60) color = pc.yellow;
  else if (score >= 40) color = pc.magenta;
  else color = pc.red;

  return color(filledStr) + pc.dim(emptyStr);
}

function gradeColor(grade: string): (s: string) => string {
  if (grade.startsWith("A")) return pc.green;
  if (grade === "B") return pc.yellow;
  if (grade === "C") return pc.magenta;
  return pc.red;
}

function severityIcon(severity: string): string {
  if (severity === "error") return pc.red("✖");
  if (severity === "warning") return pc.yellow("⚠");
  return pc.blue("ℹ");
}

export function renderReport(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(pc.bold(`  tsguard v0.1.0`));
  lines.push("");
  lines.push(`  Project: ${pc.bold(result.projectName)}`);
  lines.push(
    `  Files: ${result.filesAnalyzed} analyzed in ${(result.timeMs / 1000).toFixed(1)}s`,
  );
  lines.push("");

  const gc = gradeColor(result.grade);
  const scoreStr = `  Score: ${result.overallScore}/100 (${result.grade})`;
  const readinessStr = `  AI Agent Readiness: ${result.aiReadiness}`;
  const boxWidth = 43;

  lines.push(`  ╔${"═".repeat(boxWidth)}╗`);
  lines.push(`  ║  ${gc(scoreStr.trim().padEnd(boxWidth - 2))}║`);
  lines.push(`  ║  ${readinessStr.trim().padEnd(boxWidth - 2)}║`);
  lines.push(`  ╚${"═".repeat(boxWidth)}╝`);
  lines.push("");

  // Sort dimensions by weight descending for display
  const sorted = [...result.dimensions].sort((a, b) => b.weight - a.weight);

  for (const dim of sorted) {
    const name = dim.name.padEnd(20);
    const bar = renderBar(dim.score);
    const pct = `${Math.round(dim.score)}%`.padStart(4);
    const annotation =
      dim.weight >= 0.3 ? pc.dim(" ← most impactful") : "";
    lines.push(`  ${name}${bar}  ${pct}${annotation}`);
  }

  if (result.topIssues.length > 0) {
    lines.push("");
    lines.push(pc.bold("  Top issues:"));
    for (const issue of result.topIssues.slice(0, 10)) {
      const icon = severityIcon(issue.severity);
      const loc = issue.file
        ? `${issue.file}:${issue.line}`
        : "";
      lines.push(`   ${icon}  ${pc.dim(loc)} — ${issue.message}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function renderDimensionTable(dimensions: DimensionResult[]): string {
  const lines: string[] = [];
  for (const dim of dimensions) {
    lines.push(`\n  ${pc.bold(dim.name)} (${Math.round(dim.score)}/100)`);
    for (const detail of dim.details) {
      lines.push(`    ${pc.dim("·")} ${detail}`);
    }
  }
  return lines.join("\n");
}

export function renderJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}
