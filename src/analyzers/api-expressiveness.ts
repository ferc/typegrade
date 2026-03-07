import type { DimensionResult, Issue } from "../types.js";
import { Node, type ParameterDeclaration, type SourceFile, type TypeParameterDeclaration } from "ts-morph";
import { DIMENSION_CONFIGS } from "../constants.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "apiExpressiveness")!;

function countGenericCorrelation(
  typeParams: TypeParameterDeclaration[],
  params: ParameterDeclaration[],
  returnTypeNode: { getText(): string } | undefined,
): number {
  if (typeParams.length === 0 || !returnTypeNode) {return 0;}
  let count = 0;
  const paramNames = new Set(typeParams.map((tp) => tp.getName()));
  const returnText = returnTypeNode.getText();
  for (const name of paramNames) {
    const usedInParams = params.some((param) => {
      const typeNode = param.getTypeNode();
      return typeNode && typeNode.getText().includes(name);
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

export function analyzeApiExpressiveness(sourceFiles: SourceFile[]): DimensionResult {
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

  for (const sf of sourceFiles) {
    // Exported functions
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      counts.totalDeclarations++;

      const typeParams = fn.getTypeParameters();
      for (const tp of typeParams) {
        const constraint = tp.getConstraint();
        if (constraint) {
          counts.constrainedGenerics++;
        }
      }

      // Generic correlation: same type param in params and return
      counts.genericCorrelation += countGenericCorrelation(
        typeParams,
        fn.getParameters(),
        fn.getReturnTypeNode(),
      );

      // Overloads
      const overloads = fn.getOverloads();
      if (overloads.length > 0) {
        counts.overloads += overloads.length;
      }
    }

    // Exported interfaces
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      counts.totalDeclarations++;

      const typeParams = iface.getTypeParameters();
      for (const tp of typeParams) {
        if (tp.getConstraint()) {counts.constrainedGenerics++;}
      }

      // Check methods for generic correlation
      for (const method of iface.getMethods()) {
        counts.genericCorrelation += countGenericCorrelation(
          method.getTypeParameters(),
          method.getParameters(),
          method.getReturnTypeNode(),
        );
      }
    }

    // Exported type aliases
    for (const alias of sf.getTypeAliases()) {
      if (!alias.isExported()) {continue;}
      counts.totalDeclarations++;

      const typeParams = alias.getTypeParameters();
      for (const tp of typeParams) {
        if (tp.getConstraint()) {counts.constrainedGenerics++;}
      }

      // Walk type node for advanced features
      const typeNode = alias.getTypeNode();
      if (typeNode) {
        walkTypeNode(typeNode, counts);
      }
    }

    // Walk all exported declarations for advanced type nodes
    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) {continue;}
      for (const param of fn.getParameters()) {
        const typeNode = param.getTypeNode();
        if (typeNode) {walkTypeNode(typeNode, counts);}
      }
      const returnTypeNode = fn.getReturnTypeNode();
      if (returnTypeNode) {walkTypeNode(returnTypeNode, counts);}
    }

    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) {continue;}
      for (const prop of iface.getProperties()) {
        const typeNode = prop.getTypeNode();
        if (typeNode) {walkTypeNode(typeNode, counts);}
      }
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

