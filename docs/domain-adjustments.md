# Domain Adjustments

tsguard detects the domain of a package and adjusts scoring accordingly. This document describes the detection mechanism, supported domains, and suppression behavior.

## Supported Domains

| Domain | Examples | Detection Method |
|--------|----------|-----------------|
| validation | zod, valibot, arktype, io-ts, yup, joi | Package name match, unknown-param density |
| result | neverthrow, effect, fp-ts, purify-ts | Package name match, Result/Either/Ok/Err type aliases |
| router | express, fastify, hono, koa, react-router | Package name match, route/handler/middleware declarations |
| orm | drizzle-orm, prisma, typeorm, sequelize | Package name match, model/schema/column/table declarations |
| schema | type-fest, ts-toolbelt, utility-types | Package name match, >60% type alias declarations |
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
   - Schema: if >60% of declarations are type aliases → +0.3

3. **Threshold:** a domain wins if its score ≥ 0.5. Otherwise falls back to "utility" (if >50% type aliases) or "general".

## Suppressions

When a domain is detected, certain scoring adjustments are suppressed to avoid false positives:

### Validation Domain
- `unknown` parameter warnings in `apiSafety` are suppressed for function params
- **Rationale:** validation libraries intentionally accept `unknown` — that's their purpose
- Recorded as: `"unknown-param warnings suppressed for validation library"`

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
    ]
  }
}
```

## Disabling Domain Detection

Domain detection is automatic. To analyze without domain adjustments, the package name should not be provided to the analyzer (source mode without package context).

In package mode via `tsguard score <pkg>`, the package name is always available and domain detection always runs.
