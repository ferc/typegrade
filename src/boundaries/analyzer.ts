import type {
  BoundaryFindingCategory,
  BoundaryInventoryEntry,
  BoundaryQualityScore,
  BoundarySummary,
  Grade,
} from "../types.js";
import type { BoundaryGraph, BoundaryNode } from "./types.js";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { classifyBoundaryType, classifyTrustLevel, getFileContext } from "./classifier.js";

/** Validation library identifiers that indicate downstream validation */
const VALIDATION_IDENTIFIERS = new Set([
  "parse",
  "safeParse",
  "validate",
  "check",
  "assert",
  "decode",
  "coerce",
  "transform",
  "guard",
  "is",
  "refine",
  "superRefine",
  "pipe",
  "schema",
  "zodSchema",
  "z.object",
  "z.string",
  "z.number",
  "z.array",
  "z.enum",
  "z.union",
  "z.intersection",
  "t.type",
  "t.interface",
  "Type.Object",
  "object",
  "string",
  "number",
  "boolean",
]);

/**
 * Check if a call expression has downstream validation within the same scope.
 */
function hasNearbyValidation(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) {
    return false;
  }

  // Look at siblings after this node in the same block
  const block = node.getFirstAncestorByKind(SyntaxKind.Block);
  if (!block) {
    return false;
  }

  const statements = block.getStatements();
  const nodeStartLine = node.getStartLineNumber();

  // Check next 5 statements for validation patterns
  let foundNode = false;
  let statementsChecked = 0;
  for (const stmt of statements) {
    if (stmt.getStartLineNumber() >= nodeStartLine) {
      foundNode = true;
    }
    if (!foundNode) {
      continue;
    }
    if (statementsChecked > 5) {
      break;
    }
    statementsChecked++;

    const text = stmt.getText();
    for (const id of VALIDATION_IDENTIFIERS) {
      if (text.includes(id)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Analyze boundary patterns in a single source file.
 */
function analyzeFileBoundaries(sf: SourceFile): BoundaryNode[] {
  const nodes: BoundaryNode[] = [];
  const filePath = sf.getFilePath();
  const fileContext = getFileContext(filePath);

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const exprText = node.getExpression().getText();
    const boundaryType = classifyBoundaryType(exprText);

    if (boundaryType === "unknown") {
      return;
    }

    const trustLevel = classifyTrustLevel(boundaryType, fileContext);
    const hasValidation = hasNearbyValidation(node);

    nodes.push({
      boundaryType,
      column: node.getStart() - node.getStartLinePos() + 1,
      description: `${exprText} call`,
      expression: exprText,
      file: filePath,
      hasDownstreamValidation: hasValidation,
      line: node.getStartLineNumber(),
      trustLevel,
    });
  });

  // Also detect process.env access
  sf.forEachDescendant((node) => {
    if (!Node.isPropertyAccessExpression(node)) {
      return;
    }
    const text = node.getText();
    if (text.startsWith("process.env.") || text === "process.env") {
      const fileContext2 = getFileContext(filePath);
      nodes.push({
        boundaryType: "env",
        column: node.getStart() - node.getStartLinePos() + 1,
        description: `Environment variable access: ${text}`,
        expression: text,
        file: filePath,
        hasDownstreamValidation: false,
        line: node.getStartLineNumber(),
        trustLevel: classifyTrustLevel("env", fileContext2),
      });
    }
  });

  return nodes;
}

/**
 * Build the boundary graph for a project.
 */
export function buildBoundaryGraph(sourceFiles: SourceFile[], _project: Project): BoundaryGraph {
  const allNodes: BoundaryNode[] = [];

  for (const sf of sourceFiles) {
    const fileNodes = analyzeFileBoundaries(sf);
    allNodes.push(...fileNodes);
  }

  // Taint edges: for now, identify unvalidated boundaries at untrusted sources
  // A full taint analysis would track data flow through assignments
  const taintEdges = allNodes
    .filter((nd) => !nd.hasDownstreamValidation && nd.trustLevel === "untrusted-external")
    .map((nd) => ({
      isValidated: false,
      sinkDescription: "Unvalidated boundary usage",
      sinkFile: nd.file,
      sinkLine: nd.line,
      source: nd,
    }));

  return { nodes: allNodes, taintEdges };
}

/**
 * Classify a boundary inventory entry into a finding category.
 *
 * Categories distinguish library public API boundaries from application runtime
 * boundaries, internal tooling with trusted-local data, and cross-package trust
 * boundaries in monorepos.
 */
function classifyBoundaryFinding(entry: BoundaryInventoryEntry): BoundaryFindingCategory {
  if (entry.trustLevel === "trusted-local" || entry.trustLevel === "generated-local") {
    return "tooling-trusted-local";
  }
  if (entry.trustLevel === "internal-only") {
    return "library-public-boundary";
  }
  if (
    entry.boundaryType === "network" ||
    entry.boundaryType === "queue" ||
    entry.boundaryType === "database"
  ) {
    return "application-runtime-boundary";
  }
  return "library-public-boundary";
}

/**
 * Build the boundary summary from a boundary graph.
 */
export function buildBoundarySummary(graph: BoundaryGraph): BoundarySummary {
  const validated = graph.nodes.filter((nd) => nd.hasDownstreamValidation);
  const unvalidated = graph.nodes.filter((nd) => !nd.hasDownstreamValidation);
  const total = graph.nodes.length;

  const boundaryCoverage = total > 0 ? validated.length / total : 1;

  const missingValidationHotspots = unvalidated
    .filter(
      (nd) => nd.trustLevel === "untrusted-external" || nd.trustLevel === "semi-trusted-external",
    )
    .map((nd) => ({
      boundaryType: nd.boundaryType,
      file: nd.file,
      line: nd.line,
      trustLevel: nd.trustLevel,
    }));

  const trustedLocalSuppressions = graph.nodes
    .filter((nd) => nd.trustLevel === "trusted-local" && !nd.hasDownstreamValidation)
    .map((nd) => ({
      file: nd.file,
      line: nd.line,
      reason: `${nd.boundaryType} in trusted-local context (${nd.expression})`,
    }));

  const taintBreaks = graph.taintEdges.map((edge) => ({
    file: edge.sinkFile,
    line: edge.sinkLine,
    sink: edge.sinkDescription,
    source: edge.source.expression,
  }));

  return {
    boundaryCoverage: Math.round(boundaryCoverage * 100) / 100,
    inventory: graph.nodes.map((nd) => {
      const entry: BoundaryInventoryEntry = {
        boundaryType: nd.boundaryType,
        description: nd.description,
        file: nd.file,
        hasValidation: nd.hasDownstreamValidation,
        line: nd.line,
        trustLevel: nd.trustLevel,
      };
      entry.findingCategory = classifyBoundaryFinding(entry);
      return entry;
    }),
    missingValidationHotspots,
    taintBreaks,
    totalBoundaries: total,
    trustedLocalSuppressions,
    unvalidatedBoundaries: unvalidated.length,
    validatedBoundaries: validated.length,
  };
}

/**
 * Compute the boundary quality score from a boundary summary.
 */
export function computeBoundaryQuality(summary: BoundarySummary): BoundaryQualityScore {
  const rationale: string[] = [];
  // Baseline
  let score = 50;

  if (summary.totalBoundaries === 0) {
    return {
      grade: "N/A" as Grade,
      rationale: ["No boundaries detected"],
      score: 0,
      totalBoundaries: 0,
      trustModelAccuracy: 1,
      validatedRatio: 1,
    };
  }

  // Validation coverage: 0-40 points
  const validationPoints = Math.round(summary.boundaryCoverage * 40);
  // Centered at 50
  score += validationPoints - 20;
  rationale.push(
    `Validation coverage: ${Math.round(summary.boundaryCoverage * 100)}% (${validationPoints}/40 points)`,
  );

  // Penalize unvalidated untrusted boundaries
  const untrustedUnvalidated = summary.missingValidationHotspots.length;
  if (untrustedUnvalidated > 0) {
    const penalty = Math.min(untrustedUnvalidated * 5, 30);
    score -= penalty;
    rationale.push(`${untrustedUnvalidated} unvalidated untrusted boundary(ies) (-${penalty})`);
  }

  // Bonus for trusted-local suppressions (indicates awareness)
  if (summary.trustedLocalSuppressions.length > 0) {
    const bonus = Math.min(summary.trustedLocalSuppressions.length * 2, 10);
    score += bonus;
    rationale.push(
      `${summary.trustedLocalSuppressions.length} trusted-local suppression(s) (+${bonus})`,
    );
  }

  score = Math.max(0, Math.min(100, score));

  const trustModelAccuracy =
    summary.totalBoundaries > 0
      ? 1 - summary.missingValidationHotspots.length / summary.totalBoundaries
      : 1;

  let grade: Grade = "F";
  if (score >= 95) {
    grade = "A+";
  } else if (score >= 85) {
    grade = "A";
  } else if (score >= 70) {
    grade = "B";
  } else if (score >= 55) {
    grade = "C";
  } else if (score >= 40) {
    grade = "D";
  }

  return {
    grade,
    rationale,
    score,
    totalBoundaries: summary.totalBoundaries,
    trustModelAccuracy: Math.round(trustModelAccuracy * 100) / 100,
    validatedRatio: summary.boundaryCoverage,
  };
}
