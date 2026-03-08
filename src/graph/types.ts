/** A node in the declaration import graph */
export interface GraphNode {
  filePath: string;
  /** Which entrypoint subpath(s) this file is reachable from */
  reachableFrom: string[];
  /** Whether this file is a direct public entrypoint */
  isEntrypoint: boolean;
  /** BFS depth from nearest entrypoint (0 = entrypoint itself) */
  depth: number;
}

/** A resolved entrypoint from package.json */
export interface ResolvedEntrypoint {
  /** Subpath key from exports (e.g., ".", "./utils") or "types"/"typings" for top-level */
  subpath: string;
  /** Absolute path to the declaration file */
  filePath: string;
  /** Which condition resolved this: "types", "typings", "import.types", "require.types", etc. */
  condition: string;
}

/** A group of duplicate files that represent the same public surface */
export interface DedupGroup {
  /** The canonical file path kept for analysis */
  canonical: string;
  /** File paths that were deduplicated */
  duplicates: string[];
  /** Which dedup strategy matched */
  reason: "stem" | "symbol-hash" | "exports-identity";
}

/** The complete declaration graph for a package */
export interface DeclarationGraph {
  /** Resolved entrypoints from package.json */
  entrypoints: ResolvedEntrypoint[];
  /** All reachable declaration files */
  nodes: Map<string, GraphNode>;
  /** Deduplication groups */
  dedupGroups: DedupGroup[];
  /** Final list of absolute file paths to analyze (after dedup) */
  filesToAnalyze: string[];
  /** Diagnostic stats */
  stats: GraphStats;
}

/** Stats for diagnostics and confidence scoring */
export interface GraphStats {
  totalEntrypoints: number;
  totalReachable: number;
  totalAfterDedup: number;
  filesDeduped: number;
  dedupByStrategy: Record<string, number>;
  /** Whether resolution fell back to glob (no entrypoints found) */
  usedFallbackGlob: boolean;
}
