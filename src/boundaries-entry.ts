// Subpath entry: typegrade/boundaries
export {
  buildBoundaryGraph,
  buildBoundarySummary,
  computeBoundaryQuality,
} from "./boundaries/index.js";
export { buildTaintFlowChains } from "./boundaries/flow.js";
export { computeBoundaryHotspots, evaluateBoundaryPolicies } from "./boundaries/policy.js";
