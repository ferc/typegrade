import { DOMAIN_PATTERNS } from "./constants.js";
import type { PublicSurface } from "./surface/index.js";

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
    | "declaration-role"
    | "generic-structure"
    | "scenario-trigger"
    | "negative";
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
  ambiguityGap: number;
  runnerUpDomain: DomainType;
}

// ─── Internal rule emission ─────────────────────────────────────────────────

interface RuleEmission {
  ruleId: string;
  weight: number;
  direction: "positive" | "negative";
  reason: string;
  domain: string;
  category: DomainRule["category"];
}

// ─── Rule engine ────────────────────────────────────────────────────────────

export function detectDomain(surface: PublicSurface, packageName?: string): DomainInference {
  const signals: string[] = [];
  const suppressedIssues: string[] = [];
  const adjustments: DomainAdjustment[] = [];
  const scores: Record<string, number> = {};
  const matchedRules: string[] = [];
  const rulesByDomain: Record<string, DomainRule[]> = {};
  const emissions: RuleEmission[] = [];

  function emit(rule: RuleEmission): void {
    emissions.push(rule);
    scores[rule.domain] = (scores[rule.domain] ?? 0) + rule.weight;
    matchedRules.push(`${rule.domain}:${rule.ruleId}`);
    if (!rulesByDomain[rule.domain]) {
      rulesByDomain[rule.domain] = [];
    }
    rulesByDomain[rule.domain]!.push({
      category: rule.category,
      name: rule.ruleId,
      score: rule.weight,
    });
  }

  // ── Precompute surface statistics ───────────────────────────────────────

  let totalFunctions = 0;
  let unknownParamFunctions = 0;
  let multiGenericFunctions = 0;
  let genericTypeAliases = 0;

  const typeAliases = surface.declarations.filter((decl) => decl.kind === "type-alias").length;
  const totalDecls = surface.declarations.length;

  for (const decl of surface.declarations) {
    if (decl.kind === "function") {
      totalFunctions++;
      const hasUnknownParam = decl.positions.some(
        (pos) => pos.role === "param" && (pos.type.getFlags() & 2) !== 0,
      );
      if (hasUnknownParam) {
        unknownParamFunctions++;
      }
      if (decl.typeParameters.length >= 2) {
        multiGenericFunctions++;
      }
    }
    if (decl.kind === "type-alias" && decl.typeParameters.length > 0) {
      genericTypeAliases++;
    }
  }

  // ── Category 1: Package-name rules (strongest, score 0.6) ──────────────

  let packageNameMatchedDomain: string | undefined = undefined;

  if (packageName) {
    for (const [domain, libs] of Object.entries(DOMAIN_PATTERNS)) {
      for (const lib of libs) {
        if (
          packageName === lib ||
          packageName.startsWith(`${lib}/`) ||
          packageName.startsWith(`@${lib}/`)
        ) {
          packageNameMatchedDomain = domain;
          emit({
            category: "package-name",
            direction: "positive",
            domain,
            reason: `Package name matches ${domain} library '${lib}'`,
            ruleId: `pkg-name:${lib}`,
            weight: 0.6,
          });
          signals.push(`package name matches ${domain} library '${lib}'`);
          break;
        }
      }
      if (packageNameMatchedDomain) {
        break;
      }
    }
  }

  // ── Category 2: Declaration-role rules ─────────────────────────────────

  // 2a: Validation — functions accepting unknown params (score 0.3)
  if (totalFunctions > 0 && unknownParamFunctions / totalFunctions > 0.3) {
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "validation",
      reason: `${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`,
      ruleId: "unknown-param-density",
      weight: 0.3,
    });
    signals.push(`${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`);
  }

  // 2b: Result — Result/Either/Ok/Err type aliases (score 0.3)
  for (const decl of surface.declarations) {
    if (decl.kind === "type-alias") {
      const name = decl.name.toLowerCase();
      if (name === "result" || name === "either" || name === "ok" || name === "err") {
        emit({
          category: "declaration-role",
          direction: "positive",
          domain: "result",
          reason: `Type alias '${decl.name}' suggests result pattern`,
          ruleId: `symbol:${decl.name}`,
          weight: 0.3,
        });
        signals.push(`type alias '${decl.name}' suggests result pattern`);
      }
    }
  }

  // 2c: Router — route/handler/middleware/request/response declarations
  // Score: 0.2 + 0.1 per match, max 0.6
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
    if (routerNames.some((nm) => lowerName.includes(nm))) {
      routerMatchCount++;
    }
  }
  if (routerMatchCount >= 2) {
    const routerSignal = Math.min(0.6, 0.2 + routerMatchCount * 0.1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "router",
      reason: `${routerMatchCount} declarations match router patterns`,
      ruleId: "router-symbol-density",
      weight: routerSignal,
    });
    signals.push(`${routerMatchCount} declarations match router patterns`);
  }

  // 2d: ORM — model/schema/column/migration/query/table declarations
  // Score: 0.2 + 0.1 per match, max 0.6
  const ormNames = ["model", "schema", "column", "migration", "query", "table", "entity"];
  let ormMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (ormNames.some((nm) => lowerName.includes(nm))) {
      ormMatchCount++;
    }
  }
  if (ormMatchCount >= 2) {
    const ormSignal = Math.min(0.6, 0.2 + ormMatchCount * 0.1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "orm",
      reason: `${ormMatchCount} declarations match ORM patterns`,
      ruleId: "orm-symbol-density",
      weight: ormSignal,
    });
    signals.push(`${ormMatchCount} declarations match ORM patterns`);
  }

  // 2e: Stream — observable/subject/stream/subscription/pipe declarations
  // Score: 0.2 + 0.1 per match, max 0.6
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
    if (streamNames.some((nm) => lowerName.includes(nm))) {
      streamMatchCount++;
    }
  }
  if (streamMatchCount >= 2) {
    const streamSignal = Math.min(0.6, 0.2 + streamMatchCount * 0.1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "stream",
      reason: `${streamMatchCount} declarations match stream/reactive patterns`,
      ruleId: "stream-symbol-density",
      weight: streamSignal,
    });
    signals.push(`${streamMatchCount} declarations match stream/reactive patterns`);
  }

  // ── Category 3: Generic-structure rules ─────────────────────────────────

  // 3a: Schema — >60% type aliases (score 0.3)
  if (totalDecls > 0 && typeAliases / totalDecls > 0.6) {
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${typeAliases}/${totalDecls} declarations are type aliases (>60%)`,
      ruleId: "type-alias-density",
      weight: 0.3,
    });
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // 3b: Schema — >5 generic type aliases (score 0.2)
  if (genericTypeAliases > 5) {
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${genericTypeAliases} generic type aliases detected (>5)`,
      ruleId: "generic-type-alias-count",
      weight: 0.2,
    });
    signals.push(`${genericTypeAliases} generic type aliases detected`);
  }

  // 3c: Utility — >30% multi-generic functions (score 0.2)
  if (totalFunctions > 0 && multiGenericFunctions / totalFunctions > 0.3) {
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type params`,
      ruleId: "multi-generic-fn-density",
      weight: 0.2,
    });
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "utility",
      reason: `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type params`,
      ruleId: "multi-generic-fn-density",
      weight: 0.2,
    });
    signals.push(
      `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type parameters`,
    );
  }

  // ── Category 4: Scenario-trigger rules (score 0.15) ─────────────────────

  // 4a: Validation — parse/validate/safeParse functions
  {
    const validationFnNames = ["parse", "validate", "safeparse", "safeParse", "check", "coerce"];
    let validationFnCount = 0;
    for (const decl of surface.declarations) {
      if (decl.kind === "function") {
        const lower = decl.name.toLowerCase();
        if (validationFnNames.some((fn) => lower === fn.toLowerCase())) {
          validationFnCount++;
        }
      }
    }
    if (validationFnCount >= 1) {
      emit({
        category: "scenario-trigger",
        direction: "positive",
        domain: "validation",
        reason: `${validationFnCount} parse/validate/safeParse functions found`,
        ruleId: "scenario:validation-fns",
        weight: 0.15,
      });
      signals.push(
        `${validationFnCount} parse/validate/safeParse functions suggest validation scenario`,
      );
    }
  }

  // 4b: Router — template literal route params
  {
    let templateRouteCount = 0;
    for (const decl of surface.declarations) {
      if (decl.kind === "type-alias" || decl.kind === "function") {
        for (const pos of decl.positions) {
          if (pos.type.isTemplateLiteral?.()) {
            templateRouteCount++;
            break;
          }
        }
      }
    }
    if (templateRouteCount >= 1) {
      emit({
        category: "scenario-trigger",
        direction: "positive",
        domain: "router",
        reason: `${templateRouteCount} declarations use template literal types (route params)`,
        ruleId: "scenario:template-route-params",
        weight: 0.15,
      });
      signals.push(`${templateRouteCount} template literal route param patterns detected`);
    }
  }

  // 4c: ORM — builder pattern chains with select/where/join methods
  {
    let builderChainCount = 0;
    const builderMethodNames = ["select", "where", "join", "from", "groupby", "orderby"];
    for (const decl of surface.declarations) {
      if (decl.kind === "interface" || decl.kind === "class") {
        const methods = decl.methods ?? [];
        const matchingMethods = methods.filter((method) =>
          builderMethodNames.some((bm) => method.name.toLowerCase().includes(bm)),
        );
        if (matchingMethods.length >= 2) {
          builderChainCount++;
        }
      }
    }
    if (builderChainCount >= 1) {
      emit({
        category: "scenario-trigger",
        direction: "positive",
        domain: "orm",
        reason: `${builderChainCount} interfaces/classes with select/where/join builder pattern`,
        ruleId: "scenario:orm-builder-chain",
        weight: 0.15,
      });
      signals.push(
        `${builderChainCount} builder pattern chains (select/where/join) suggest ORM scenario`,
      );
    }
  }

  // 4d: Result — map/flatMap/match methods on Result types
  {
    let resultMethodCount = 0;
    const resultMethodNames = ["map", "flatmap", "match", "fold", "chain", "mapErr", "unwrap"];
    for (const decl of surface.declarations) {
      if (decl.kind === "interface" || decl.kind === "class") {
        const lowerDeclName = decl.name.toLowerCase();
        const isResultType =
          lowerDeclName === "result" ||
          lowerDeclName === "either" ||
          lowerDeclName === "ok" ||
          lowerDeclName === "err" ||
          lowerDeclName === "option" ||
          lowerDeclName === "maybe";
        if (!isResultType) {
          continue;
        }
        const methods = decl.methods ?? [];
        const matchingMethods = methods.filter((method) =>
          resultMethodNames.some((rm) => method.name.toLowerCase() === rm.toLowerCase()),
        );
        if (matchingMethods.length >= 2) {
          resultMethodCount++;
        }
      }
    }
    if (resultMethodCount >= 1) {
      emit({
        category: "scenario-trigger",
        direction: "positive",
        domain: "result",
        reason: `${resultMethodCount} Result-like types with map/flatMap/match methods`,
        ruleId: "scenario:result-methods",
        weight: 0.15,
      });
      signals.push(
        `${resultMethodCount} Result types with monadic methods suggest result scenario`,
      );
    }
  }

  // ── Category 5: Negative rules ──────────────────────────────────────────

  // 5a: Package name matches domain X but declaration patterns strongly match domain Y
  if (packageNameMatchedDomain) {
    // Find the strongest declaration-role domain that differs from the package-name match
    let strongestDeclarationDomain: string | undefined = undefined;
    let strongestDeclarationScore = 0;

    for (const em of emissions) {
      if (
        em.category === "declaration-role" &&
        em.domain !== packageNameMatchedDomain &&
        em.weight > strongestDeclarationScore
      ) {
        strongestDeclarationScore = em.weight;
        strongestDeclarationDomain = em.domain;
      }
    }

    // If declaration evidence strongly contradicts the package-name match
    if (strongestDeclarationDomain && strongestDeclarationScore >= 0.4) {
      emit({
        category: "negative",
        direction: "negative",
        domain: packageNameMatchedDomain,
        reason: `Package name says '${packageNameMatchedDomain}' but declarations strongly suggest '${strongestDeclarationDomain}'`,
        ruleId: "neg:pkg-vs-decl-contradiction",
        weight: -0.2,
      });
      signals.push(
        `Declaration patterns contradict package-name domain: ${packageNameMatchedDomain} vs ${strongestDeclarationDomain}`,
      );
    }
  }

  // 5b: >80% simple functions with no generics → reduce schema/utility confidence
  if (totalFunctions > 3) {
    const simpleFunctions = surface.declarations.filter(
      (decl) => decl.kind === "function" && decl.typeParameters.length === 0,
    ).length;
    if (simpleFunctions / totalFunctions > 0.8) {
      const hasSchemScore = (scores["schema"] ?? 0) > 0;
      const hasUtilityScore = (scores["utility"] ?? 0) > 0;

      if (hasSchemScore) {
        emit({
          category: "negative",
          direction: "negative",
          domain: "schema",
          reason: `>80% functions have no generics, unlikely schema library`,
          ruleId: "neg:simple-fn-vs-schema",
          weight: -0.15,
        });
        signals.push(">80% simple functions without generics reduce schema confidence");
      }

      if (hasUtilityScore) {
        emit({
          category: "negative",
          direction: "negative",
          domain: "utility",
          reason: `>80% functions have no generics, unlikely utility library`,
          ruleId: "neg:simple-fn-vs-utility",
          weight: -0.15,
        });
        signals.push(">80% simple functions without generics reduce utility confidence");
      }
    }
  }

  // ── Determine winning domain ────────────────────────────────────────────

  let bestDomain: DomainType = "general";
  let bestScore = 0;
  let secondBestScore = 0;
  let runnerUpDomain: DomainType = "general";

  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore && score >= 0.3) {
      secondBestScore = bestScore;
      runnerUpDomain = bestDomain;
      bestDomain = domain as DomainType;
      bestScore = score;
    } else if (score > secondBestScore) {
      secondBestScore = score;
      runnerUpDomain = domain as DomainType;
    }
  }

  // Require a minimum threshold to win
  if (bestScore < 0.3) {
    bestDomain = "general";
    bestScore = 0;
  }

  // Fallback: utility if mostly type aliases and nothing else won
  if (bestDomain === "general" && totalDecls > 0 && typeAliases / totalDecls > 0.5) {
    bestDomain = "utility";
    bestScore = 0.4;
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases (utility fallback)`);
  }

  // ── Compute ambiguity gap ───────────────────────────────────────────────

  const ambiguityGap = bestScore - secondBestScore;

  // ── Compute false-positive risk ─────────────────────────────────────────

  const bestRules = rulesByDomain[bestDomain] ?? [];
  const ruleCategories = new Set(bestRules.map((rule) => rule.category));
  let falsePositiveRisk = 0;

  // Single-category evidence is riskier
  if (ruleCategories.size <= 1 && bestDomain !== "general") {
    falsePositiveRisk += 0.3;
  }

  // Close competing domain increases risk
  if (secondBestScore > 0 && bestScore > 0 && ambiguityGap < bestScore * 0.3) {
    falsePositiveRisk += 0.2;
  }

  // No package name match increases risk
  if (!matchedRules.some((rule) => rule.includes("pkg-name"))) {
    falsePositiveRisk += 0.1;
  }

  // Negative rules fired against the winner → higher risk
  const negativeRulesAgainstWinner = emissions.filter(
    (em) => em.domain === bestDomain && em.direction === "negative",
  );
  if (negativeRulesAgainstWinner.length > 0) {
    falsePositiveRisk += 0.15;
  }

  falsePositiveRisk = Math.min(1, falsePositiveRisk);

  // ── Compute confidence ──────────────────────────────────────────────────
  // Confidence is the raw score clamped to [0, 1], reduced by false-positive risk

  const confidence: number =
    bestDomain === "general"
      ? 0.2
      : Math.max(0, Math.min(1, Math.min(1, bestScore) * (1 - falsePositiveRisk * 0.3)));

  // ── Record domain-specific suppressions and adjustments ─────────────────

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

  // ── Build result ────────────────────────────────────────────────────────

  const result: DomainInference = {
    ambiguityGap,
    confidence,
    domain: bestDomain,
    falsePositiveRisk,
    matchedRules,
    runnerUpDomain,
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
