import {
  ANALYSIS_SCHEMA_VERSION,
  type CrossPackageBoundarySummary,
  type DecisionGrade,
  type Grade,
  type LayerViolation,
  type MonorepoConfig,
  type MonorepoHealthSummary,
  type MonorepoPackageInfo,
  type MonorepoReport,
  type PackageLayer,
  type ViolationSeverity,
  type ViolationSeveritySummary,
} from "../types.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { computeGrade } from "../scorer.js";

/** Default allowed layer dependencies (source -> targets) */
const DEFAULT_ALLOWED_DEPENDENCIES: Record<PackageLayer, PackageLayer[]> = {
  app: ["domain", "infra", "ui", "data", "shared", "tooling"],
  data: ["shared", "domain"],
  domain: ["shared"],
  infra: ["shared", "domain"],
  shared: [],
  tooling: ["shared"],
  ui: ["shared", "domain"],
};

/** UI framework packages that indicate a "ui" layer classification */
const UI_FRAMEWORK_DEPS = new Set([
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@angular/core",
  "solid-js",
  "preact",
]);

/** Heuristic patterns for layer detection by package name */
const LAYER_NAME_PATTERNS: { layer: PackageLayer; patterns: string[] }[] = [
  { layer: "app", patterns: ["app", "server", "web"] },
  { layer: "domain", patterns: ["domain", "core", "model"] },
  { layer: "infra", patterns: ["infra", "db", "queue", "cache"] },
  { layer: "data", patterns: ["data", "api", "client"] },
  { layer: "shared", patterns: ["shared", "common", "utils", "lib"] },
  { layer: "tooling", patterns: ["tool", "script", "build", "config"] },
];

interface AnalyzeMonorepoOpts {
  config?: MonorepoConfig | undefined;
  rootPath: string;
}

interface ClassifyPackageLayerOpts {
  config?: MonorepoConfig | undefined;
  name: string;
  packageJson: Record<string, unknown>;
}

/**
 * Analyze a monorepo workspace structure and detect layer violations.
 *
 * Discovers workspace packages from root package.json, classifies each into
 * a layer, builds the dependency graph, and checks for forbidden cross-layer
 * dependencies.
 */
export function analyzeMonorepo(opts: AnalyzeMonorepoOpts): MonorepoReport {
  const { rootPath, config } = opts;
  const absoluteRoot = resolve(rootPath);

  // Discover workspace package directories
  const workspaceDirs = discoverWorkspacePackages(absoluteRoot);

  // Load and classify each package
  const packageMap = new Map<string, MonorepoPackageInfo>();

  // If no workspace packages found, treat root as single package
  if (workspaceDirs.length === 0) {
    const rootPackageJsonPath = join(absoluteRoot, "package.json");
    if (existsSync(rootPackageJsonPath)) {
      const rootPkg = readJsonFile(rootPackageJsonPath);
      if (rootPkg) {
        const name = typeof rootPkg["name"] === "string" ? rootPkg["name"] : absoluteRoot;
        const layer = classifyPackageLayer({ config, name, packageJson: rootPkg });
        const dependencies = extractWorkspaceDependencies(rootPkg);
        packageMap.set(name, { dependencies, layer, name, path: absoluteRoot });
      }
    }
  }

  for (const packageDir of workspaceDirs) {
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readJsonFile(packageJsonPath);
    if (!packageJson) {
      continue;
    }

    const packageName = typeof packageJson["name"] === "string" ? packageJson["name"] : packageDir;
    const layer = classifyPackageLayer({ config, name: packageName, packageJson });
    const dependencies = extractWorkspaceDependencies(packageJson);

    packageMap.set(packageName, {
      dependencies,
      layer,
      name: packageName,
      path: packageDir,
    });
  }

  // Build layer graph (layer -> dependent layers)
  const layerGraph = buildLayerGraph(packageMap);

  // Detect layer violations
  const layerViolations = detectViolations(packageMap, config);

  // Detect cross-package boundary (trust-zone) violations
  const crossPackageViolations = detectCrossPackageBoundaryIssues(packageMap, config);

  // Merge all violations
  const violations = [...layerViolations, ...crossPackageViolations];

  // Compute health summary
  const healthSummary = computeHealthSummary({
    config,
    layerGraph,
    packages: packageMap,
    violations,
  });

  // Build cross-package boundary summary
  const crossPackageBoundarySummary = buildCrossPackageBoundarySummary(violations);

  return {
    analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION,
    crossPackageBoundarySummary,
    healthSummary,
    layerGraph,
    packages: [...packageMap.values()],
    violations,
  };
}

/**
 * Classify a package into a layer based on config overrides or heuristic detection.
 *
 * Priority: explicit config override > bin/scripts heuristics > UI deps > name patterns > fallback.
 */
export function classifyPackageLayer(opts: ClassifyPackageLayerOpts): PackageLayer {
  const { name, packageJson, config } = opts;

  // Check explicit config override first
  if (config?.layers) {
    const configuredLayer = config.layers[name];
    if (configuredLayer) {
      return configuredLayer;
    }
  }

  // Check for "app" layer: has bin or scripts with "start"
  if (hasAppIndicators(packageJson)) {
    return "app";
  }

  // Check for "ui" layer: has UI framework dependencies
  if (hasUiFrameworkDeps(packageJson)) {
    return "ui";
  }

  // Check name-based patterns
  const nameBasedLayer = classifyByName(name);
  if (nameBasedLayer) {
    return nameBasedLayer;
  }

  // Default fallback to shared
  return "shared";
}

/**
 * Discover workspace package directories from root package.json.
 * Supports pnpm-workspace.yaml, npm/yarn workspaces in package.json.
 */
function discoverWorkspacePackages(rootPath: string): string[] {
  const packageDirs: string[] = [];

  // Try pnpm-workspace.yaml first
  const pnpmWorkspacePath = join(rootPath, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspacePath)) {
    const workspaceGlobs = parsePnpmWorkspace(pnpmWorkspacePath);
    for (const globPattern of workspaceGlobs) {
      const resolved = resolveGlobPatterns({ globPattern, rootPath });
      packageDirs.push(...resolved);
    }
    if (packageDirs.length > 0) {
      return packageDirs;
    }
    // Fall through to package.json workspaces when pnpm-workspace.yaml
    // Exists but yielded no packages
  }

  // Try package.json workspaces field (npm/yarn)
  const rootPackageJsonPath = join(rootPath, "package.json");
  if (!existsSync(rootPackageJsonPath)) {
    return packageDirs;
  }

  const rootPackageJson = readJsonFile(rootPackageJsonPath);
  if (!rootPackageJson) {
    return packageDirs;
  }

  const workspaceGlobs = extractWorkspacesField(rootPackageJson);
  for (const globPattern of workspaceGlobs) {
    const resolved = resolveGlobPatterns({ globPattern, rootPath });
    packageDirs.push(...resolved);
  }

  return packageDirs;
}

/**
 * Parse pnpm-workspace.yaml to extract workspace package globs.
 * Uses simple line-by-line parsing to avoid a YAML dependency.
 */
function parsePnpmWorkspace(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const globs: string[] = [];
  let inPackages = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }

    // Stop when we hit another top-level key
    if (inPackages && trimmed.length > 0 && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
      break;
    }

    if (inPackages && trimmed.startsWith("-")) {
      // Extract glob value: strip leading "- ", quotes
      const globValue = trimmed.slice(1).trim().replace(/^['"]/, "").replace(/['"]$/, "");
      if (globValue.length > 0) {
        globs.push(globValue);
      }
    }
  }

  return globs;
}

/**
 * Extract workspace globs from package.json workspaces field.
 * Handles both array format and object format (yarn).
 */
function extractWorkspacesField(packageJson: Record<string, unknown>): string[] {
  const { workspaces } = packageJson;

  if (Array.isArray(workspaces)) {
    return workspaces.filter((ws): ws is string => typeof ws === "string");
  }

  // Yarn uses { packages: [...] } format
  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    const wsObj = workspaces as Record<string, unknown>;
    const { packages } = wsObj;
    if (Array.isArray(packages)) {
      return packages.filter((ws): ws is string => typeof ws === "string");
    }
  }

  return [];
}

interface ResolveGlobOpts {
  globPattern: string;
  rootPath: string;
}

/**
 * Resolve a workspace glob pattern to actual directories.
 * Handles simple patterns like "packages/*" and "apps/*".
 */
function resolveGlobPatterns(opts: ResolveGlobOpts): string[] {
  const { rootPath, globPattern } = opts;
  const results: string[] = [];

  // Handle simple "dir/*" patterns (the most common case)
  if (globPattern.endsWith("/*")) {
    const parentDir = join(rootPath, globPattern.slice(0, -2));
    if (existsSync(parentDir)) {
      collectDirectChildren(parentDir, results);
    }
    return results;
  }

  // Handle exact directory path (no wildcard)
  if (!globPattern.includes("*")) {
    const directPath = join(rootPath, globPattern);
    const directPackageJson = join(directPath, "package.json");
    if (existsSync(directPackageJson)) {
      results.push(directPath);
    }
    return results;
  }

  // Handle "dir/**" patterns by scanning recursively
  if (globPattern.endsWith("/**")) {
    const parentDir = join(rootPath, globPattern.slice(0, -3));
    if (existsSync(parentDir)) {
      collectPackageDirs(parentDir, results);
    }
    return results;
  }

  return results;
}

/**
 * Collect direct child directories that contain a package.json.
 */
function collectDirectChildren(parentDir: string, results: string[]): void {
  const entries = readdirSync(parentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidatePath = join(parentDir, entry.name);
      const candidatePackageJson = join(candidatePath, "package.json");
      if (existsSync(candidatePackageJson)) {
        results.push(candidatePath);
      }
    }
  }
}

/**
 * Recursively collect directories containing package.json files.
 */
function collectPackageDirs(dirPath: string, results: string[]): void {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== "node_modules") {
      const candidatePath = join(dirPath, entry.name);
      const candidatePackageJson = join(candidatePath, "package.json");
      if (existsSync(candidatePackageJson)) {
        results.push(candidatePath);
      }
      // Continue scanning subdirectories
      collectPackageDirs(candidatePath, results);
    }
  }
}

/**
 * Check if package.json indicates an "app" layer package.
 * True if it has a bin field or scripts containing "start".
 */
function hasAppIndicators(packageJson: Record<string, unknown>): boolean {
  // Has bin field
  if (packageJson["bin"]) {
    return true;
  }

  // Has "start" script
  const { scripts } = packageJson;
  if (scripts && typeof scripts === "object") {
    const scriptsObj = scripts as Record<string, unknown>;
    if (typeof scriptsObj["start"] === "string") {
      return true;
    }
  }

  return false;
}

/**
 * Check if package.json has UI framework dependencies.
 */
function hasUiFrameworkDeps(packageJson: Record<string, unknown>): boolean {
  const depFields = ["dependencies", "peerDependencies"];

  for (const field of depFields) {
    const deps = packageJson[field];
    if (deps && typeof deps === "object") {
      const depsObj = deps as Record<string, unknown>;
      for (const depName of Object.keys(depsObj)) {
        if (UI_FRAMEWORK_DEPS.has(depName)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Classify a package by its name against known layer patterns.
 * Returns null if no pattern matches.
 */
function classifyByName(name: string): PackageLayer | null {
  // Strip scope prefix for matching (e.g., "@myorg/core" -> "core")
  const baseName = name.includes("/") ? (name.split("/").pop() ?? name) : name;
  const lowerName = baseName.toLowerCase();

  for (const { layer, patterns } of LAYER_NAME_PATTERNS) {
    for (const pattern of patterns) {
      if (lowerName.includes(pattern)) {
        return layer;
      }
    }
  }

  return null;
}

/**
 * Extract workspace package dependencies from a package.json.
 * Returns dependency package names (does not filter to workspace-only).
 */
function extractWorkspaceDependencies(packageJson: Record<string, unknown>): string[] {
  const allDeps: string[] = [];
  const depFields = ["dependencies", "devDependencies", "peerDependencies"];

  for (const field of depFields) {
    const deps = packageJson[field];
    if (deps && typeof deps === "object") {
      const depsObj = deps as Record<string, unknown>;
      allDeps.push(...Object.keys(depsObj));
    }
  }

  return allDeps;
}

/**
 * Build a layer-level dependency graph from package info.
 * Returns a map of layer -> list of layers it depends on.
 */
function buildLayerGraph(packageMap: Map<string, MonorepoPackageInfo>): Record<string, string[]> {
  const layerDeps = new Map<string, Set<string>>();
  const packageNames = new Set(packageMap.keys());

  for (const [, packageInfo] of packageMap) {
    if (!layerDeps.has(packageInfo.layer)) {
      layerDeps.set(packageInfo.layer, new Set());
    }

    const depsSet = layerDeps.get(packageInfo.layer)!;

    for (const depName of packageInfo.dependencies) {
      // Only consider workspace-internal dependencies
      const depInfo = packageNames.has(depName) ? packageMap.get(depName) : undefined;
      if (depInfo && depInfo.layer !== packageInfo.layer) {
        depsSet.add(depInfo.layer);
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const [layer, deps] of layerDeps) {
    result[layer] = [...deps].toSorted();
  }

  return result;
}

/**
 * Detect layer dependency violations across all packages.
 */
function detectViolations(
  packageMap: Map<string, MonorepoPackageInfo>,
  config?: MonorepoConfig,
): LayerViolation[] {
  const violations: LayerViolation[] = [];
  const allowedDeps = config?.allowedDependencies ?? DEFAULT_ALLOWED_DEPENDENCIES;
  const packageNames = new Set(packageMap.keys());

  for (const [, packageInfo] of packageMap) {
    const sourceLayer = packageInfo.layer;
    const allowed = allowedDeps[sourceLayer] ?? [];

    for (const depName of packageInfo.dependencies) {
      // Only check workspace-internal dependencies
      const depInfo = packageNames.has(depName) ? packageMap.get(depName) : undefined;
      if (!depInfo) {
        continue;
      }

      const targetLayer = depInfo.layer;

      // Same-layer dependencies are always allowed
      if (targetLayer === sourceLayer) {
        continue;
      }

      // Check if this cross-layer dependency is allowed
      if (!allowed.includes(targetLayer)) {
        const violationType = categorizeViolation({ sourceLayer, targetLayer });
        const severity = classifyViolationSeverity({ sourceLayer, targetLayer, violationType });

        violations.push({
          importPath: depName,
          severity,
          sourceLayer,
          sourcePackage: packageInfo.name,
          targetLayer,
          targetPackage: depName,
          violationType,
        });
      }
    }
  }

  return violations;
}

interface CategorizeViolationOpts {
  sourceLayer: PackageLayer;
  targetLayer: PackageLayer;
}

/**
 * Categorize a violation based on the source and target layers.
 */
function categorizeViolation(opts: CategorizeViolationOpts): LayerViolation["violationType"] {
  const { sourceLayer, targetLayer } = opts;

  // Domain depending on infra is an infra-bypass
  if (sourceLayer === "domain" && targetLayer === "infra") {
    return "infra-bypass";
  }

  // Shared depending on anything is an unstable-leak
  if (sourceLayer === "shared") {
    return "unstable-leak";
  }

  return "forbidden-cross-layer";
}

/**
 * Classify the severity of a violation based on its type and the layers involved.
 */
function classifyViolationSeverity(violation: {
  violationType: LayerViolation["violationType"];
  sourceLayer: PackageLayer;
  targetLayer: PackageLayer;
}): ViolationSeverity {
  // Trust-zone-crossing from core domain layers is critical
  if (violation.violationType === "trust-zone-crossing") {
    if (violation.sourceLayer === "domain" || violation.sourceLayer === "shared") {
      return "critical";
    }
    return "high";
  }

  // Unstable-leak (shared depending on anything) is high
  if (violation.violationType === "unstable-leak") {
    return "high";
  }

  // Infra-bypass (domain→infra) is high
  if (violation.violationType === "infra-bypass") {
    return "high";
  }

  // Forbidden-cross-layer: severity depends on layer distance
  const sourceTrust = LAYER_TRUST_LEVELS[violation.sourceLayer];
  const targetTrust = LAYER_TRUST_LEVELS[violation.targetLayer];
  const trustDelta = Math.abs(sourceTrust - targetTrust);

  if (trustDelta >= 3) {
    return "high";
  }
  if (trustDelta >= 2) {
    return "medium";
  }
  return "low";
}

/**
 * Trust level assigned to each package layer.
 * Used to detect trust-zone-crossing violations when packages at different
 * trust levels depend on each other in unsafe directions.
 */
const LAYER_TRUST_LEVELS: Record<PackageLayer, number> = {
  app: 1,
  data: 3,
  domain: 4,
  infra: 2,
  shared: 5,
  tooling: 2,
  ui: 1,
};

/**
 * Detect cross-package boundary issues where packages at different trust
 * levels depend on each other.
 *
 * A trust-zone-crossing violation is raised when a higher-trust package
 * depends on a lower-trust package (trust flows downward: higher number =
 * more trusted internal code, lower number = closer to external boundaries).
 */
export function detectCrossPackageBoundaryIssues(
  packageMap: Map<string, MonorepoPackageInfo>,
  _config?: MonorepoConfig,
): LayerViolation[] {
  const violations: LayerViolation[] = [];
  const packageNames = new Set(packageMap.keys());

  for (const [, packageInfo] of packageMap) {
    const sourceTrust = LAYER_TRUST_LEVELS[packageInfo.layer];

    for (const depName of packageInfo.dependencies) {
      // Only check workspace-internal dependencies
      const depInfo = packageNames.has(depName) ? packageMap.get(depName) : undefined;
      if (!depInfo) {
        continue;
      }

      // Same layer — no trust boundary crossing
      if (depInfo.layer === packageInfo.layer) {
        continue;
      }

      const targetTrust = LAYER_TRUST_LEVELS[depInfo.layer];

      // Higher-trust package depending on lower-trust package is a crossing
      if (sourceTrust > targetTrust) {
        const violationType = "trust-zone-crossing" as const;
        const severity = classifyViolationSeverity({
          sourceLayer: packageInfo.layer,
          targetLayer: depInfo.layer,
          violationType,
        });
        violations.push({
          importPath: depName,
          severity,
          sourceLayer: packageInfo.layer,
          sourcePackage: packageInfo.name,
          targetLayer: depInfo.layer,
          targetPackage: depName,
          violationType,
        });
      }
    }
  }

  return violations;
}

interface ComputeHealthSummaryOpts {
  config?: MonorepoConfig | undefined;
  layerGraph: Record<string, string[]>;
  packages: Map<string, MonorepoPackageInfo>;
  violations: LayerViolation[];
}

/** Severity weight factors for health scoring */
const SEVERITY_WEIGHTS: Record<ViolationSeverity, number> = {
  critical: 20,
  high: 10,
  low: 2,
  medium: 5,
};

/**
 * Compute a health summary for the monorepo based on severity-weighted violations.
 *
 * healthScore = 100 - sum(severity_weight * count) - densityPenalty, clamped to [0, 100].
 * Grade is derived from healthScore using the standard grade curve.
 * Violation density normalizes by package count for comparability.
 */
function computeHealthSummary(opts: ComputeHealthSummaryOpts): MonorepoHealthSummary {
  const { config, layerGraph, packages, violations } = opts;

  const violationsByType: Record<string, number> = {};
  const severitySummary: ViolationSeveritySummary = { critical: 0, high: 0, low: 0, medium: 0 };

  for (const violation of violations) {
    const vt = violation.violationType;
    violationsByType[vt] = (violationsByType[vt] ?? 0) + 1;
    severitySummary[violation.severity]++;
  }

  // Severity-weighted score deduction
  const weightedDeduction =
    severitySummary.critical * SEVERITY_WEIGHTS.critical +
    severitySummary.high * SEVERITY_WEIGHTS.high +
    severitySummary.medium * SEVERITY_WEIGHTS.medium +
    severitySummary.low * SEVERITY_WEIGHTS.low;

  // Violation density: violations per package
  const violationDensity =
    packages.size > 0 ? Math.round((violations.length / packages.size) * 100) / 100 : 0;

  // Density-adjusted health: penalize concentrated violations more than spread violations
  let densityPenalty = 0;
  if (violationDensity > 2) {
    densityPenalty = 5;
  } else if (violationDensity > 1) {
    densityPenalty = 3;
  }

  const rawScore = 100 - weightedDeduction - densityPenalty;
  const healthScore = Math.max(0, Math.min(100, rawScore));
  const healthGrade: Grade = computeGrade(healthScore);

  // Workspace confidence: lower when workspace discovery yielded few packages
  // Or when many packages have default layer classification or broken paths
  const workspaceConfidence = computeWorkspaceConfidence(packages);

  // Layer model confidence: how much of layer assignment is explicit vs heuristic
  const layerModelConfidence = computeLayerModelConfidence({ config, layerGraph, packages });

  // Decision grade: how much to trust the monorepo health assessment
  const decisionGrade = computeMonorepoDecisionGrade({
    healthScore,
    layerModelConfidence,
    totalPackages: packages.size,
    totalViolations: violations.length,
    workspaceConfidence,
  });

  return {
    decisionGrade,
    healthGrade,
    healthScore,
    layerModelConfidence,
    totalPackages: packages.size,
    totalViolations: violations.length,
    violationDensity,
    violationSeveritySummary: severitySummary,
    violationsByType,
    workspaceConfidence,
  };
}

/**
 * Compute confidence in workspace discovery results.
 * Low confidence when discovery found very few packages, none at all,
 * or when discovered packages have broken/unresolvable paths.
 */
function computeWorkspaceConfidence(packages: Map<string, MonorepoPackageInfo>): number {
  if (packages.size === 0) {
    return 0;
  }
  if (packages.size === 1) {
    return 0.3;
  }

  // Check how many discovered packages have resolvable paths
  let resolvableCount = 0;
  for (const [, pkg] of packages) {
    const packageJsonPath = join(pkg.path, "package.json");
    if (existsSync(packageJsonPath)) {
      resolvableCount++;
    }
  }

  const resolvableRatio = resolvableCount / packages.size;

  // Base confidence from package count
  const baseConfidence = packages.size <= 3 ? 0.6 : 0.9;

  // Deduct for broken paths: each unresolvable package reduces confidence
  const pathPenalty = (1 - resolvableRatio) * 0.3;

  return Math.max(0, Math.round((baseConfidence - pathPenalty) * 100) / 100);
}

interface LayerModelConfidenceOpts {
  config?: MonorepoConfig | undefined;
  layerGraph: Record<string, string[]>;
  packages: Map<string, MonorepoPackageInfo>;
}

/**
 * Compute confidence in layer model assignments.
 *
 * Higher when packages have clear layer indicators (bin, UI deps, name patterns)
 * or explicit config overrides. Reduced when the layer graph has cycles
 * (non-DAG structure suggests misclassification).
 */
function computeLayerModelConfidence(opts: LayerModelConfidenceOpts): number {
  const { config, layerGraph, packages } = opts;

  if (packages.size === 0) {
    return 0;
  }

  // Count packages with clear (non-default) layer classification
  let classifiedCount = 0;
  let explicitConfigCount = 0;
  const configLayers = config?.layers ?? {};

  for (const [, pkg] of packages) {
    if (pkg.layer !== "shared") {
      classifiedCount++;
    }
    // Check if this package had an explicit config override
    if (configLayers[pkg.name]) {
      explicitConfigCount++;
    }
  }

  const classifiedRatio = classifiedCount / packages.size;
  const explicitRatio = explicitConfigCount / packages.size;

  // Base confidence from classification ratio
  // Heuristic-only caps at 0.8; explicit config can push to 1.0
  const baseConfidence = Math.min(0.8, 0.3 + classifiedRatio * 0.5);
  const explicitBonus = explicitRatio * 0.2;

  // Check for cycles in the layer graph (non-DAG reduces confidence)
  const hasCycles = detectLayerGraphCycles(layerGraph);
  const cyclePenalty = hasCycles ? 0.2 : 0;

  return Math.max(
    0,
    Math.min(1, Math.round((baseConfidence + explicitBonus - cyclePenalty) * 100) / 100),
  );
}

/**
 * Detect whether the layer dependency graph contains cycles.
 * Uses iterative DFS with gray/black coloring.
 */
function detectLayerGraphCycles(layerGraph: Record<string, string[]>): boolean {
  const white = new Set(Object.keys(layerGraph));
  const gray = new Set<string>();

  for (const startNode of Object.keys(layerGraph)) {
    if (!white.has(startNode)) {
      continue;
    }

    // Iterative DFS with explicit stack tracking entry/exit
    const stack: { exit: boolean; node: string }[] = [{ exit: false, node: startNode }];

    while (stack.length > 0) {
      const frame = stack.pop()!;

      if (frame.exit) {
        // Finished processing this node
        gray.delete(frame.node);
        continue;
      }

      if (gray.has(frame.node)) {
        // Back edge found — cycle detected
        return true;
      }

      if (!white.has(frame.node)) {
        continue;
      }

      white.delete(frame.node);
      gray.add(frame.node);
      // Push exit marker so we remove from gray when done
      stack.push({ exit: true, node: frame.node });

      const neighbors = layerGraph[frame.node] ?? [];
      for (const neighbor of neighbors) {
        if (gray.has(neighbor)) {
          return true;
        }
        if (white.has(neighbor)) {
          stack.push({ exit: false, node: neighbor });
        }
      }
    }
  }

  return false;
}

/**
 * Compute a decision grade for the monorepo health assessment.
 *
 * "strong" — both workspace and layer models are confident, sufficient packages.
 * "directional" — partial confidence, useful for trends but not gating.
 * "abstain" — too little evidence to make any recommendation.
 */
function computeMonorepoDecisionGrade(health: {
  healthScore: number;
  layerModelConfidence: number;
  totalPackages: number;
  totalViolations: number;
  workspaceConfidence: number;
}): DecisionGrade {
  // Abstain if workspace discovery is unreliable
  if (health.workspaceConfidence < 0.3) {
    return "abstain";
  }
  if (health.totalPackages < 2) {
    return "abstain";
  }

  // Directional if layer model is weak or workspace partially discovered
  if (health.layerModelConfidence < 0.5) {
    return "directional";
  }
  if (health.workspaceConfidence < 0.7) {
    return "directional";
  }

  // Strong if both models are confident
  return "strong";
}

/**
 * Build a summary of cross-package boundary trust violations.
 */
function buildCrossPackageBoundarySummary(
  violations: LayerViolation[],
): CrossPackageBoundarySummary {
  const trustCrossings = violations.filter((vv) => vv.violationType === "trust-zone-crossing");
  const highRisk = trustCrossings.filter(
    (vv) => vv.severity === "critical" || vv.severity === "high",
  );

  const affectedPackages = new Set<string>();
  for (const vv of trustCrossings) {
    affectedPackages.add(vv.sourcePackage);
    affectedPackages.add(vv.targetPackage);
  }

  // Compute trust gap severity based on high-risk crossing count
  let trustGapSeverity: CrossPackageBoundarySummary["trustGapSeverity"] = "none";
  if (highRisk.length > 5) {
    trustGapSeverity = "high";
  } else if (highRisk.length > 2) {
    trustGapSeverity = "moderate";
  } else if (highRisk.length > 0) {
    trustGapSeverity = "low";
  }

  return {
    affectedPackages: [...affectedPackages].toSorted(),
    highRiskCrossings: highRisk.length,
    totalCrossings: trustCrossings.length,
    trustGapSeverity,
  };
}

/**
 * Read and parse a JSON file, returning null on failure.
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
