import type { PublicSurface } from "./surface/index.js";
import { DOMAIN_PATTERNS } from "./constants.js";

export interface DomainInference {
  domain: "validation" | "result" | "utility" | "general";
  confidence: number;
  signals: string[];
}

export function detectDomain(surface: PublicSurface, packageName?: string): DomainInference {
  const signals: string[] = [];
  let validationScore = 0;
  let resultScore = 0;

  // Check package name against known patterns
  if (packageName) {
    for (const lib of DOMAIN_PATTERNS.validation) {
      if (packageName === lib || packageName.startsWith(`${lib}/`) || packageName.startsWith(`@${lib}/`)) {
        validationScore += 0.6;
        signals.push(`package name matches validation library '${lib}'`);
        break;
      }
    }
    for (const lib of DOMAIN_PATTERNS.result) {
      if (packageName === lib || packageName.startsWith(`${lib}/`) || packageName.startsWith(`@${lib}/`)) {
        resultScore += 0.6;
        signals.push(`package name matches result library '${lib}'`);
        break;
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
    validationScore += 0.3;
    signals.push(`${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`);
  }

  // Check for Result/Either type aliases
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      const name = decl.name.toLowerCase();
      if (name === "result" || name === "either" || name === "ok" || name === "err") {
        resultScore += 0.3;
        signals.push(`type alias '${decl.name}' suggests result pattern`);
      }
    }
  }

  // Determine domain
  if (validationScore >= 0.5) {
    return { confidence: Math.min(1, validationScore), domain: "validation", signals };
  }
  if (resultScore >= 0.5) {
    return { confidence: Math.min(1, resultScore), domain: "result", signals };
  }

  // Check for utility: mostly type aliases and generic functions
  const typeAliases = surface.declarations.filter((d) => d.kind === "type-alias").length;
  const totalDecls = surface.declarations.length;
  if (totalDecls > 0 && typeAliases / totalDecls > 0.5) {
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
    return { confidence: 0.4, domain: "utility", signals };
  }

  return { confidence: 0.2, domain: "general", signals };
}
