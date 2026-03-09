import type { BoundaryType, TrustLevel } from "../types.js";

export type {
  BoundaryType,
  TrustLevel,
  BoundaryInventoryEntry,
  BoundarySummary,
} from "../types.js";

/** A node in the boundary graph representing a data ingress point */
export interface BoundaryNode {
  file: string;
  line: number;
  column: number;
  /** The boundary classification */
  boundaryType: BoundaryType;
  /** Trust level of the data source */
  trustLevel: TrustLevel;
  /** Whether validation exists downstream of this boundary */
  hasDownstreamValidation: boolean;
  /** Expression text for context */
  expression: string;
  /** Description of the boundary */
  description: string;
}

/** Taint edge: data flows from a taint source to a taint sink */
export interface TaintEdge {
  source: BoundaryNode;
  sinkFile: string;
  sinkLine: number;
  sinkDescription: string;
  isValidated: boolean;
}

/** Complete boundary graph for a project */
export interface BoundaryGraph {
  nodes: BoundaryNode[];
  taintEdges: TaintEdge[];
}
