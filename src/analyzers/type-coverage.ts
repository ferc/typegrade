import { Project, SyntaxKind, TypeFlags, Node } from "ts-morph";
import { DEFAULT_WEIGHTS } from "../constants.js";
import type { DimensionResult, Issue } from "../types.js";
import { getSourceFiles, type GetSourceFilesOptions } from "../utils/project-loader.js";

export function analyzeTypeCoverage(project: Project, sourceFilesOptions?: GetSourceFilesOptions): DimensionResult {
  const issues: Issue[] = [];
  const details: string[] = [];
  const sourceFiles = getSourceFiles(project, sourceFilesOptions);

  let totalIdentifiers = 0;
  let anyIdentifiers = 0;
  let explicitAnyCount = 0;

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();

    // Walk all variable declarations, parameters, and return types
    sf.forEachDescendant((node) => {
      // Skip catch clause variable declarations — TS types these as unknown/any
      if (Node.isCatchClause(node)) return;

      if (
        Node.isVariableDeclaration(node) ||
        Node.isParameterDeclaration(node) ||
        Node.isPropertyDeclaration(node) ||
        Node.isPropertySignature(node)
      ) {
        totalIdentifiers++;
        const type = node.getType();
        if (type.getFlags() & TypeFlags.Any) {
          anyIdentifiers++;

          // Check if it has an explicit `any` annotation
          const typeNode = node.getTypeNode();
          if (typeNode && typeNode.getText() === "any") {
            explicitAnyCount++;
          }

          const line = node.getStartLineNumber();
          const col = node.getStart() - node.getStartLinePos() + 1;
          issues.push({
            file: filePath,
            line,
            column: col,
            message: `'${node.getName?.() ?? "unknown"}' has type 'any'`,
            severity: "warning",
            dimension: "Type Coverage",
          });
        }
      }
    });
  }

  const score =
    totalIdentifiers === 0
      ? 100
      : Math.round(((totalIdentifiers - anyIdentifiers) / totalIdentifiers) * 100);

  details.push(`${totalIdentifiers} identifiers analyzed`);
  details.push(`${anyIdentifiers} typed as 'any' (${explicitAnyCount} explicit)`);
  details.push(`Coverage: ${score}%`);

  return {
    name: "Type Coverage",
    score,
    weight: DEFAULT_WEIGHTS.typeCoverage,
    details,
    issues,
  };
}
