import type { PublicSurface } from "./surface/index.js";
import { DOMAIN_PATTERNS } from "./constants.js";

export type DomainType = "validation" | "result" | "utility" | "router" | "orm" | "schema" | "frontend" | "general";

export interface DomainInference {
  domain: DomainType;
  confidence: number;
  signals: string[];
  suppressedIssues?: string[];
}

export function detectDomain(surface: PublicSurface, packageName?: string): DomainInference {
  const signals: string[] = [];
  const suppressedIssues: string[] = [];
  const scores: Record<string, number> = {};

  // Check package name against known patterns
  if (packageName) {
    for (const [domain, libs] of Object.entries(DOMAIN_PATTERNS)) {
      for (const lib of libs) {
        if (packageName === lib || packageName.startsWith(`${lib}/`) || packageName.startsWith(`@${lib}/`)) {
          scores[domain] = (scores[domain] ?? 0) + 0.6;
          signals.push(`package name matches ${domain} library '${lib}'`);
          break;
        }
      }
    }
  }

  // Check for validation patterns: functions accepting `unknown` parameters
  let unknownParamFunctions = 0;
  let totalFunctions = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalFunctions++;
      const hasUnknownParam = decl.positions.some(
        (pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0, // TypeFlags.Unknown = 2
      );
      if (hasUnknownParam) {
        unknownParamFunctions++;
      }
    }
  }
  if (totalFunctions > 0 && unknownParamFunctions / totalFunctions > 0.3) {
    scores["validation"] = (scores["validation"] ?? 0) + 0.3;
    signals.push(`${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`);
  }

  // Check for Result/Either type aliases
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      const name = decl.name.toLowerCase();
      if (name === "result" || name === "either" || name === "ok" || name === "err") {
        scores["result"] = (scores["result"] ?? 0) + 0.3;
        signals.push(`type alias '${decl.name}' suggests result pattern`);
      }
    }
  }

  // Check for router patterns
  const routerNames = ["route", "handler", "middleware", "request", "response", "router", "endpoint"];
  let routerMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (routerNames.some((r) => lowerName.includes(r))) {
      routerMatchCount++;
    }
  }
  if (routerMatchCount >= 3) {
    const routerSignal = Math.min(0.6, 0.2 + routerMatchCount * 0.1);
    scores["router"] = (scores["router"] ?? 0) + routerSignal;
    signals.push(`${routerMatchCount} declarations match router patterns`);
  }

  // Check for ORM patterns
  const ormNames = ["model", "schema", "column", "migration", "query", "table", "entity"];
  let ormMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (ormNames.some((o) => lowerName.includes(o))) {
      ormMatchCount++;
    }
  }
  if (ormMatchCount >= 3) {
    const ormSignal = Math.min(0.6, 0.2 + ormMatchCount * 0.1);
    scores["orm"] = (scores["orm"] ?? 0) + ormSignal;
    signals.push(`${ormMatchCount} declarations match ORM patterns`);
  }

  // Check for schema/utility: mostly type aliases and generic functions
  const typeAliases = surface.declarations.filter((d) => d.kind === "type-alias").length;
  const totalDecls = surface.declarations.length;
  if (totalDecls > 0 && typeAliases / totalDecls > 0.6) {
    scores["schema"] = (scores["schema"] ?? 0) + 0.3;
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // Determine winning domain
  let bestDomain: DomainType = "general";
  let bestScore = 0;

  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore && score >= 0.5) {
      bestDomain = domain as DomainType;
      bestScore = score;
    }
  }

  // Fallback: utility if mostly type aliases
  if (bestDomain === "general" && totalDecls > 0 && typeAliases / totalDecls > 0.5) {
    bestDomain = "utility";
    bestScore = 0.4;
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // Record suppressions
  if (bestDomain === "validation") {
    suppressedIssues.push("unknown-param warnings suppressed for validation library");
  }

  const confidence = bestDomain === "general" ? 0.2 : Math.min(1, bestScore);

  return {
    confidence,
    domain: bestDomain,
    signals,
    suppressedIssues: suppressedIssues.length > 0 ? suppressedIssues : undefined,
  };
}
