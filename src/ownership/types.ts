import type { OwnershipClass } from "../types.js";

export type { OwnershipClass } from "../types.js";

/** Ownership resolution result for a single declaration or file */
export interface OwnershipResolution {
  ownershipClass: OwnershipClass;
  confidence: number;
  reason: string;
  /** If dependency-owned, the package name */
  dependencyPackage?: string;
  /** If workspace-internal, the workspace package name */
  workspacePackage?: string;
}

/** Enriched ownership for an issue, combining file and content signals */
export interface IssueOwnershipResolution extends OwnershipResolution {
  /** Whether a dependency type was detected leaking into source-owned code */
  dependencyTypeLeak?: boolean;
  /** The dependency type name that was detected in the issue message */
  leakedTypeName?: string;
}
