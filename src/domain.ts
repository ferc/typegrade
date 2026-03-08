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
  | "state"
  | "testing"
  | "cli"
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
  /** Secondary domain candidates with scores */
  secondaryDomains?: { domain: DomainType; score: number; confidence: number }[];
  /** Evidence classes that contributed to the inference */
  evidenceClasses?: string[];
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

  // ── Category 1: Package-name rules (strongest, score 1.0) ──────────────

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
            weight: 1,
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

  // When a package-name match exists, declaration-role rules for competing domains
  // Are halved to prevent generic symbol names from overriding the strong prior
  const competingDomainPenalty = packageNameMatchedDomain ? 0.5 : 1;

  // ── Category 2: Declaration-role rules ─────────────────────────────────

  // 2a: Validation — functions accepting unknown params (score 0.3)
  if (totalFunctions > 0 && unknownParamFunctions / totalFunctions > 0.3) {
    const weight =
      0.3 *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "validation"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "validation",
      reason: `${unknownParamFunctions}/${totalFunctions} functions accept 'unknown' params`,
      ruleId: "unknown-param-density",
      weight,
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

  // 2c: Router — route/middleware/router/endpoint declarations
  // Score: 0.2 + 0.1 per match, max 0.6 (penalized if competing with package-name domain)
  // "request"/"response" removed — too generic, matches axios/effect/many others
  const routerNames = ["route", "middleware", "router", "endpoint", "createrouter", "createapp"];
  let routerMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (routerNames.some((nm) => lowerName.includes(nm))) {
      routerMatchCount++;
    }
  }
  if (routerMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + routerMatchCount * 0.1);
    const routerSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "router"
        ? competingDomainPenalty
        : 1);
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

  // 2d: ORM — column/migration/table/entity/relation declarations
  // Score: 0.2 + 0.1 per match, max 0.6 (penalized if competing with package-name domain)
  // "model"/"schema"/"query" removed — too generic, matches validation/schema libraries
  const ormNames = ["column", "migration", "table", "entity", "relation"];
  let ormMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (ormNames.some((nm) => lowerName.includes(nm))) {
      ormMatchCount++;
    }
  }
  if (ormMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + ormMatchCount * 0.1);
    const ormSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "orm" ? competingDomainPenalty : 1);
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

  // 2e: Stream — observable/subject/stream/subscription/operator/subscriber
  // Score: 0.2 + 0.1 per match, max 0.6 (penalized if competing with package-name domain)
  // "pipe" removed — too generic, matches remeda, fp-ts, lodash
  const streamNames = ["observable", "subject", "stream", "subscription", "operator", "subscriber"];
  let streamMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (streamNames.some((nm) => lowerName.includes(nm))) {
      streamMatchCount++;
    }
  }
  if (streamMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + streamMatchCount * 0.1);
    const streamSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "stream"
        ? competingDomainPenalty
        : 1);
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

  // 2f: State — store/atom/selector/dispatch/derived declarations
  // Note: "subscribe", "computed" removed — too generic (matches rxjs, vue, etc.)
  const stateNames = ["store", "atom", "selector", "dispatch", "derived"];
  let stateMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (stateNames.some((nm) => lowerName.includes(nm))) {
      stateMatchCount++;
    }
  }
  if (stateMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + stateMatchCount * 0.1);
    const stateSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "state"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "state",
      reason: `${stateMatchCount} declarations match state management patterns`,
      ruleId: "state-symbol-density",
      weight: stateSignal,
    });
    signals.push(`${stateMatchCount} declarations match state management patterns`);
  }

  // 2g: Testing — test/describe/expect/mock/fixture declarations
  const testingNames = ["mock", "fixture", "stub", "spy", "assert", "matcher", "expect"];
  let testingMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (testingNames.some((nm) => lowerName.includes(nm))) {
      testingMatchCount++;
    }
  }
  if (testingMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + testingMatchCount * 0.1);
    const testingSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "testing"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "testing",
      reason: `${testingMatchCount} declarations match testing patterns`,
      ruleId: "testing-symbol-density",
      weight: testingSignal,
    });
    signals.push(`${testingMatchCount} declarations match testing patterns`);
  }

  // 2g+: Testing — query/render/screen patterns for testing-library style
  // Only exact or prefix matches to avoid false positives on generic names like "within"
  const testingLibraryExact = new Set(["render", "screen", "cleanup", "fireevent", "userevent"]);
  const testingLibraryPrefixes = ["getby", "queryby", "findby", "getall", "queryall", "findall"];
  let testingLibraryCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (testingLibraryExact.has(lowerName)) {
      testingLibraryCount++;
    } else if (testingLibraryPrefixes.some((px) => lowerName.startsWith(px))) {
      testingLibraryCount++;
    }
  }
  if (testingLibraryCount >= 3) {
    const baseSignal = Math.min(0.6, 0.2 + testingLibraryCount * 0.1);
    const testingLibSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "testing"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "testing",
      reason: `${testingLibraryCount} declarations match testing-library patterns (render/screen/query)`,
      ruleId: "testing-library-density",
      weight: testingLibSignal,
    });
    signals.push(`${testingLibraryCount} declarations match testing-library patterns`);
  }

  // 2h: CLI — command/program/subcommand/argv declarations
  // Note: "option", "argument", "handler" removed — too generic (matches axios options, date-fns options, etc.)
  const cliNames = ["command", "program", "subcommand", "argv", "parseargs"];
  let cliMatchCount = 0;
  for (const decl of surface.declarations) {
    const lowerName = decl.name.toLowerCase();
    if (cliNames.some((nm) => lowerName.includes(nm))) {
      cliMatchCount++;
    }
  }
  if (cliMatchCount >= 2) {
    const baseSignal = Math.min(0.6, 0.2 + cliMatchCount * 0.1);
    const cliSignal =
      baseSignal *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "cli" ? competingDomainPenalty : 1);
    emit({
      category: "declaration-role",
      direction: "positive",
      domain: "cli",
      reason: `${cliMatchCount} declarations match CLI patterns`,
      ruleId: "cli-symbol-density",
      weight: cliSignal,
    });
    signals.push(`${cliMatchCount} declarations match CLI patterns`);
  }

  // ── Category 3: Generic-structure rules ─────────────────────────────────
  // Weak signals — weights intentionally low to prevent over-prediction
  // Of schema/utility domains from generic-heavy libraries (ORM, stream, result).

  // 3a: Schema — >70% type aliases AND >10 total type aliases (tightened threshold)
  if (totalDecls > 5 && typeAliases / totalDecls > 0.7 && typeAliases > 10) {
    const weight =
      0.2 *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "schema"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${typeAliases}/${totalDecls} declarations are type aliases (>70%)`,
      ruleId: "type-alias-density",
      weight,
    });
    signals.push(`${typeAliases}/${totalDecls} declarations are type aliases`);
  }

  // 3b: Schema — >10 generic type aliases (tightened from >5)
  if (genericTypeAliases > 10) {
    const weight =
      0.15 *
      (packageNameMatchedDomain && packageNameMatchedDomain !== "schema"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${genericTypeAliases} generic type aliases detected (>10)`,
      ruleId: "generic-type-alias-count",
      weight,
    });
    signals.push(`${genericTypeAliases} generic type aliases detected`);
  }

  // 3c: Utility — >40% multi-generic functions (tightened from >30%)
  if (totalFunctions > 5 && multiGenericFunctions / totalFunctions > 0.4) {
    const weight =
      0.15 *
      (packageNameMatchedDomain &&
      packageNameMatchedDomain !== "schema" &&
      packageNameMatchedDomain !== "utility"
        ? competingDomainPenalty
        : 1);
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "schema",
      reason: `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type params`,
      ruleId: "multi-generic-fn-density",
      weight,
    });
    emit({
      category: "generic-structure",
      direction: "positive",
      domain: "utility",
      reason: `${multiGenericFunctions}/${totalFunctions} functions have >=2 generic type params`,
      ruleId: "multi-generic-fn-density",
      weight,
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

  // 4e: Validation — decoder-style libraries (decode, decoder, decodeEither, fromGuard, guard, verify)
  {
    const decoderFnNames = [
      "decode",
      "decoder",
      "decodeeither",
      "fromguard",
      "guard",
      "verify",
      "runtype",
    ];
    let decoderFnCount = 0;
    for (const decl of surface.declarations) {
      const lower = decl.name.toLowerCase();
      if (decoderFnNames.some((fn) => lower === fn || lower.includes(fn))) {
        decoderFnCount++;
      }
    }
    if (decoderFnCount >= 2) {
      emit({
        category: "scenario-trigger",
        direction: "positive",
        domain: "validation",
        reason: `${decoderFnCount} decoder-style functions found (decode/guard/verify)`,
        ruleId: "scenario:decoder-fns",
        weight: 0.2,
      });
      signals.push(`${decoderFnCount} decoder-style functions suggest validation domain`);
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

    // If declaration evidence contradicts the package-name match
    if (strongestDeclarationDomain && strongestDeclarationScore >= 0.3) {
      emit({
        category: "negative",
        direction: "negative",
        domain: packageNameMatchedDomain,
        reason: `Package name says '${packageNameMatchedDomain}' but declarations suggest '${strongestDeclarationDomain}'`,
        ruleId: "neg:pkg-vs-decl-contradiction",
        weight: -0.3,
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

  // ── Category 5b+: Additional contradiction penalties ────────────────────

  // 5c: Package-name prior beats weak generic-density signals
  // Penalize competing domains whose evidence comes only from
  // Generic-structure rules (category 3) when a package-name match exists
  if (packageNameMatchedDomain) {
    for (const [domain, domainRules] of Object.entries(rulesByDomain)) {
      if (domain === packageNameMatchedDomain || domain === "general") {
        continue;
      }
      const positiveRules = domainRules.filter((rl) => rl.score > 0);
      const onlyGenericEvidence = positiveRules.every((rl) => rl.category === "generic-structure");
      if (onlyGenericEvidence && positiveRules.length > 0) {
        emit({
          category: "negative",
          direction: "negative",
          domain,
          reason: `Package-name prior '${packageNameMatchedDomain}' overrides weak generic-structure evidence for '${domain}'`,
          ruleId: "neg:pkg-name-beats-generic",
          weight: -0.2,
        });
        signals.push(
          `Package-name match '${packageNameMatchedDomain}' penalizes weak generic evidence for '${domain}'`,
        );
      }
    }
  }

  // 5d: Scenario evidence beats weak alias-density signals
  // Penalize domains whose evidence comes only from generic-structure rules
  // When scenario-trigger evidence exists for a different domain
  const domainsWithScenarioEvidence = new Set<string>();
  for (const em of emissions) {
    if (em.category === "scenario-trigger" && em.direction === "positive") {
      domainsWithScenarioEvidence.add(em.domain);
    }
  }
  if (domainsWithScenarioEvidence.size > 0) {
    for (const [domain, domainRules] of Object.entries(rulesByDomain)) {
      if (domainsWithScenarioEvidence.has(domain) || domain === "general") {
        continue;
      }
      const positiveRules = domainRules.filter((rl) => rl.score > 0);
      const onlyGenericEvidence = positiveRules.every((rl) => rl.category === "generic-structure");
      if (onlyGenericEvidence && positiveRules.length > 0) {
        emit({
          category: "negative",
          direction: "negative",
          domain,
          reason: `Scenario evidence for ${[...domainsWithScenarioEvidence].join("/")} overrides weak generic-structure evidence for '${domain}'`,
          ruleId: "neg:scenario-beats-generic",
          weight: -0.15,
        });
        signals.push(`Scenario evidence penalizes weak generic evidence for '${domain}'`);
      }
    }
  }

  // 5f: Decoder signals reduce result confidence
  // Libraries like `decoders` have Ok/Err types but are fundamentally validation libraries
  if ((scores["result"] ?? 0) > 0.1 && (scores["validation"] ?? 0) > 0.1) {
    const validationRules = rulesByDomain["validation"] ?? [];
    const hasDecoderEvidence = validationRules.some(
      (rl) => rl.name === "scenario:decoder-fns" || rl.name === "scenario:validation-fns",
    );
    const resultRules = rulesByDomain["result"] ?? [];
    const onlySymbolEvidence = resultRules.every(
      (rl) => rl.category === "declaration-role" || rl.category === "negative",
    );
    if (hasDecoderEvidence && onlySymbolEvidence) {
      emit({
        category: "negative",
        direction: "negative",
        domain: "result",
        reason: "Decoder/validation evidence overrides Result/Ok/Err symbol matching",
        ruleId: "neg:decoder-beats-result-symbols",
        weight: -0.25,
      });
      signals.push("Decoder evidence reduces result confidence");
    }
  }

  // 5e: Conflicting domains reduce certainty before changing the chosen label
  // Reduce scores by 10% for all domains within 0.15 of each other
  // Makes it harder for weak evidence to flip the domain label
  const positiveDomains = Object.entries(scores)
    .filter(([, sc]) => sc > 0.1)
    .toSorted(([, scoreA], [, scoreB]) => scoreB - scoreA);
  if (positiveDomains.length >= 2) {
    const [, topScore] = positiveDomains[0]!;
    const closeCompetitors = positiveDomains.filter(([, sc]) => topScore - sc < 0.15);
    if (closeCompetitors.length >= 2) {
      for (const [domain] of closeCompetitors) {
        if (domain !== "general") {
          scores[domain] = (scores[domain] ?? 0) * 0.9;
        }
      }
      signals.push(
        `${closeCompetitors.length} domains within 0.15 of each other — all reduced by 10%`,
      );
    }
  }

  // If multiple competing domains have similar scores, penalize the weaker ones
  const domainScoreEntries = Object.entries(scores).filter(([, sc]) => sc > 0.1);
  if (domainScoreEntries.length >= 3 && !packageNameMatchedDomain) {
    // Many competing domains is itself a signal of low specificity — reduce all slightly
    for (const [domain] of domainScoreEntries) {
      if (domain !== "general") {
        scores[domain] = (scores[domain] ?? 0) * 0.85;
      }
    }
    signals.push(`${domainScoreEntries.length} competing domains detected — confidence reduced`);
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

  // ── Compute ambiguity gap ───────────────────────────────────────────────

  const ambiguityGap = bestScore - secondBestScore;

  // Abstain to general in these cases:
  // 1. No package-name match and ambiguity gap is too narrow
  // 2. Winner has only generic-structure evidence (no declaration-role or scenario-trigger)
  // 3. Winner has only a single weak rule
  if (bestDomain !== "general") {
    const bestRulesForAbstention = rulesByDomain[bestDomain] ?? [];
    const hasStrongEvidence = bestRulesForAbstention.some(
      (rule) =>
        rule.category === "package-name" ||
        rule.category === "declaration-role" ||
        rule.category === "scenario-trigger",
    );
    const onlyGenericStructure = bestRulesForAbstention.every(
      (rule) => rule.category === "generic-structure" || rule.category === "negative",
    );

    if (!packageNameMatchedDomain && ambiguityGap < 0.2) {
      signals.push(
        `Abstaining from ${bestDomain}: ambiguity gap ${ambiguityGap.toFixed(2)} < 0.2 without package-name match`,
      );
      bestDomain = "general";
      bestScore = 0;
    } else if (onlyGenericStructure && !packageNameMatchedDomain) {
      // Only generic-structure rules matched — too weak to commit
      signals.push(
        `Abstaining from ${bestDomain}: only generic-structure evidence (no declaration-role or scenario-trigger)`,
      );
      bestDomain = "general";
      bestScore = 0;
    } else if (bestDomain === "utility" && !packageNameMatchedDomain && bestScore < 0.5) {
      // Utility with weak evidence and no package-name match — prefer general
      // Generic density alone is insufficient to classify as utility
      signals.push(
        `Abstaining from utility: weak evidence (score ${bestScore.toFixed(2)}) without package-name match — preferring general`,
      );
      bestDomain = "general";
      bestScore = 0;
    } else if (!hasStrongEvidence && !packageNameMatchedDomain && bestScore < 0.55) {
      // Weak evidence without package-name — abstain
      signals.push(
        `Abstaining from ${bestDomain}: no strong evidence (score ${bestScore.toFixed(2)}) without package-name match`,
      );
      bestDomain = "general";
      bestScore = 0;
    }
  }

  // No utility fallback — type alias density alone is insufficient evidence.
  // Libraries like ts-pattern use many type aliases but are general-purpose.
  // If no domain-specific evidence is found, "general" is the correct default.

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

  if (bestDomain === "state") {
    adjustments.push({
      adjustment: "accept reactive primitives",
      dimension: "apiSpecificity",
      reason: "State management libraries use reactive store/atom primitives",
    });
  }

  if (bestDomain === "testing") {
    adjustments.push({
      adjustment: "accept mock/fixture patterns",
      dimension: "apiSafety",
      reason: "Testing libraries intentionally use flexible mock types",
    });
  }

  if (bestDomain === "cli") {
    adjustments.push({
      adjustment: "accept builder pattern chains",
      dimension: "surfaceComplexity",
      reason: "CLI libraries use builder patterns for option/argument chaining",
    });
  }

  // ── Compute evidence classes ────────────────────────────────────────────

  const evidenceClasses: string[] = [];
  const bestRulesEvidence = rulesByDomain[bestDomain] ?? [];
  const evidenceCategories = new Set(bestRulesEvidence.map((rl) => rl.category));
  if (evidenceCategories.has("package-name")) {
    evidenceClasses.push("package-name");
  }
  if (evidenceCategories.has("declaration-role")) {
    evidenceClasses.push("declaration-role");
  }
  if (evidenceCategories.has("scenario-trigger")) {
    evidenceClasses.push("scenario-trigger");
  }
  if (evidenceCategories.has("generic-structure")) {
    evidenceClasses.push("generic-structure");
  }

  // ── Compute secondary domains ──────────────────────────────────────────

  const secondaryDomains = Object.entries(scores)
    .filter(([dm, sc]) => dm !== bestDomain && sc > 0.1)
    .toSorted(([, sa], [, sb]) => sb - sa)
    .slice(0, 3)
    .map(([dm, sc]) => ({
      confidence: Math.max(0, Math.min(1, sc * (1 - falsePositiveRisk * 0.3))),
      domain: dm as DomainType,
      score: Math.round(sc * 100) / 100,
    }));

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

  if (secondaryDomains.length > 0) {
    result.secondaryDomains = secondaryDomains;
  }

  if (evidenceClasses.length > 0) {
    result.evidenceClasses = evidenceClasses;
  }

  return result;
}
