import type { DimensionResult, Issue } from "../types.js";
import { Node, type TypeNode } from "ts-morph";
import { DIMENSION_CONFIGS } from "../constants.js";
import type { PublicSurface, SurfaceMethod, SurfaceTypeParam } from "../surface/index.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiExpressiveness")!;

function countGenericCorrelation(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: Array<{ name: string; typeNode: TypeNode | undefined }>,
  returnTypeNode: TypeNode | undefined,
): number {
  if (typeParams.length === 0 || !returnTypeNode) {return 0;}
  let count = 0;
  const paramNames = new Set(typeParams.map((tp) => tp.name));
  const returnText = returnTypeNode.getText();
  for (const name of paramNames) {
    const usedInParams = paramTypeNodes.some((p) => {
      return p.typeNode && p.typeNode.getText().includes(name);
    });
    if (usedInParams && returnText.includes(name)) {
      count++;
    }
  }
  return count;
}

interface FeatureCounts {
  constrainedGenerics: number;
  genericCorrelation: number;
  mappedTypes: number;
  conditionalTypes: number;
  inferTypes: number;
  indexedAccess: number;
  templateLiterals: number;
  discriminatedUnions: number;
  tuples: number;
  overloads: number;
  totalDeclarations: number;
}

export function analyzeApiExpressiveness(surface: PublicSurface): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  const counts: FeatureCounts = {
    conditionalTypes: 0,
    constrainedGenerics: 0,
    discriminatedUnions: 0,
    genericCorrelation: 0,
    indexedAccess: 0,
    inferTypes: 0,
    mappedTypes: 0,
    overloads: 0,
    templateLiterals: 0,
    totalDeclarations: 0,
    tuples: 0,
  };

  for (const decl of surface.declarations) {
    // Variables are not counted in expressiveness
    if (decl.kind === "variable") {continue;}

    counts.totalDeclarations++;

    // Count constrained type parameters
    for (const tp of decl.typeParameters) {
      if (tp.hasConstraint) {counts.constrainedGenerics++;}
    }

    switch (decl.kind) {
      case "function": {
        // Generic correlation
        counts.genericCorrelation += countGenericCorrelation(
          decl.typeParameters,
          decl.paramTypeNodes ?? [],
          decl.returnTypeNode,
        );
        // Overloads
        if ((decl.overloadCount ?? 0) > 0) {
          counts.overloads += decl.overloadCount!;
        }
        // Walk param + return type nodes
        for (const pos of decl.positions) {
          if (pos.typeNode) {walkTypeNode(pos.typeNode, counts);}
        }
        break;
      }
      case "interface": {
        // Method generic correlation
        for (const method of decl.methods ?? []) {
          counts.genericCorrelation += countGenericCorrelation(
            method.typeParameters,
            method.paramTypeNodes,
            method.returnTypeNode,
          );
        }
        // Walk property type nodes only (not methods — matches original behavior)
        for (const pos of decl.positions) {
          if (pos.typeNode) {walkTypeNode(pos.typeNode, counts);}
        }
        break;
      }
      case "class": {
        // Method generic correlation + overloads
        for (const method of decl.methods ?? []) {
          counts.genericCorrelation += countGenericCorrelation(
            method.typeParameters,
            method.paramTypeNodes,
            method.returnTypeNode,
          );
          if (method.overloadCount > 0) {counts.overloads += method.overloadCount;}
        }
        // Walk method type nodes + property type nodes
        for (const method of decl.methods ?? []) {
          for (const pos of method.positions) {
            if (pos.typeNode) {walkTypeNode(pos.typeNode, counts);}
          }
        }
        for (const pos of decl.positions) {
          if (pos.role === "property" && pos.typeNode) {
            walkTypeNode(pos.typeNode, counts);
          }
        }
        break;
      }
      case "type-alias": {
        // Walk body type node
        if (decl.bodyTypeNode) {
          walkTypeNode(decl.bodyTypeNode, counts);
        }
        break;
      }
      // enum: just counted as declaration, no feature analysis
    }
  }

  if (counts.totalDeclarations === 0) {
    return {
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: counts as unknown as Record<string, number>,
      negatives: ["No exported declarations found"],
      positives: [],
      score: 0,
      weights: CONFIG.weights,
    };
  }

  // Presence-based scoring: each category contributes if present, independent of library size
  let score = 0;

  if (counts.genericCorrelation > 0) {
    score += 18;
    positives.push(`${counts.genericCorrelation} correlated generic(s)`);
  }
  if (counts.constrainedGenerics > 0) {
    score += 15;
    positives.push(`${counts.constrainedGenerics} constrained generic(s)`);
  }
  if (counts.mappedTypes > 0) {
    score += 12;
    positives.push(`${counts.mappedTypes} mapped type(s)`);
  }
  if (counts.conditionalTypes > 0) {
    score += 12;
    positives.push(`${counts.conditionalTypes} conditional type(s)`);
  }
  if (counts.inferTypes > 0) {
    score += 10;
    positives.push(`${counts.inferTypes} infer type(s)`);
  }
  if (counts.templateLiterals > 0) {
    score += 10;
    positives.push(`${counts.templateLiterals} template literal(s)`);
  }
  if (counts.discriminatedUnions > 0) {
    score += 10;
    positives.push(`${counts.discriminatedUnions} discriminated union(s)`);
  }
  if (counts.indexedAccess > 0) {
    score += 8;
    positives.push(`${counts.indexedAccess} indexed access type(s)`);
  }
  if (counts.tuples > 0) {
    score += 5;
    positives.push(`${counts.tuples} tuple type(s)`);
  }

  score = Math.min(100, score);

  if (score < 30) {negatives.push("Limited use of advanced type-system features");}

  return {
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: counts as unknown as Record<string, number>,
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

function walkTypeNode(node: Node, counts: FeatureCounts): void {
  node.forEachDescendant((child) => {
    if (Node.isMappedTypeNode(child)) {counts.mappedTypes++;}
    if (Node.isConditionalTypeNode(child)) {counts.conditionalTypes++;}
    if (Node.isInferTypeNode(child)) {counts.inferTypes++;}
    if (Node.isIndexedAccessTypeNode(child)) {counts.indexedAccess++;}
    if (Node.isTemplateLiteralTypeNode(child)) {counts.templateLiterals++;}
    if (Node.isTupleTypeNode(child)) {counts.tuples++;}
    // Discriminated union: union of type literals with a shared property
    if (Node.isUnionTypeNode(child)) {
      const memberNodes = child.getTypeNodes();
      if (memberNodes.length >= 2 && memberNodes.every((member) => Node.isTypeLiteral(member))) {
        counts.discriminatedUnions++;
      }
    }
  });
}
