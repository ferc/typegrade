import type { FitCompareResult, SmartCliResult, SmartComparePayload } from "./types.js";
import pc from "picocolors";

/**
 * Render a SmartCliResult as human-readable terminal output.
 */
export function renderSmartResult(sr: SmartCliResult): string {
  switch (sr.mode) {
    case "repo-audit": {
      return renderRepoAudit(sr);
    }
    case "package-score": {
      return renderPackageScore(sr);
    }
    case "package-compare": {
      return renderCompare(sr);
    }
    case "fit-compare": {
      return renderFit(sr);
    }
  }
}

// ---------------------------------------------------------------------------
// Repo audit
// ---------------------------------------------------------------------------

function renderRepoAudit(sr: SmartCliResult): string {
  const lines = [
    "",
    renderTrustBadge(sr),
    pc.bold(`  ${sr.summary.headline}`),
    "",
    pc.bold("  What Matters Most"),
  ];

  for (const entry of sr.summary.scorecard) {
    lines.push(formatScorecardLine(entry));
  }
  lines.push("");

  if (sr.summary.topReasons.length > 0) {
    lines.push(pc.bold("  Strengths"));
    for (const reason of sr.summary.topReasons) {
      lines.push(`    ${pc.green("+")} ${reason}`);
    }
    lines.push("");
  }

  if (sr.summary.topRisks.length > 0) {
    lines.push(pc.bold("  Risks"));
    for (const risk of sr.summary.topRisks) {
      lines.push(`    ${pc.yellow("-")} ${risk}`);
    }
    lines.push("");
  }

  if (sr.nextAction.kind !== "none") {
    lines.push(pc.bold("  Next Best Improvement"));
    lines.push(`    ${sr.nextAction.title}`);
    if (sr.nextAction.why) {
      lines.push(`    ${pc.dim(sr.nextAction.why)}`);
    }
    if (sr.nextAction.files.length > 0) {
      lines.push(`    Files: ${sr.nextAction.files.join(", ")}`);
    }
    lines.push("");
  }

  const caveats = buildCaveats(sr);
  if (caveats.length > 0) {
    lines.push(pc.dim("  Caveats"));
    for (const caveat of caveats) {
      lines.push(pc.dim(`    ${caveat}`));
    }
    lines.push("");
  }

  if (sr.supplements.monorepo) {
    const mh = sr.supplements.monorepo;
    lines.push(
      pc.dim(
        `  Workspace: ${mh.totalPackages} packages, health ${mh.healthScore}/100 (${mh.healthGrade})`,
      ),
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Package score
// ---------------------------------------------------------------------------

function renderPackageScore(sr: SmartCliResult): string {
  const lines = [
    "",
    renderTrustBadge(sr),
    pc.bold(`  ${sr.summary.headline}`),
    "",
    pc.bold("  Why It Scored This Way"),
  ];

  for (const entry of sr.summary.scorecard) {
    lines.push(formatScorecardLine(entry));
  }
  lines.push("");

  if (sr.summary.topReasons.length > 0) {
    for (const reason of sr.summary.topReasons) {
      lines.push(`    ${pc.green("+")} ${reason}`);
    }
  }
  if (sr.summary.topRisks.length > 0) {
    for (const risk of sr.summary.topRisks) {
      lines.push(`    ${pc.yellow("-")} ${risk}`);
    }
  }
  if (sr.summary.topReasons.length > 0 || sr.summary.topRisks.length > 0) {
    lines.push("");
  }

  const caveats = buildCaveats(sr);
  if (caveats.length > 0) {
    lines.push(pc.dim("  Caveats"));
    for (const caveat of caveats) {
      lines.push(pc.dim(`    ${caveat}`));
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function renderCompare(sr: SmartCliResult): string {
  const payload = sr.primary as SmartComparePayload;
  const lines = [
    "",
    renderTrustBadge(sr),
    pc.bold(`  ${sr.summary.headline}`),
    `  Confidence: ${Math.round(payload.decision.decisionConfidence * 100)}%`,
    "",
  ];

  if (sr.summary.topReasons.length > 0) {
    lines.push(pc.bold("  Why"));
    for (const reason of sr.summary.topReasons) {
      lines.push(`    ${reason}`);
    }
    lines.push("");
  }

  const caveats = [...sr.summary.topRisks, ...buildCaveats(sr)];
  if (caveats.length > 0) {
    lines.push(pc.dim("  Caveats"));
    for (const caveat of caveats) {
      lines.push(pc.dim(`    ${caveat}`));
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fit compare
// ---------------------------------------------------------------------------

function renderFit(sr: SmartCliResult): string {
  const result = sr.primary as FitCompareResult;
  const lines = [
    "",
    renderTrustBadge(sr),
    pc.bold(`  ${sr.summary.headline}`),
    `  Confidence: ${Math.round(result.adoptionDecision.decisionConfidence * 100)}%`,
    "",
  ];

  if (sr.summary.topReasons.length > 0) {
    lines.push(pc.bold("  Why"));
    for (const reason of sr.summary.topReasons) {
      lines.push(`    ${reason}`);
    }
    lines.push("");
  }

  const caveats = [...sr.summary.topRisks, ...buildCaveats(sr)];
  if (caveats.length > 0) {
    lines.push(pc.dim("  Caveats"));
    for (const caveat of caveats) {
      lines.push(pc.dim(`    ${caveat}`));
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function renderTrustBadge(sr: SmartCliResult): string {
  const tc = sr.trust.classification;
  if (tc === "abstained") {
    return pc.red(`  Abstained: ${sr.trust.reasons[0] ?? "unknown"}`);
  }
  if (tc === "directional") {
    return pc.yellow(`  Directional: ${sr.trust.reasons[0] ?? "reduced confidence"}`);
  }
  return pc.green("  Trusted");
}

function formatScorecardLine(entry: {
  label: string;
  score: number | null;
  grade: string | null;
}): string {
  if (entry.score === null) {
    return `    ${entry.label.padEnd(20)} ${pc.dim("N/A")}`;
  }
  return `    ${entry.label.padEnd(20)} ${scoreColor(entry.score)(`${entry.score}/100`)} ${pc.dim(`(${entry.grade})`)}`;
}

function scoreColor(score: number): (str: string) => string {
  if (score >= 80) {
    return pc.green;
  }
  if (score >= 60) {
    return pc.yellow;
  }
  return pc.red;
}

function buildCaveats(sr: SmartCliResult): string[] {
  const caveats: string[] = [];
  if (sr.trust.classification === "directional") {
    caveats.push("Scores are directional — use for guidance, not gating");
  }
  if (sr.trust.classification === "abstained") {
    caveats.push("Analysis was abstained — results should not be used for decisions");
  }
  return caveats;
}
