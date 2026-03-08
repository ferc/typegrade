import type { AnalysisResult, DimensionResult } from "../types.js";
import pc from "picocolors";

const BAR_WIDTH = 20;

function renderBar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const filledStr = "\u2588".repeat(filled);
  const emptyStr = "\u2591".repeat(empty);

  let color: (str: string) => string = pc.red;
  if (score >= 80) {color = pc.green;}
  else if (score >= 60) {color = pc.yellow;}
  else if (score >= 40) {color = pc.magenta;}

  return color(filledStr) + pc.dim(emptyStr);
}

function gradeColor(grade: string): (str: string) => string {
  if (grade.startsWith("A")) {return pc.green;}
  if (grade === "B") {return pc.yellow;}
  if (grade === "C") {return pc.magenta;}
  return pc.red;
}

function severityIcon(severity: string): string {
  if (severity === "error") {return pc.red("\u2716");}
  if (severity === "warning") {return pc.yellow("\u26A0");}
  return pc.blue("\u2139");
}

function compositeLabel(key: string): string {
  switch (key) {
    case "agentReadiness": {
      return "Agent Readiness";
    }
    case "consumerApi": {
      return "Consumer API";
    }
    case "implementationQuality": {
      return "Implementation";
    }
    default: {
      return key;
    }
  }
}

export function renderReport(result: AnalysisResult): string {
  const lines: string[] = [
    "",
    pc.bold("  tsguard v0.3.0"),
    "",
  ];

  const modeLabel = result.mode === "package" ? "package analysis" : "source analysis";
  lines.push(`  Project: ${pc.bold(result.projectName)} (${modeLabel})`);
  lines.push(`  Files: ${result.filesAnalyzed} analyzed in ${(result.timeMs / 1000).toFixed(1)}s`);
  if (result.domainInference && result.domainInference.confidence >= 0.5) {
    lines.push(`  Domain: ${result.domainInference.domain} (${Math.round(result.domainInference.confidence * 100)}% confidence)`);
  }
  lines.push("");

  // Composite scores box
  const boxWidth = 43;
  lines.push(`  \u2554${"═".repeat(boxWidth)}\u2557`);
  for (const comp of result.composites) {
    const label = compositeLabel(comp.key);
    const scoreStr = comp.score === null ? "n/a" : `${comp.score}/100`;
    const gradeStr = comp.grade === "N/A" ? "" : ` (${comp.grade})`;
    const gc = gradeColor(comp.grade);
    const line = `${`${label}:`.padEnd(22)}${scoreStr}${gradeStr}`;
    lines.push(`  \u2551  ${gc(line.padEnd(boxWidth - 2))}\u2551`);
  }
  lines.push(`  \u255A${"═".repeat(boxWidth)}\u255D`);
  lines.push("");

  // Split into consumer and implementation
  const consumerKeys = new Set([
    "apiSpecificity",
    "apiSafety",
    "semanticLift",
    "publishQuality",
    "surfaceCoherence",
    "declarationFidelity",
  ]);
  const consumerView = result.dimensions.filter((dim) => consumerKeys.has(dim.key));
  const implView = result.dimensions.filter((dim) =>
    ["implementationSoundness", "boundaryDiscipline", "configDiscipline"].includes(dim.key),
  );

  if (consumerView.length > 0) {
    lines.push(pc.bold("  Consumer API Dimensions:"));
    for (const dim of consumerView) {
      renderDimLine(lines, dim);
    }
    lines.push("");
  }

  if (implView.some((dim) => dim.enabled)) {
    lines.push(pc.bold("  Implementation Dimensions:"));
    for (const dim of implView) {
      renderDimLine(lines, dim);
    }
    lines.push("");
  }

  // Caveats
  if (result.caveats.length > 0) {
    for (const caveat of result.caveats) {
      lines.push(`  ${pc.yellow("\u26A0")} ${pc.dim(caveat)}`);
    }
    lines.push("");
  }

  // Top issues
  if (result.topIssues.length > 0) {
    lines.push(pc.bold("  Top issues:"));
    for (const issue of result.topIssues.slice(0, 10)) {
      const icon = severityIcon(issue.severity);
      const loc = issue.file ? `${issue.file}:${issue.line}` : "";
      lines.push(`   ${icon}  ${pc.dim(loc)} \u2014 ${issue.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function isDiagnosticOnly(dim: DimensionResult): boolean {
  return dim.enabled && Object.keys(dim.weights).length === 0;
}

function renderDimLine(lines: string[], dim: DimensionResult): void {
  const diagnostic = isDiagnosticOnly(dim);
  const suffix = diagnostic ? pc.dim(" (diagnostic)") : "";
  const name = dim.label.padEnd(22);
  if (!dim.enabled || dim.score === null) {
    lines.push(`  ${name}${pc.dim("n/a")}`);
  } else {
    const bar = renderBar(dim.score);
    const pct = `${Math.round(dim.score)}%`.padStart(4);
    lines.push(`  ${name}${bar}  ${pct}${suffix}`);
  }
}

export function renderDimensionTable(dimensions: DimensionResult[]): string {
  const lines: string[] = [];
  for (const dim of dimensions) {
    if (!dim.enabled) {continue;}
    lines.push(
      `\n  ${pc.bold(dim.label)} (${dim.score === null ? "n/a" : Math.round(dim.score)}/100)`,
    );
    for (const positive of dim.positives) {
      lines.push(`    ${pc.green("+")} ${positive}`);
    }
    for (const negative of dim.negatives) {
      lines.push(`    ${pc.red("-")} ${negative}`);
    }
  }
  return lines.join("\n");
}

export function renderJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}
