import type { PublicSurface } from "./surface/index.js";
import { DOMAIN_PATTERNS } from "./constants.js";

export type DomainType =
  | "validation"
  | "result"
  | "utility"
  | "router"
  | "orm"
  | "schema"
  | "frontend"
  | "stream"
  | "general";

export interface DomainAdjustment {
  dimension: string;
  adjustment: string;
  reason: string;
}

export interface DomainRule {
  name: string;
  category:
    | "package-name"
    | "declaration-shape"
    | "symbol-role"
    | "generic-structure"
    | "issue-pattern";
  score: number;
}

export interface DomainInference {
  domain: DomainType;
  confidence: number;
  signals: string[];
  falsePositiveRisk: number;
  matchedRules: string[];
  suppressedIssues?: string[];
  adjustments?: DomainAdjustment[];
}

export function detectDomain(surface: PublicSurface, packageName?: string): DomainInference {
  const signals: string[] = [];
  const suppressedIssues: string[] = [];
  const adjustments: DomainAdjustment[] = [];
  const scores: Record<string, number> = {};
  const matchedRules: string[] = [];
  const rulesByDomain: Record<string, DomainRule[]> = {};

  function addRule(domain: string, rule: DomainRule): void {
    scores[domain] = (scores[domain] ?? 0) + rule.score;
    matchedRules.push(`${domain}:${rule.name}`);
    if (!rulesByDomain[domain]) {
      rulesByDomain[domain] = [];
    }
    rulesByDomain[domain]!.push(rule);
  }

  // Rule 1: Package name match (strongest signal)
  if (packageName) {
    for (const [domain, libs] of Object.entries(DOMAIN_PATTERNS)) {
      for (const lib of libs) {
        if (
          packageName === lib ||
          packageName.startsWith(`${lib}/`) ||
          packageName.startsWith(`@${lib}/`)
        ) {
          addRule(domain, { category: "package-name", name: `pkg-name:${lib}`, score: 0.6 });
          signals.push(`package name matches ${domain} library '${lib}'`);
          break;
        }
      }
    }
  }

  // Rule 2: Declaration shape — validation patterns
  let unknownParamFunctions = 0;
  let totalFunctions = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalFunctions++;
      const hasUnknownParam = decl.positions.some(
        (pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0,
      );
      if (hasUnknownParam) {
        unknownParamFunctions++;
      }
    }
  }
  if (totalFunctions > 0 && unknownParamFunctions / totalFunctions > 0.3) {
    addRule("validation", {
      category: "declaration-shape",
      name: "unknown-param-density",
      score: 0.3,
    });
    signals.push(`${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`);
  }

  // Rule 3: Symbol role — Result/Either type aliases
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      const name = decl.name.toLowerCase();
      if (name === "result" || name === "either" || name === "ok" || name === "err") {
        addRule("result", { category: "symbol-role", name: `symbol:${decl.name}`, score: 0.3 });
        signals.push(`type alias '${decl.name}' suggests result pattern`);
      }
    }
  }

  // Rule 4: Declaration shape — router patterns
  const routerNames = [
    "route",
    "handler",
    "middleware",
    "request",
    "response",
    "router",
    "endpoint",
  ];
  let routerMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (routerNames.some((r) => lowerName.includes(r))) {
      routerMatchCount++;
    }
  }
  if (routerMatchCount >= 3) {
    const routerSignal = Math.min(0.6, 0.2 + routerMatchCount * 0.1);
    addRule("router", {
      category: "declaration-shape",
      name: "router-symbol-density",
      score: routerSignal,
    });
    signals.push(`${routerMatchCount} declarations match router patterns`);
  }

  // Rule 5: Declaration shape — ORM patterns
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
    addRule("orm", { category: "declaration-shape", name: "orm-symbol-density", score: ormSignal });
    signals.push(`${ormMatchCount} declarations match ORM patterns`);
  }

  // Rule 6: Declaration shape — stream/reactive patterns
  const streamNames = [
    "observable",
    "subject",
    "stream",
    "subscription",
    "pipe",
    "operator",
    "subscriber",
  ];
  let streamMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (streamNames.some((s) => lowerName.includes(s))) {
      streamMatchCount++;
    }
  }
  if (streamMatchCount >= 3) {
    const streamSignal = Math.min(0.6, 0.2 + streamMatchCount * 0.1);
    addRule("stream", {
      category: "declaration-shape",
      name: "stream-symbol-density",
      score: streamSignal,
    });
    signals.push(`${streamMatchCount} declarations match stream/reactive patterns`);
  }

  // Rule 7: Generic structure — schema/utility detection
  const typeAliases = surface.declarations.filter((d) => d.kind === "type-alias").length;
  const totalDecls = surface.declarations.length;
  if (totalDecls > 0 && typeAliases / totalDecls > 0.6) {
    addRule("schema", { category: "generic-structure", name: "type-alias-density", score: 0.3 });
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // Rule 8: Generic structure — multi-generic function density
  if (totalFunctions > 0) {
    let multiGenericFunctions = 0;
    for (const decl of surface.declarations) {
      if (decl.kind === "function" && decl.typeParameters.length >= 2) {
        multiGenericFunctions++;
      }
    }
    if (multiGenericFunctions / totalFunctions > 0.3) {
      addRule("schema", {
        category: "generic-structure",
        name: "multi-generic-fn-density",
        score: 0.2,
      });
      addRule("utility", {
        category: "generic-structure",
        name: "multi-generic-fn-density",
        score: 0.2,
      });
      signals.push(
        `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type parameters`,
      );
    }
  }

  // Rule 9: Generic type aliases count
  let genericTypeAliases = 0;
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias" && decl.typeParameters.length > 0) {
      genericTypeAliases++;
    }
  }
  if (genericTypeAliases > 5) {
    addRule("schema", {
      category: "generic-structure",
      name: "generic-type-alias-count",
      score: 0.2,
    });
    signals.push(`${genericTypeAliases} generic type aliases detected`);
  }

  // Determine winning domain
  let bestDomain: DomainType = "general";
  let bestScore = 0;
  let secondBestScore = 0;
  let _secondBestDomain: DomainType = "general";

  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore && score >= 0.5) {
      secondBestScore = bestScore;
      _secondBestDomain = bestDomain;
      bestDomain = domain as DomainType;
      bestScore = score;
    } else if (score > secondBestScore) {
      secondBestScore = score;
      _secondBestDomain = domain as DomainType;
    }
  }

  // Fallback: utility if mostly type aliases
  if (bestDomain === "general" && totalDecls > 0 && typeAliases / totalDecls > 0.5) {
    bestDomain = "utility";
    bestScore = 0.4;
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // Compute false positive risk based on rule diversity and competing domains
  const bestRules = rulesByDomain[bestDomain] ?? [];
  const ruleCategories = new Set(bestRules.map((r) => r.category));
  let falsePositiveRisk = 0;

  // Single-category evidence is riskier
  if (ruleCategories.size <= 1 && bestDomain !== "general") {
    falsePositiveRisk += 0.3;
  }

  // Close competing domain increases risk
  if (secondBestScore > 0 && bestScore > 0 && secondBestScore / bestScore > 0.7) {
    falsePositiveRisk += 0.2;
  }

  // No package name match increases risk
  if (!matchedRules.some((r) => r.includes("pkg-name"))) {
    falsePositiveRisk += 0.1;
  }

  falsePositiveRisk = Math.min(1, falsePositiveRisk);

  // Record suppressions and adjustments
  if (bestDomain === "validation") {
    suppressedIssues.push("unknown-param warnings suppressed for validation library");
    adjustments.push({
      adjustment: "suppress unknown-param warnings",
      dimension: "apiSafety",
      reason: "Validation libraries intentionally accept unknown inputs",
    });
  }

  if (bestDomain === "stream") {
    adjustments.push({
      adjustment: "accept higher-order generic signatures",
      dimension: "surfaceComplexity",
      reason: "Stream/reactive libraries require complex generic type compositions",
    });
  }

  if (bestDomain === "schema" || bestDomain === "utility") {
    adjustments.push({
      adjustment: "expect high generic density",
      dimension: "apiSpecificity",
      reason: "Schema/utility libraries are expected to use generics extensively",
    });
  }

  const confidence = bestDomain === "general" ? 0.2 : Math.min(1, bestScore);

  const result: DomainInference = {
    confidence,
    domain: bestDomain,
    falsePositiveRisk,
    matchedRules,
    signals,
  };

  if (suppressedIssues.length > 0) {
    result.suppressedIssues = suppressedIssues;
  }

  if (adjustments.length > 0) {
    result.adjustments = adjustments;
  }

  return result;
}
