import type {
  BoundarySource,
  BoundaryType,
  TaintFlowChain,
  TaintFlowStep,
  ValidationSink,
} from "../types.js";
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";

// --- Source classification patterns ---

/** Mapping from boundary type to boundary source classification */
const BOUNDARY_TYPE_TO_SOURCE: Record<string, BoundarySource> = {
  IPC: "ipc-message",
  "UI-input": "ui-input",
  database: "database-result",
  env: "env-var",
  filesystem: "filesystem-read",
  network: "http-input",
  queue: "queue-payload",
  sdk: "sdk-response",
  serialization: "json-parse",
};

/** Expression patterns that refine source classification beyond boundary type */
const SOURCE_REFINEMENT_PATTERNS: { pattern: RegExp; source: BoundarySource }[] = [
  { pattern: /JSON\.parse/, source: "json-parse" },
  { pattern: /process\.env/, source: "env-var" },
  { pattern: /\breadFile/, source: "filesystem-read" },
  { pattern: /\breadFileSync/, source: "filesystem-read" },
  { pattern: /\bcreateReadStream/, source: "filesystem-read" },
  { pattern: /\bfetch\b/, source: "http-input" },
  { pattern: /\baxios\b/, source: "http-input" },
  { pattern: /\.get\(/, source: "http-input" },
  { pattern: /\.post\(/, source: "http-input" },
  { pattern: /\bpostMessage\b/, source: "ipc-message" },
  { pattern: /\bprocess\.send\b/, source: "ipc-message" },
  { pattern: /\bquerySelector\b/, source: "ui-input" },
  { pattern: /\bformData\b/i, source: "ui-input" },
];

// --- Validation sink detection patterns ---

/** Schema parser identifiers (zod, valibot, io-ts, typebox, etc.) */
const SCHEMA_PARSER_PATTERNS = [
  /\bz\.\w+\(\)?\.\w*parse/,
  /\bsafeParse\b/,
  /\bparse\b/,
  /\bv\.\w+\(\)/,
  /\bvalibot\.\w+/,
  /\bdecode\b/,
  /\bt\.type\b/,
  /\bType\.Object\b/,
  /\bsuperRefine\b/,
  /\brefine\b/,
];

/** Type guard patterns */
const TYPE_GUARD_PATTERNS = [
  /\bis[A-Z]\w+\(/,
  /\btypeof\s+\w+\s*[!=]==?\s*/,
  /\binstanceof\b/,
  /\bin\s+\w+/,
];

/** Assert function patterns */
const ASSERT_PATTERNS = [/\bassert[A-Z]\w*\(/, /\bassert\(/, /\binvariant\(/, /\bensure[A-Z]\w*\(/];

/** Branded constructor patterns */
const BRANDED_PATTERNS = [
  /\bbrand\(/,
  /\bas\s+\w+Branded\b/,
  /\bmake[A-Z]\w*\(/,
  /\bcreate[A-Z]\w*\(/,
];

/** Encoding helper patterns */
const ENCODING_PATTERNS = [
  /\bencodeURIComponent\b/,
  /\bencodeURI\b/,
  /\bescape\b/,
  /\bsanitize\w*\(/,
  /\bhtmlEscape\b/,
];

/**
 * Classify a boundary source from an expression string and its boundary type.
 *
 * @example
 * ```ts
 * classifyBoundarySource("fetch('/api/data')", "network") // => "http-input"
 * classifyBoundarySource("process.env.PORT", "env") // => "env-var"
 * ```
 */
export function classifyBoundarySource(
  expression: string,
  boundaryType: BoundaryType,
): BoundarySource {
  // Try expression-level refinement first for more precise classification
  for (const { pattern, source } of SOURCE_REFINEMENT_PATTERNS) {
    if (pattern.test(expression)) {
      return source;
    }
  }

  // Fall back to boundary type mapping
  const mapped = BOUNDARY_TYPE_TO_SOURCE[boundaryType];
  if (mapped) {
    return mapped;
  }

  // Default to http-input for unknown boundary types with external data
  return "http-input";
}

/**
 * Detect validation sinks in a single source file.
 *
 * Scans for schema parsers (zod, valibot, io-ts), type guards, assert functions,
 * branded constructors, and encoding helpers.
 *
 * @example
 * ```ts
 * const sinks = detectValidationSinks(sourceFile);
 * // => [{ kind: "schema-parser", file: "api.ts", line: 12, expression: "schema.parse(data)" }]
 * ```
 */
export function detectValidationSinks(sourceFile: SourceFile): ValidationSink[] {
  const sinks: ValidationSink[] = [];
  const filePath = sourceFile.getFilePath();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const exprText = node.getExpression().getText();
    const lineNumber = node.getStartLineNumber();

    // Check each sink category in priority order
    const sinkKind = classifySinkKind(exprText);
    if (sinkKind) {
      sinks.push({
        expression: exprText,
        file: filePath,
        kind: sinkKind,
        line: lineNumber,
      });
    }
  });

  // Also detect type guard expressions (typeof / instanceof in conditionals)
  sourceFile.forEachDescendant((node) => {
    if (!Node.isIfStatement(node)) {
      return;
    }

    const conditionText = node.getExpression().getText();
    if (TYPE_GUARD_PATTERNS.some((pat) => pat.test(conditionText))) {
      sinks.push({
        expression: conditionText,
        file: filePath,
        kind: "type-guard",
        line: node.getStartLineNumber(),
      });
    }
  });

  return sinks;
}

/**
 * Build taint flow chains connecting boundary sources to validation sinks.
 *
 * Tracks data flow from untrusted boundary sources through variable assignments,
 * function returns, and parameter passing to validation sinks.
 *
 * @example
 * ```ts
 * const chains = buildTaintFlowChains(sourceFiles, project);
 * // => [{ source: "http-input", steps: [...], sink: {...}, isValidated: true }]
 * ```
 */
export function buildTaintFlowChains(
  sourceFiles: SourceFile[],
  _project: Project,
): TaintFlowChain[] {
  const chains: TaintFlowChain[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    const sinks = detectValidationSinks(sf);
    const sourceNodes = collectBoundarySources(sf);

    for (const srcNode of sourceNodes) {
      const steps = traceForwardFlow(srcNode.node, sf);
      const matchedSink = findMatchingSink(steps, sinks, srcNode.node);

      const chain: TaintFlowChain = {
        isValidated: matchedSink !== undefined,
        source: srcNode.source,
        sourceExpression: srcNode.expression,
        sourceFile: filePath,
        sourceLine: srcNode.line,
        steps,
      };
      if (matchedSink) {
        chain.sink = matchedSink;
      }
      chains.push(chain);
    }
  }

  return chains;
}

// --- Internal helpers ---

/** Intermediate representation of a detected boundary source node */
interface SourceNodeInfo {
  node: Node;
  source: BoundarySource;
  expression: string;
  line: number;
}

/**
 * Classify a call expression into a validation sink kind, if applicable.
 */
function classifySinkKind(exprText: string): ValidationSink["kind"] | undefined {
  if (SCHEMA_PARSER_PATTERNS.some((pat) => pat.test(exprText))) {
    return "schema-parser";
  }
  if (ASSERT_PATTERNS.some((pat) => pat.test(exprText))) {
    return "assert-function";
  }
  if (BRANDED_PATTERNS.some((pat) => pat.test(exprText))) {
    return "branded-constructor";
  }
  if (ENCODING_PATTERNS.some((pat) => pat.test(exprText))) {
    return "encoding-helper";
  }
  return undefined;
}

/**
 * Collect all boundary source nodes from a source file.
 */
function collectBoundarySources(sourceFile: SourceFile): SourceNodeInfo[] {
  const sources: SourceNodeInfo[] = [];

  sourceFile.forEachDescendant((node) => {
    // Detect call expressions that produce untrusted data
    if (Node.isCallExpression(node)) {
      const exprText = node.getExpression().getText();
      const boundaryType = detectBoundaryType(exprText);
      if (boundaryType) {
        sources.push({
          expression: exprText,
          line: node.getStartLineNumber(),
          node,
          source: classifyBoundarySource(exprText, boundaryType),
        });
      }
    }

    // Detect property access patterns like process.env.FOO
    if (Node.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text.startsWith("process.env.") || text === "process.env") {
        sources.push({
          expression: text,
          line: node.getStartLineNumber(),
          node,
          source: "env-var",
        });
      }
    }
  });

  return sources;
}

/** Network call patterns for boundary type detection */
const NETWORK_CALL_PATTERNS = [
  /\bfetch\b/,
  /\baxios\b/,
  /\bhttp\.\w+/,
  /\.get\(/,
  /\.post\(/,
  /\.put\(/,
  /\.delete\(/,
];

/** File system call patterns for boundary type detection */
const FS_CALL_PATTERNS = [/\breadFileSync\b/, /\breadFile\b/, /\bcreateReadStream\b/, /\bfs\.\w+/];

/** Serialization call patterns for boundary type detection */
const SERIALIZATION_CALL_PATTERNS = [/JSON\.parse/, /\byaml\.parse\b/, /\byaml\.load\b/];

/** IPC call patterns for boundary type detection */
const IPC_CALL_PATTERNS = [/\bpostMessage\b/, /\bprocess\.send\b/, /\bchild_process\b/];

/** UI input patterns for boundary type detection */
const UI_CALL_PATTERNS = [/\bquerySelector\b/, /\bgetElementById\b/, /\bformData\b/i];

/**
 * Detect the boundary type from an expression string, returning undefined if not a boundary.
 */
function detectBoundaryType(exprText: string): BoundaryType | undefined {
  if (NETWORK_CALL_PATTERNS.some((pat) => pat.test(exprText))) {
    return "network";
  }
  if (FS_CALL_PATTERNS.some((pat) => pat.test(exprText))) {
    return "filesystem";
  }
  if (SERIALIZATION_CALL_PATTERNS.some((pat) => pat.test(exprText))) {
    return "serialization";
  }
  if (IPC_CALL_PATTERNS.some((pat) => pat.test(exprText))) {
    return "IPC";
  }
  if (UI_CALL_PATTERNS.some((pat) => pat.test(exprText))) {
    return "UI-input";
  }
  return undefined;
}

/**
 * Trace forward data flow from a source node through assignments, returns, and parameters.
 */
function traceForwardFlow(sourceNode: Node, sourceFile: SourceFile): TaintFlowStep[] {
  const steps: TaintFlowStep[] = [];
  const filePath = sourceFile.getFilePath();

  // Find the variable declaration that captures this source value
  const parentDecl = sourceNode.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!parentDecl) {
    return steps;
  }

  const varName = parentDecl.getName();
  steps.push({
    expression: `${varName} = ${sourceNode.getText().slice(0, 60)}`,
    file: filePath,
    kind: "assignment",
    line: parentDecl.getStartLineNumber(),
  });

  // Track references to the variable within the enclosing block
  const enclosingBlock = parentDecl.getFirstAncestorByKind(SyntaxKind.Block);
  if (!enclosingBlock) {
    return steps;
  }

  const declLine = parentDecl.getStartLineNumber();

  enclosingBlock.forEachDescendant((descendant) => {
    // Only track usages after the declaration
    if (descendant.getStartLineNumber() <= declLine) {
      return;
    }

    if (!Node.isIdentifier(descendant)) {
      return;
    }

    if (descendant.getText() !== varName) {
      return;
    }

    const usageParent = descendant.getParent();
    if (!usageParent) {
      return;
    }

    // Track return statements
    if (Node.isReturnStatement(usageParent)) {
      steps.push({
        expression: usageParent.getText().slice(0, 80),
        file: filePath,
        kind: "return",
        line: usageParent.getStartLineNumber(),
      });
    }

    // Track parameter passing in call expressions
    if (Node.isCallExpression(usageParent)) {
      steps.push({
        expression: usageParent.getText().slice(0, 80),
        file: filePath,
        kind: "parameter",
        line: usageParent.getStartLineNumber(),
      });
    }

    // Track property access on the tainted variable
    if (Node.isPropertyAccessExpression(usageParent)) {
      steps.push({
        expression: usageParent.getText().slice(0, 80),
        file: filePath,
        kind: "property-access",
        line: usageParent.getStartLineNumber(),
      });
    }
  });

  return steps;
}

/**
 * Find a validation sink that matches the data flow from a source node.
 */
function findMatchingSink(
  steps: TaintFlowStep[],
  sinks: ValidationSink[],
  sourceNode: Node,
): ValidationSink | undefined {
  if (sinks.length === 0) {
    return undefined;
  }

  const sourceLine = sourceNode.getStartLineNumber();

  // Check if any step flows into a known sink
  for (const step of steps) {
    for (const sink of sinks) {
      // Sink must appear at or after the flow step
      if (sink.line >= step.line) {
        return sink;
      }
    }
  }

  // Fallback: check if any sink appears shortly after the source
  const MAX_SINK_DISTANCE = 15;
  for (const sink of sinks) {
    const distance = sink.line - sourceLine;
    if (distance >= 0 && distance <= MAX_SINK_DISTANCE) {
      return sink;
    }
  }

  return undefined;
}
