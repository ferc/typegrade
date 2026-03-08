# Domain Adjustments

typegrade detects the domain of a package and adjusts scoring accordingly. This document describes the detection mechanism, supported domains, and suppression behavior.

## Supported Domains

| Domain | Examples | Detection Method |
|--------|----------|-----------------|
| validation | zod, valibot, arktype, io-ts, yup, joi | Package name match, unknown-param density |
| result | neverthrow, effect, fp-ts, purify-ts | Package name match, Result/Either/Ok/Err type aliases |
| router | express, fastify, hono, koa, react-router | Package name match, route/handler/middleware declarations |
| orm | drizzle-orm, prisma, typeorm, sequelize | Package name match, model/schema/column/table declarations |
| schema | type-fest, ts-toolbelt, utility-types | Package name match, >60% type alias declarations, >5 generic type aliases |
| stream | rxjs, xstate, most, callbag, @most/core | Package name match, observable/subject/stream/subscription declarations |
| frontend | react, preact, vue, svelte, solid-js | Package name match |
| utility | (fallback) | >50% type alias declarations, no other domain match |
| general | (default) | No domain detected |

## Detection Algorithm

1. **Package name matching** — if the package name matches a known library in `DOMAIN_PATTERNS`, add 0.6 to that domain's score.

2. **Declaration pattern matching:**
   - Validation: count functions with `unknown` params; if >30% → +0.3
   - Result: count type aliases named Result/Either/Ok/Err → +0.3 each
   - Router: count declarations matching route/handler/middleware/request/response/router/endpoint → if ≥3: `+min(0.6, 0.2 + count × 0.1)`
   - ORM: count declarations matching model/schema/column/migration/query/table/entity → if ≥3: `+min(0.6, 0.2 + count × 0.1)`
   - Stream: count declarations matching observable/subject/stream/subscription/pipe/operator/subscriber → if ≥3: `+min(0.6, 0.2 + count × 0.1)`
   - Schema: if >60% of declarations are type aliases → +0.3

3. **Multi-signal inference:**
   - Generic pattern detection: if >30% of functions have ≥2 generic type parameters → +0.2 to schema and utility
   - Public API role detection: if >5 generic type aliases → +0.2 to schema

4. **Threshold:** a domain wins if its score ≥ 0.5. Otherwise falls back to "utility" (if >50% type aliases) or "general".

## Domain Adjustments

When a domain is detected, specific adjustments are recorded and applied:

### Validation Domain
- **Suppression:** `unknown` parameter warnings in `apiSafety` are suppressed
- **Rationale:** validation libraries intentionally accept `unknown` — that's their purpose
- **Adjustment:** `{ dimension: "apiSafety", adjustment: "suppress unknown-param warnings", reason: "Validation libraries intentionally accept unknown inputs" }`

### Stream Domain
- **Adjustment:** `{ dimension: "surfaceComplexity", adjustment: "accept higher-order generic signatures", reason: "Stream/reactive libraries require complex generic type compositions" }`

### Schema/Utility Domain
- **Adjustment:** `{ dimension: "apiSpecificity", adjustment: "expect high generic density", reason: "Schema/utility libraries are expected to use generics extensively" }`

## Output

Domain inference appears in the JSON output:
```json
{
  "domainInference": {
    "domain": "validation",
    "confidence": 0.9,
    "signals": [
      "package name matches validation library 'zod'",
      "3/4 functions accept 'unknown' params"
    ],
    "suppressedIssues": [
      "unknown-param warnings suppressed for validation library"
    ],
    "adjustments": [
      {
        "dimension": "apiSafety",
        "adjustment": "suppress unknown-param warnings",
        "reason": "Validation libraries intentionally accept unknown inputs"
      }
    ]
  }
}
```

## Disabling Domain Detection

Domain detection is automatic. To analyze without domain adjustments, the package name should not be provided to the analyzer (source mode without package context).

In package mode via `typegrade score <pkg>`, the package name is always available and domain detection always runs.
