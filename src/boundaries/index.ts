export { buildBoundaryGraph, buildBoundarySummary, computeBoundaryQuality } from "./analyzer.js";
export { classifyBoundaryType, classifyTrustLevel, getFileContext } from "./classifier.js";
export type { BoundaryGraph, BoundaryNode, TaintEdge } from "./types.js";
export { buildTaintFlowChains, classifyBoundarySource, detectValidationSinks } from "./flow.js";
export {
  computeBoundaryHotspots,
  detectTrustZoneCrossings,
  evaluateBoundaryPolicies,
} from "./policy.js";
