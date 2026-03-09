import type { OwnershipClass } from "../types.js";

export type { OwnershipClass } from "../types.js";

/** Ownership resolution result for a single declaration or file */
export interface OwnershipResolution {
  ownershipClass: OwnershipClass;
  confidence: number;
  reason: string;
  /** If dependency-owned, the package name */
  dependencyPackage?: string;
}
