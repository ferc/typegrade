import type { ConfidenceSignal, DimensionResult, Issue } from "../types.js";
import type {
  PublicSurface,
  SurfaceDeclaration,
  SurfaceMethod,
  SurfaceTypeParam,
} from "../surface/index.js";
import { type Type, TypeFlags } from "ts-morph";
import { DIMENSION_CONFIGS } from "../constants.js";

const CONFIG = DIMENSION_CONFIGS.find((cfg) => cfg.key === "specializationPower")!;

// --- Signal point values ---

const SIGNAL_POINTS = {
  consumerGenericNarrowing: 5,
  keyPreservingTransform: 5,
  loaderActionPropagation: 5,
  queryBuilderNarrowing: 6,
  resultChannelPropagation: 5,
  routeParamExtraction: 6,
  schemaDecodeSpecialization: 6,
  searchParamPropagation: 5,
} as const;

// Max contributions per signal category
const SIGNAL_CAPS = {
  consumerGenericNarrowing: 15,
  keyPreservingTransform: 15,
  loaderActionPropagation: 15,
  queryBuilderNarrowing: 18,
  resultChannelPropagation: 15,
  routeParamExtraction: 18,
  schemaDecodeSpecialization: 18,
  searchParamPropagation: 15,
} as const;

// --- Penalty values ---

const PENALTY_UNCONSTRAINED_BROAD = 3;
const PENALTY_UNCONSTRAINED_BROAD_CAP = 12;

const PENALTY_HELPER_CHAIN_ERASE = 3;
const PENALTY_HELPER_CHAIN_ERASE_CAP = 9;

const PENALTY_ESCAPE_HATCH = 4;
const PENALTY_ESCAPE_HATCH_CAP = 12;

// --- Builder method names for query-builder detection ---

const BUILDER_METHOD_NAMES = new Set([
  "select",
  "where",
  "join",
  "from",
  "groupBy",
  "orderBy",
  "having",
  "leftJoin",
  "rightJoin",
  "innerJoin",
  "limit",
  "offset",
  "returning",
  "insert",
  "update",
  "delete",
]);

// --- Loader/action/handler name patterns ---

const LOADER_ACTION_PATTERNS = [
  /loader/i,
  /action/i,
  /handler/i,
  /middleware/i,
  /resolver/i,
  /getServerSideProps/i,
  /getStaticProps/i,
  /createHandler/i,
  /defineHandler/i,
];

// --- Result/Effect type patterns ---

const RESULT_EFFECT_PATTERNS = [
  /^Result\s*</,
  /^Either\s*</,
  /^Effect\s*</,
  /^IO\s*</,
  /^Task\s*</,
  /^TaskEither\s*</,
  /^Observable\s*</,
  /^Option\s*</,
];

// --- Accumulator ---

interface SignalAccumulator {
  consumerGenericNarrowing: number;
  keyPreservingTransform: number;
  loaderActionPropagation: number;
  queryBuilderNarrowing: number;
  resultChannelPropagation: number;
  routeParamExtraction: number;
  schemaDecodeSpecialization: number;
  searchParamPropagation: number;
}

interface PenaltyAccumulator {
  escapeHatch: number;
  helperChainErase: number;
  unconstrainedBroad: number;
}

// =====================================================================
// Main analyzer
// =====================================================================

export function analyzeSpecializationPower(surface: PublicSurface): DimensionResult {
  const issues: Issue[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  const signals: SignalAccumulator = {
    consumerGenericNarrowing: 0,
    keyPreservingTransform: 0,
    loaderActionPropagation: 0,
    queryBuilderNarrowing: 0,
    resultChannelPropagation: 0,
    routeParamExtraction: 0,
    schemaDecodeSpecialization: 0,
    searchParamPropagation: 0,
  };

  const penalties: PenaltyAccumulator = {
    escapeHatch: 0,
    helperChainErase: 0,
    unconstrainedBroad: 0,
  };

  // Applicability: if no type parameters exist at all, specialization is not applicable
  const totalTypeParams = surface.declarations.reduce(
    (sum, decl) => sum + decl.typeParameters.length,
    0,
  );
  const totalMethodTypeParams = surface.declarations.reduce(
    (sum, decl) => sum + (decl.methods ?? []).reduce((ms, mt) => ms + mt.typeParameters.length, 0),
    0,
  );
  const allTypeParams = totalTypeParams + totalMethodTypeParams;

  if (allTypeParams === 0 && surface.stats.totalDeclarations > 0) {
    return {
      applicability: "not_applicable",
      applicabilityReasons: [
        "No generic type parameters in public surface — no specialization axis",
      ],
      confidence: 0.9,
      confidenceSignals: [
        { reason: "Clear non-applicability", source: "applicability", value: 0.9 },
      ],
      enabled: true,
      issues: [],
      key: CONFIG.key,
      label: CONFIG.label,
      metrics: { signalCount: 0, totalPenalty: 0, totalScore: 0 },
      negatives: [],
      positives: ["Specialization not applicable — no generic type parameters"],
      score: null,
      weights: CONFIG.weights,
    };
  }

  let declarationsWithSpecialization = 0;

  for (const decl of surface.declarations) {
    const hadSignalBefore = countTotalSignals(signals);

    switch (decl.kind) {
      case "function": {
        analyzeFunctionDecl({ decl, issues, penalties, signals });
        break;
      }
      case "interface": {
        analyzeInterfaceDecl({ decl, issues, penalties, signals });
        break;
      }
      case "type-alias": {
        analyzeTypeAliasDecl(decl, signals, penalties);
        break;
      }
      case "class": {
        analyzeClassDecl({ decl, issues, penalties, signals });
        break;
      }
      case "variable": {
        analyzeVariableDecl(decl, signals, penalties);
        break;
      }
      // Enums have no specialization power
    }

    if (countTotalSignals(signals) > hadSignalBefore) {
      declarationsWithSpecialization++;
    }
  }

  // --- Compute raw score from capped signal contributions ---

  let score = 0;

  const cappedRouteParam = Math.min(
    signals.routeParamExtraction * SIGNAL_POINTS.routeParamExtraction,
    SIGNAL_CAPS.routeParamExtraction,
  );
  score += cappedRouteParam;

  const cappedSearchParam = Math.min(
    signals.searchParamPropagation * SIGNAL_POINTS.searchParamPropagation,
    SIGNAL_CAPS.searchParamPropagation,
  );
  score += cappedSearchParam;

  const cappedLoaderAction = Math.min(
    signals.loaderActionPropagation * SIGNAL_POINTS.loaderActionPropagation,
    SIGNAL_CAPS.loaderActionPropagation,
  );
  score += cappedLoaderAction;

  const cappedSchemaDecode = Math.min(
    signals.schemaDecodeSpecialization * SIGNAL_POINTS.schemaDecodeSpecialization,
    SIGNAL_CAPS.schemaDecodeSpecialization,
  );
  score += cappedSchemaDecode;

  const cappedQueryBuilder = Math.min(
    signals.queryBuilderNarrowing * SIGNAL_POINTS.queryBuilderNarrowing,
    SIGNAL_CAPS.queryBuilderNarrowing,
  );
  score += cappedQueryBuilder;

  const cappedResultChannel = Math.min(
    signals.resultChannelPropagation * SIGNAL_POINTS.resultChannelPropagation,
    SIGNAL_CAPS.resultChannelPropagation,
  );
  score += cappedResultChannel;

  const cappedKeyPreserving = Math.min(
    signals.keyPreservingTransform * SIGNAL_POINTS.keyPreservingTransform,
    SIGNAL_CAPS.keyPreservingTransform,
  );
  score += cappedKeyPreserving;

  const cappedConsumerNarrowing = Math.min(
    signals.consumerGenericNarrowing * SIGNAL_POINTS.consumerGenericNarrowing,
    SIGNAL_CAPS.consumerGenericNarrowing,
  );
  score += cappedConsumerNarrowing;

  // --- Apply penalties ---

  const unconstrainedPenalty = Math.min(
    penalties.unconstrainedBroad * PENALTY_UNCONSTRAINED_BROAD,
    PENALTY_UNCONSTRAINED_BROAD_CAP,
  );
  score -= unconstrainedPenalty;

  const helperChainPenalty = Math.min(
    penalties.helperChainErase * PENALTY_HELPER_CHAIN_ERASE,
    PENALTY_HELPER_CHAIN_ERASE_CAP,
  );
  score -= helperChainPenalty;

  const escapeHatchPenalty = Math.min(
    penalties.escapeHatch * PENALTY_ESCAPE_HATCH,
    PENALTY_ESCAPE_HATCH_CAP,
  );
  score -= escapeHatchPenalty;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // --- Confidence ---

  const confidence = Math.min(1, declarationsWithSpecialization / 20);
  const confidenceSignals: ConfidenceSignal[] = [
    {
      reason: `${declarationsWithSpecialization} declarations with specialization signals (20 = full confidence)`,
      source: "specialization-coverage",
      value: confidence,
    },
  ];

  // --- Build positives ---

  if (signals.routeParamExtraction > 0) {
    positives.push(
      `${signals.routeParamExtraction} route param extraction pattern(s) (+${cappedRouteParam})`,
    );
  }
  if (signals.searchParamPropagation > 0) {
    positives.push(
      `${signals.searchParamPropagation} search param propagation pattern(s) (+${cappedSearchParam})`,
    );
  }
  if (signals.loaderActionPropagation > 0) {
    positives.push(
      `${signals.loaderActionPropagation} loader/action result propagation pattern(s) (+${cappedLoaderAction})`,
    );
  }
  if (signals.schemaDecodeSpecialization > 0) {
    positives.push(
      `${signals.schemaDecodeSpecialization} schema decode/parse specialization(s) (+${cappedSchemaDecode})`,
    );
  }
  if (signals.queryBuilderNarrowing > 0) {
    positives.push(
      `${signals.queryBuilderNarrowing} query builder row-shape narrowing pattern(s) (+${cappedQueryBuilder})`,
    );
  }
  if (signals.resultChannelPropagation > 0) {
    positives.push(
      `${signals.resultChannelPropagation} result/effect channel propagation pattern(s) (+${cappedResultChannel})`,
    );
  }
  if (signals.keyPreservingTransform > 0) {
    positives.push(
      `${signals.keyPreservingTransform} key-preserving transform pattern(s) (+${cappedKeyPreserving})`,
    );
  }
  if (signals.consumerGenericNarrowing > 0) {
    positives.push(
      `${signals.consumerGenericNarrowing} consumer-instantiated generic narrowing pattern(s) (+${cappedConsumerNarrowing})`,
    );
  }
  if (score >= 60) {
    positives.push("Strong specialization power across exports");
  }

  // --- Build negatives ---

  if (penalties.unconstrainedBroad > 0) {
    negatives.push(
      `${penalties.unconstrainedBroad} unconstrained generic(s) with no output correlation (-${unconstrainedPenalty})`,
    );
  }
  if (penalties.helperChainErase > 0) {
    negatives.push(
      `${penalties.helperChainErase} helper chain(s) erasing type relationships (-${helperChainPenalty})`,
    );
  }
  if (penalties.escapeHatch > 0) {
    negatives.push(
      `${penalties.escapeHatch} public escape hatch(es) (as-any / broad overloads) (-${escapeHatchPenalty})`,
    );
  }
  if (score < 20) {
    negatives.push("Limited specialization power: types remain broad after consumer instantiation");
  }

  const totalSignals = countTotalSignals(signals);

  // Insufficient evidence when very few generic type parameters
  let applicability: "applicable" | "not_applicable" | "insufficient_evidence" = "applicable";
  let applicabilityReasons: string[] = [];
  if (allTypeParams > 0 && allTypeParams < 3) {
    applicability = "insufficient_evidence";
    applicabilityReasons = [
      `Only ${allTypeParams} generic type parameter(s) — weak specialization evidence`,
    ];
  }

  return {
    applicability,
    applicabilityReasons,
    confidence,
    confidenceSignals,
    enabled: true,
    issues,
    key: CONFIG.key,
    label: CONFIG.label,
    metrics: {
      consumerGenericNarrowing: signals.consumerGenericNarrowing,
      declarationsWithSpecialization,
      escapeHatchPenalty,
      helperChainPenalty,
      keyPreservingTransform: signals.keyPreservingTransform,
      loaderActionPropagation: signals.loaderActionPropagation,
      queryBuilderNarrowing: signals.queryBuilderNarrowing,
      resultChannelPropagation: signals.resultChannelPropagation,
      routeParamExtraction: signals.routeParamExtraction,
      schemaDecodeSpecialization: signals.schemaDecodeSpecialization,
      searchParamPropagation: signals.searchParamPropagation,
      totalSignals,
      unconstrainedPenalty,
    },
    negatives,
    positives,
    score,
    weights: CONFIG.weights,
  };
}

// =====================================================================
// Signal detection helpers
// =====================================================================

function countTotalSignals(signals: SignalAccumulator): number {
  return (
    signals.routeParamExtraction +
    signals.searchParamPropagation +
    signals.loaderActionPropagation +
    signals.schemaDecodeSpecialization +
    signals.queryBuilderNarrowing +
    signals.resultChannelPropagation +
    signals.keyPreservingTransform +
    signals.consumerGenericNarrowing
  );
}

// =====================================================================
// 1. Route param extraction potential
// =====================================================================

/**
 * Detect template literal types or constrained generics with path-like patterns
 * (e.g., `/${string}`, backtick patterns with `${}`) in type parameters.
 * These indicate the library can extract route params from path strings.
 */
function detectRouteParamExtraction(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[],
  returnTypeNodeText: string,
): number {
  let count = 0;

  // Check constraints on type parameters for template literal path patterns
  for (const tp of typeParams) {
    const constraintText = tp.constraintNode?.getText() ?? "";

    // Template literal constraint: `/${string}`, `/${infer X}/${infer Y}`, etc.
    const hasPathPattern =
      constraintText.includes("`") &&
      (constraintText.includes("/${") ||
        constraintText.includes("/`") ||
        constraintText.includes("${string}"));

    // String constraint with template literal in body (e.g., extends string, used in template literal)
    const hasStringConstraint = constraintText === "string" || constraintText.includes("string");

    if (hasPathPattern) {
      // Check if this path param flows to the output (return type references it)
      const flowsToOutput = returnTypeNodeText.includes(tp.name);
      if (flowsToOutput) {
        count++;
      } else {
        // Still a route extraction pattern even without output flow, but weaker
        count++;
      }
    } else if (hasStringConstraint) {
      // Check if param type nodes use template literal syntax with this type param
      for (const paramNode of paramTypeNodes) {
        const paramText = paramNode.typeNode?.getText() ?? "";
        if (paramText.includes("`") && paramText.includes(`\${${tp.name}}`)) {
          count++;
          break;
        }
      }
    }
  }

  // Also check if param type nodes directly contain path template patterns
  for (const paramNode of paramTypeNodes) {
    const text = paramNode.typeNode?.getText() ?? "";
    // Match patterns like `/${string}` or template literals with path separators
    if (text.includes("`") && text.includes("/${") && text.includes("}")) {
      // Avoid double-counting if already detected via type param constraints
      const alreadyCounted = typeParams.some((tp) => {
        const ct = tp.constraintNode?.getText() ?? "";
        return ct.includes("`") && ct.includes("/${");
      });
      if (!alreadyCounted) {
        count++;
      }
    }
  }

  // Check for route-related generic patterns in function names or type aliases
  // That use infer with string template patterns
  for (const paramNode of paramTypeNodes) {
    const text = paramNode.typeNode?.getText() ?? "";
    // Patterns like `infer Param` inside template literal types
    if (/`[^`]*\$\{infer\s+\w+\}[^`]*`/.test(text)) {
      count++;
    }
  }

  return count;
}

// =====================================================================
// 2. Search param propagation potential
// =====================================================================

/**
 * Detect generic types that map search/query params to typed objects.
 * Look for Record<string, T> patterns that get specialized, or
 * SearchParams<T>, QueryParams<T> type patterns.
 */
function detectSearchParamPropagation(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[],
  returnTypeNodeText: string,
): number {
  let count = 0;

  const paramTexts = paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "");
  const allParamText = paramTexts.join(" ");

  for (const tp of typeParams) {
    const tpName = tp.name;
    const constraintText = tp.constraintNode?.getText() ?? "";

    // Pattern: generic constrained to Record<string, X> or { [key: string]: X }
    const isRecordConstraint =
      /Record<string,\s*\w+>/.test(constraintText) || /\{\s*\[/.test(constraintText);

    // Pattern: generic used in search/query param positions
    const inSearchParam = paramTexts.some(
      (text) =>
        (text.includes(tpName) &&
          (/[Ss]earch/.test(text) || /[Qq]uery/.test(text) || /[Pp]arams/.test(text))) ||
        (text.includes("Record<string") && text.includes(tpName)),
    );

    // Pattern: generic with object constraint that flows to output
    const isObjectConstraint =
      constraintText === "object" ||
      constraintText.startsWith("{") ||
      /Record</.test(constraintText);

    if (isRecordConstraint && returnTypeNodeText.includes(tpName)) {
      count++;
    } else if (inSearchParam && returnTypeNodeText.includes(tpName)) {
      count++;
    } else if (
      isObjectConstraint &&
      allParamText.includes(tpName) &&
      returnTypeNodeText.includes(tpName)
    ) {
      // Object-constrained generic that maps input to output — potential search param propagation
      // Only count if the name or context suggests param mapping
      const nameHint =
        /[Ss]earch|[Qq]uery|[Pp]aram|[Ii]nput|[Ss]chema/.test(tpName) ||
        paramTexts.some((pt) => /[Ss]earch|[Qq]uery|[Pp]aram/.test(pt));
      if (nameHint) {
        count++;
      }
    }
  }

  return count;
}

// =====================================================================
// 3. Loader/action result propagation potential
// =====================================================================

/**
 * Detect generic functions where return type contains the type parameter
 * (input-to-output correlation) specifically in loader/handler/action patterns.
 */
interface LoaderActionOpts {
  declName: string;
  paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[];
  returnTypeNodeText: string;
  typeParams: SurfaceTypeParam[];
}

function detectLoaderActionPropagation(opts: LoaderActionOpts): number {
  const { declName, typeParams, paramTypeNodes, returnTypeNodeText } = opts;
  let count = 0;

  // Check if declaration name matches loader/action/handler patterns
  const isLoaderAction = LOADER_ACTION_PATTERNS.some((pat) => pat.test(declName));

  for (const tp of typeParams) {
    const tpName = tp.name;
    const inParams = paramTypeNodes.some((pt) => (pt.typeNode?.getText() ?? "").includes(tpName));
    const inReturn = returnTypeNodeText.includes(tpName);

    if (inParams && inReturn) {
      if (isLoaderAction) {
        // Direct match: loader/action function with correlated generic
        count++;
      } else {
        // Check if the function signature suggests a loader/action pattern:
        // - Accepts a function/callback param whose return flows to outer return
        // - Has params named "loader", "action", "handler", etc.
        const hasCallbackParam = paramTypeNodes.some((pt) => {
          const text = pt.typeNode?.getText() ?? "";
          return (text.includes("=>") || text.includes("Promise")) && text.includes(tpName);
        });
        const hasLoaderParamName = paramTypeNodes.some((pt) =>
          LOADER_ACTION_PATTERNS.some((pat) => pat.test(pt.name)),
        );
        if (hasCallbackParam || hasLoaderParamName) {
          count++;
        }
      }
    }
  }

  return count;
}

// =====================================================================
// 4. Schema decode/parse output specialization
// =====================================================================

/**
 * Detect functions that accept unknown/any input with generic output types.
 * Validation libraries (zod, valibot, etc.) should score high here.
 * Patterns: parse(input: unknown): T, decode(input: unknown): Either<E, T>
 */
function detectSchemaDecodeSpecialization(
  _decl: SurfaceDeclaration,
  methodsOrSelf: {
    name: string;
    typeParameters: SurfaceTypeParam[];
    paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[];
    returnTypeNodeText: string;
    positions: { role: string; type: Type }[];
  }[],
): number {
  let count = 0;

  for (const entry of methodsOrSelf) {
    const { name, typeParameters, paramTypeNodes, returnTypeNodeText, positions } = entry;

    // Check if any param accepts unknown/any
    const hasUnknownInput = positions.some((pos) => {
      if (pos.role !== "param") {
        return false;
      }
      const flags = pos.type.getFlags();
      return Boolean(flags & (TypeFlags.Any | TypeFlags.Unknown));
    });

    // Also check param type node text for unknown/any
    const hasUnknownParamText = paramTypeNodes.some((pt) => {
      const text = pt.typeNode?.getText() ?? "";
      return text === "unknown" || text === "any" || text.includes("unknown");
    });

    // Check for parse/decode/validate/safeParse name patterns
    const isParseFunction =
      /^(parse|decode|safeParse|validate|coerce|transform|check|assert|create|infer|refine)$/i.test(
        name,
      ) || /parse|decode|validate/i.test(name);

    if ((hasUnknownInput || hasUnknownParamText) && typeParameters.length > 0) {
      // Generic function accepting unknown — check if output is specialized
      const outputUsesGeneric = typeParameters.some((tp) => returnTypeNodeText.includes(tp.name));
      if (outputUsesGeneric) {
        count++;
      }
    } else if (isParseFunction && typeParameters.length > 0) {
      // Parse-like function with generics — check generic flows to output
      const outputUsesGeneric = typeParameters.some((tp) => returnTypeNodeText.includes(tp.name));
      if (outputUsesGeneric) {
        count++;
      }
    }

    // Also detect schema-style: method takes a schema/validator param with generic,
    // And returns the inferred type
    if (typeParameters.length > 0) {
      const hasSchemaParam = paramTypeNodes.some((pt) => {
        const text = pt.typeNode?.getText() ?? "";
        return (
          /Schema|Validator|Type|Codec|Struct|Parser/.test(text) &&
          typeParameters.some((tp) => text.includes(tp.name))
        );
      });
      if (hasSchemaParam) {
        const outputUsesGeneric = typeParameters.some((tp) => returnTypeNodeText.includes(tp.name));
        if (outputUsesGeneric) {
          count++;
        }
      }
    }
  }

  return count;
}

// =====================================================================
// 5. Query builder row-shape narrowing potential
// =====================================================================

/**
 * Detect builder pattern methods (select, where, join, from) with generic
 * type parameters that narrow the output shape. The return type should
 * reference the generic to indicate row-shape narrowing.
 */
function detectQueryBuilderNarrowing(
  methods: SurfaceMethod[],
  declTypeParams: SurfaceTypeParam[],
): number {
  let count = 0;
  let builderMethodsFound = 0;
  let builderMethodsWithGenericReturn = 0;

  for (const method of methods) {
    if (!BUILDER_METHOD_NAMES.has(method.name)) {
      continue;
    }
    builderMethodsFound++;

    const returnText = method.returnTypeNode?.getText() ?? "";

    // Check if method has its own type params or uses declaration-level type params
    const allTypeParams = [...method.typeParameters, ...declTypeParams];

    // The method should return a type that references a generic (narrowing the shape)
    const hasGenericReturn = allTypeParams.some((tp) => returnText.includes(tp.name));

    // Check if method has type params that appear in both params and return (narrowing)
    const hasNarrowingGeneric = method.typeParameters.some((tp) => {
      const inParams = method.paramTypeNodes.some((pt) =>
        (pt.typeNode?.getText() ?? "").includes(tp.name),
      );
      return inParams && returnText.includes(tp.name);
    });

    // Check if return type looks like a builder (returns Self or same interface)
    const returnsSelf = /Builder|Query|Select|Chain/.test(returnText) || returnText.includes("<");

    if (hasNarrowingGeneric) {
      builderMethodsWithGenericReturn++;
      count++;
    } else if (hasGenericReturn && returnsSelf) {
      builderMethodsWithGenericReturn++;
      count++;
    }
  }

  // Bonus: if there are multiple builder methods, the pattern is stronger
  // But already capped by SIGNAL_CAPS
  if (builderMethodsFound >= 3 && builderMethodsWithGenericReturn === 0) {
    // Builder methods exist but none narrow generics — no signal
    return 0;
  }

  return count;
}

// =====================================================================
// 6. Result/effect channel propagation potential
// =====================================================================

/**
 * Detect Result<T, E>, Either<L, R>, Effect<A, E, R> patterns where
 * both success and error channels are generic. Multi-channel generics
 * indicate strong specialization power.
 */
function detectResultChannelPropagation(decl: SurfaceDeclaration): number {
  let count = 0;

  // Check type aliases with Result/Either/Effect patterns
  if (decl.kind === "type-alias" && decl.bodyTypeNode) {
    const bodyText = decl.bodyTypeNode.getText();
    if (decl.typeParameters.length >= 2) {
      // Two or more type params: potential dual-channel pattern
      const hasResultPattern = RESULT_EFFECT_PATTERNS.some((pat) => pat.test(bodyText));
      if (hasResultPattern) {
        count++;
      }

      // Check if body is a union with both success and error shapes
      if (bodyText.includes("|") && decl.typeParameters.length >= 2) {
        const tp0 = decl.typeParameters[0]!.name;
        const tp1 = decl.typeParameters[1]!.name;
        if (bodyText.includes(tp0) && bodyText.includes(tp1)) {
          // Both type params appear in the union body — dual channel
          count++;
        }
      }
    }
  }

  // Check functions that return Result/Either/Effect types
  if (decl.kind === "function" && decl.typeParameters.length >= 2) {
    const returnText = decl.returnTypeNode?.getText() ?? "";
    const hasResultReturn = RESULT_EFFECT_PATTERNS.some((pat) => pat.test(returnText));
    if (hasResultReturn) {
      // Verify multiple type params flow to the result
      const tpInReturn = decl.typeParameters.filter((tp) => returnText.includes(tp.name));
      if (tpInReturn.length >= 2) {
        count++;
      }
    }
  }

  // Check interfaces/classes with methods that return dual-channel types
  if ((decl.kind === "interface" || decl.kind === "class") && decl.methods) {
    for (const method of decl.methods) {
      const returnText = method.returnTypeNode?.getText() ?? "";
      const hasResultReturn = RESULT_EFFECT_PATTERNS.some((pat) => pat.test(returnText));
      if (hasResultReturn) {
        const allTp = [...method.typeParameters, ...decl.typeParameters];
        const tpInReturn = allTp.filter((tp) => returnText.includes(tp.name));
        if (tpInReturn.length >= 2) {
          count++;
        }
      }

      // Also detect methods like map, flatMap, mapErr that propagate channels
      if (
        /^(map|flatMap|mapErr|mapError|bimap|fold|match|chain|andThen|orElse)$/.test(method.name) &&
        method.typeParameters.length > 0
      ) {
        const returnHasNewTp = method.typeParameters.some((tp) => returnText.includes(tp.name));
        if (returnHasNewTp) {
          count++;
        }
      }
    }
  }

  return count;
}

// =====================================================================
// 7. Key-preserving transform potential
// =====================================================================

/**
 * Detect mapped types with `keyof` and `in keyof` patterns in type alias bodies.
 * These represent transforms that preserve the key structure of the input type.
 */
function detectKeyPreservingTransform(decl: SurfaceDeclaration): number {
  let count = 0;

  if (decl.kind === "type-alias" && decl.bodyTypeNode && decl.typeParameters.length > 0) {
    const bodyText = decl.bodyTypeNode.getText();

    // Primary pattern: [K in keyof T]: ...
    if (/\[\s*\w+\s+in\s+keyof\s+\w+\s*\]/.test(bodyText)) {
      count++;
    }

    // Pattern: mapped type with key remapping [K in keyof T as ...]
    // Key remapping is an even stronger signal, but already counted above
    // Add extra credit only if not already counted
    if (/\[\s*\w+\s+in\s+keyof\s+\w+\s+as\s/.test(bodyText) && count === 0) {
      count++;
    }

    // Pattern: Pick<T, K>, Omit<T, K>, Partial<T>, Required<T> with generic
    if (
      decl.typeParameters.length > 0 &&
      /\b(Pick|Omit|Partial|Required|Readonly|Record|Extract|Exclude)\s*</.test(bodyText)
    ) {
      const usesGeneric = decl.typeParameters.some((tp) => bodyText.includes(tp.name));
      if (usesGeneric) {
        count++;
      }
    }

    // Pattern: {[P in K]: T[P]} or similar property-preserving patterns
    if (/\[\s*\w+\s+in\s+\w+\s*\]\s*:\s*\w+\[\s*\w+\s*\]/.test(bodyText)) {
      const usesGeneric = decl.typeParameters.some((tp) => bodyText.includes(tp.name));
      if (usesGeneric && count === 0) {
        count++;
      }
    }
  }

  // Interfaces/classes with generic methods using keyof patterns
  if ((decl.kind === "interface" || decl.kind === "class") && decl.methods) {
    for (const method of decl.methods) {
      if (method.typeParameters.length === 0 && decl.typeParameters.length === 0) {
        continue;
      }

      const paramTexts = method.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "");
      const returnText = method.returnTypeNode?.getText() ?? "";
      const allText = [...paramTexts, returnText].join(" ");

      // Method that uses keyof in params and preserves keys in return
      if (paramTexts.some((pt) => pt.includes("keyof")) && returnText.includes("keyof")) {
        count++;
      }

      // Method like get<K extends keyof T>(key: K): T[K]
      if (/keyof/.test(allText) && /\[\s*\w+\s*\]/.test(returnText)) {
        const allTp = [...method.typeParameters, ...decl.typeParameters];
        const usesGeneric = allTp.some((tp) => returnText.includes(tp.name));
        if (usesGeneric) {
          count++;
        }
      }
    }
  }

  return count;
}

// =====================================================================
// 8. Consumer-instantiated generic narrowing potential
// =====================================================================

/**
 * Detect generics with structural constraints that, when instantiated,
 * produce narrow types. Check constraint strength and whether the generic
 * flows to the output.
 */
function detectConsumerGenericNarrowing(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[],
  returnTypeNodeText: string,
): number {
  let count = 0;

  for (const tp of typeParams) {
    const constraintText = tp.constraintNode?.getText() ?? "";
    const tpName = tp.name;

    // Structural constraint: extends { ... } or extends interface
    const isStructuralConstraint =
      constraintText.startsWith("{") ||
      /extends\s*\{/.test(constraintText) ||
      (constraintText.length > 0 &&
        constraintText !== "string" &&
        constraintText !== "number" &&
        constraintText !== "boolean" &&
        constraintText !== "object" &&
        constraintText !== "any" &&
        constraintText !== "unknown" &&
        !constraintText.startsWith("Record<string,") &&
        /^[A-Z]/.test(constraintText));

    // Strong constraint: extends an interface or object shape with properties
    const isStrongConstraint =
      constraintText.includes("{") && constraintText.includes(":") && constraintText.includes("}");

    // Array/tuple constraint
    const isArrayConstraint =
      /\w+\[\]/.test(constraintText) ||
      constraintText.startsWith("readonly") ||
      constraintText.startsWith("Array<");

    // Check if the generic flows to the output
    const flowsToOutput = returnTypeNodeText.includes(tpName);

    // Check if the generic is used in params
    const usedInParams = paramTypeNodes.some((pt) =>
      (pt.typeNode?.getText() ?? "").includes(tpName),
    );

    if (flowsToOutput && usedInParams) {
      if (isStrongConstraint) {
        count++;
      } else if (isStructuralConstraint) {
        count++;
      } else if (isArrayConstraint) {
        count++;
      }
    }
  }

  return count;
}

// =====================================================================
// Penalty detection
// =====================================================================

/**
 * Detect unconstrained generics that remain broad after instantiation.
 * These have no output correlation (generic in params but not in return).
 */
function detectUnconstrainedBroadGenerics(
  typeParams: SurfaceTypeParam[],
  paramTypeNodes: { name: string; typeNode: { getText(): string } | undefined }[],
  returnTypeNodeText: string,
): number {
  let count = 0;

  for (const tp of typeParams) {
    const constraintText = tp.constraintNode?.getText() ?? "";
    const tpName = tp.name;

    // Unconstrained: no constraint or constraint is any/unknown
    const isUnconstrained =
      !tp.hasConstraint ||
      constraintText === "" ||
      constraintText === "any" ||
      constraintText === "unknown";

    if (!isUnconstrained) {
      continue;
    }

    // Check if used in params but NOT in return (no output correlation)
    const usedInParams = paramTypeNodes.some((pt) =>
      (pt.typeNode?.getText() ?? "").includes(tpName),
    );
    const flowsToOutput = returnTypeNodeText.includes(tpName);

    if (usedInParams && !flowsToOutput) {
      count++;
    }
  }

  return count;
}

/**
 * Detect helper chains that erase type relationships.
 * Methods returning opaque types with >3 type references indicate erasure.
 */
function detectHelperChainErasure(methods: SurfaceMethod[]): number {
  let count = 0;

  for (const method of methods) {
    const returnText = method.returnTypeNode?.getText() ?? "";

    // Count distinct type references (capitalized identifiers followed by <)
    const typeRefs = returnText.match(/[A-Z]\w+</g) ?? [];
    const uniqueTypeRefs = new Set(typeRefs);

    if (uniqueTypeRefs.size > 3) {
      // Opaque return: many type references but no method-level generics flowing through
      const ownTpInReturn = method.typeParameters.some((tp) => returnText.includes(tp.name));
      if (!ownTpInReturn) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Detect public escape hatches: `as any` patterns, broad overloads.
 */
function detectEscapeHatches(decl: SurfaceDeclaration, issues: Issue[]): number {
  let count = 0;

  // Check for broad return types (any)
  for (const pos of decl.positions) {
    if (pos.role === "return") {
      const flags = pos.type.getFlags();
      if (flags & TypeFlags.Any) {
        count++;
        issues.push({
          column: pos.column,
          dimension: CONFIG.label,
          file: pos.filePath,
          line: pos.line,
          message: `${decl.name}() returns 'any', erasing specialization potential`,
          severity: "warning",
        });
      }
    }
  }

  // Check for overloads where the last one is an escape hatch (all params any)
  if ((decl.overloadCount ?? 0) > 0 && decl.paramTypeNodes) {
    const lastParamTypes = decl.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "");
    const allAny = lastParamTypes.length > 0 && lastParamTypes.every((tp) => tp === "any");
    if (allAny) {
      count++;
    }
  }

  // Check for broad overloads in methods
  for (const method of decl.methods ?? []) {
    if ((method.overloadCount ?? 0) > 0) {
      const lastParamTypes = method.paramTypeNodes.map((pt) => pt.typeNode?.getText() ?? "");
      const allAny = lastParamTypes.length > 0 && lastParamTypes.every((tp) => tp === "any");
      if (allAny) {
        count++;
      }
    }

    // Check method return for any
    count += countMethodAnyReturns(decl, method, issues);
  }

  return count;
}

/** Count method return positions that resolve to `any`. */
function countMethodAnyReturns(
  decl: SurfaceDeclaration,
  method: SurfaceMethod,
  issues: Issue[],
): number {
  let count = 0;
  const returnPositions = method.positions.filter((pos) => pos.role === "return");
  for (const pos of returnPositions) {
    if (pos.type.getFlags() & TypeFlags.Any) {
      count++;
      issues.push({
        column: pos.column,
        dimension: CONFIG.label,
        file: pos.filePath,
        line: pos.line,
        message: `${decl.name}.${method.name}() returns 'any', erasing specialization potential`,
        severity: "warning",
      });
    }
  }
  return count;
}

// =====================================================================
// Per-declaration-kind analyzers
// =====================================================================

interface AnalyzeDeclOpts {
  decl: SurfaceDeclaration;
  issues: Issue[];
  penalties: PenaltyAccumulator;
  signals: SignalAccumulator;
}

function analyzeFunctionDecl(opts: AnalyzeDeclOpts): void {
  const { decl, signals, penalties, issues } = opts;
  const typeParams = decl.typeParameters;
  const paramTypeNodes = decl.paramTypeNodes ?? [];
  const returnTypeNodeText = decl.returnTypeNode?.getText() ?? "";

  // Signal 1: Route param extraction
  signals.routeParamExtraction += detectRouteParamExtraction(
    typeParams,
    paramTypeNodes,
    returnTypeNodeText,
  );

  // Signal 2: Search param propagation
  signals.searchParamPropagation += detectSearchParamPropagation(
    typeParams,
    paramTypeNodes,
    returnTypeNodeText,
  );

  // Signal 3: Loader/action result propagation
  signals.loaderActionPropagation += detectLoaderActionPropagation({
    declName: decl.name,
    paramTypeNodes,
    returnTypeNodeText,
    typeParams,
  });

  // Signal 4: Schema decode/parse specialization
  signals.schemaDecodeSpecialization += detectSchemaDecodeSpecialization(decl, [
    {
      name: decl.name,
      paramTypeNodes,
      positions: decl.positions,
      returnTypeNodeText,
      typeParameters: typeParams,
    },
  ]);

  // Signal 6: Result/effect channel propagation
  signals.resultChannelPropagation += detectResultChannelPropagation(decl);

  // Signal 8: Consumer-instantiated generic narrowing
  signals.consumerGenericNarrowing += detectConsumerGenericNarrowing(
    typeParams,
    paramTypeNodes,
    returnTypeNodeText,
  );

  // Penalties
  penalties.unconstrainedBroad += detectUnconstrainedBroadGenerics(
    typeParams,
    paramTypeNodes,
    returnTypeNodeText,
  );
  penalties.escapeHatch += detectEscapeHatches(decl, issues);
}

function analyzeInterfaceDecl(opts: AnalyzeDeclOpts): void {
  const { decl, signals, penalties, issues } = opts;
  const methods = decl.methods ?? [];

  // Signal 5: Query builder row-shape narrowing (on interface methods)
  signals.queryBuilderNarrowing += detectQueryBuilderNarrowing(methods, decl.typeParameters);

  // Signal 6: Result/effect channel propagation
  signals.resultChannelPropagation += detectResultChannelPropagation(decl);

  // Signal 7: Key-preserving transform
  signals.keyPreservingTransform += detectKeyPreservingTransform(decl);

  // Analyze each method for other signals
  for (const method of methods) {
    const methodTypeParams = [...method.typeParameters, ...decl.typeParameters];
    const returnTypeNodeText = method.returnTypeNode?.getText() ?? "";

    // Signal 1: Route param extraction in methods
    signals.routeParamExtraction += detectRouteParamExtraction(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );

    // Signal 2: Search param propagation in methods
    signals.searchParamPropagation += detectSearchParamPropagation(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );

    // Signal 3: Loader/action propagation in methods
    signals.loaderActionPropagation += detectLoaderActionPropagation({
      declName: method.name,
      paramTypeNodes: method.paramTypeNodes,
      returnTypeNodeText,
      typeParams: methodTypeParams,
    });

    // Signal 4: Schema decode/parse in methods
    signals.schemaDecodeSpecialization += detectSchemaDecodeSpecialization(decl, [
      {
        name: method.name,
        paramTypeNodes: method.paramTypeNodes,
        positions: method.positions,
        returnTypeNodeText,
        typeParameters: methodTypeParams,
      },
    ]);

    // Signal 8: Consumer-instantiated generic narrowing in methods
    signals.consumerGenericNarrowing += detectConsumerGenericNarrowing(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );
  }

  // Penalties
  penalties.helperChainErase += detectHelperChainErasure(methods);
  penalties.escapeHatch += detectEscapeHatches(decl, issues);
}

function analyzeTypeAliasDecl(
  decl: SurfaceDeclaration,
  signals: SignalAccumulator,
  _penalties: PenaltyAccumulator,
): void {
  // Signal 6: Result/effect channel propagation
  signals.resultChannelPropagation += detectResultChannelPropagation(decl);

  // Signal 7: Key-preserving transform
  signals.keyPreservingTransform += detectKeyPreservingTransform(decl);

  // Signal 8: Consumer-instantiated generic narrowing
  // For type aliases, check if the body uses constrained generics well
  if (decl.typeParameters.length > 0 && decl.bodyTypeNode) {
    const bodyText = decl.bodyTypeNode.getText();
    for (const tp of decl.typeParameters) {
      const constraintText = tp.constraintNode?.getText() ?? "";
      const isStructuralConstraint =
        constraintText.startsWith("{") ||
        (constraintText.length > 0 &&
          constraintText !== "string" &&
          constraintText !== "number" &&
          constraintText !== "boolean" &&
          constraintText !== "any" &&
          constraintText !== "unknown" &&
          constraintText !== "object" &&
          /^[A-Z]/.test(constraintText));

      // If the generic has a structural constraint and appears in a
      // Conditional type or mapped type in the body, it narrows well
      const bodyUsesGeneric = bodyText.includes(tp.name);
      const hasConditional = bodyText.includes("extends") && bodyText.includes("?");
      const hasMapped = /\[\s*\w+\s+in\s/.test(bodyText);

      if (isStructuralConstraint && bodyUsesGeneric && (hasConditional || hasMapped)) {
        signals.consumerGenericNarrowing++;
      }
    }
  }
}

function analyzeClassDecl(opts: AnalyzeDeclOpts): void {
  const { decl, signals, penalties, issues } = opts;
  const methods = decl.methods ?? [];

  // Signal 5: Query builder row-shape narrowing (on class methods)
  signals.queryBuilderNarrowing += detectQueryBuilderNarrowing(methods, decl.typeParameters);

  // Signal 6: Result/effect channel propagation
  signals.resultChannelPropagation += detectResultChannelPropagation(decl);

  // Signal 7: Key-preserving transform
  signals.keyPreservingTransform += detectKeyPreservingTransform(decl);

  // Analyze each method for signals
  for (const method of methods) {
    const methodTypeParams = [...method.typeParameters, ...decl.typeParameters];
    const returnTypeNodeText = method.returnTypeNode?.getText() ?? "";

    // Signal 1: Route param extraction
    signals.routeParamExtraction += detectRouteParamExtraction(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );

    // Signal 2: Search param propagation
    signals.searchParamPropagation += detectSearchParamPropagation(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );

    // Signal 3: Loader/action propagation
    signals.loaderActionPropagation += detectLoaderActionPropagation({
      declName: method.name,
      paramTypeNodes: method.paramTypeNodes,
      returnTypeNodeText,
      typeParams: methodTypeParams,
    });

    // Signal 4: Schema decode/parse
    signals.schemaDecodeSpecialization += detectSchemaDecodeSpecialization(decl, [
      {
        name: method.name,
        paramTypeNodes: method.paramTypeNodes,
        positions: method.positions,
        returnTypeNodeText,
        typeParameters: methodTypeParams,
      },
    ]);

    // Signal 8: Consumer-instantiated generic narrowing
    signals.consumerGenericNarrowing += detectConsumerGenericNarrowing(
      methodTypeParams,
      method.paramTypeNodes,
      returnTypeNodeText,
    );
  }

  // Penalties
  penalties.helperChainErase += detectHelperChainErasure(methods);
  penalties.escapeHatch += detectEscapeHatches(decl, issues);
}

function analyzeVariableDecl(
  decl: SurfaceDeclaration,
  signals: SignalAccumulator,
  penalties: PenaltyAccumulator,
): void {
  // Variables rarely have specialization power, but check for exported
  // Objects with Result/Effect patterns or call signatures
  for (const pos of decl.positions) {
    const typeText = pos.type.getText();

    // Check for escape hatches in variable types
    if (pos.type.getFlags() & TypeFlags.Any) {
      penalties.escapeHatch++;
    }

    // Check for Result/Effect type patterns in variable type
    if (RESULT_EFFECT_PATTERNS.some((pat) => pat.test(typeText))) {
      signals.resultChannelPropagation++;
    }
  }
}
