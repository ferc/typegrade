import { CLI_BUILDER_PACK, CLI_PACK, CLI_PARSER_PACK } from "./cli-pack.js";
import { ROUTER_CLIENT_PACK, ROUTER_PACK, ROUTER_SERVER_PACK } from "./router-pack.js";
import {
  TESTING_HTTP_PACK,
  TESTING_LIBRARY_PACK,
  TESTING_PACK,
  TESTING_RUNNER_PACK,
} from "./testing-pack.js";
import {
  VALIDATION_DECODER_PACK,
  VALIDATION_PACK,
  VALIDATION_SCHEMA_PACK,
} from "./validation-pack.js";
import type { DomainKey } from "../types.js";
import { ORM_PACK } from "./orm-pack.js";
import type { PublicSurface } from "../surface/index.js";
import { RESULT_PACK } from "./result-pack.js";
import { SCHEMA_PACK } from "./schema-pack.js";
import { STATE_PACK } from "./state-pack.js";
import { STREAM_PACK } from "./stream-pack.js";
import type { ScenarioPack } from "./types.js";

export { evaluateScenarioPack, isScenarioApplicable } from "./types.js";
export type { ScenarioPack, ScenarioTest } from "./types.js";
export {
  compileBackedResult,
  generateBasicCompileTests,
  runCompileTests,
  scoreCompileResults,
} from "./compile-check.js";
export type { CompileBackedResultOpts, CompileTest, CompileTestResult } from "./compile-check.js";

const SCENARIO_PACKS: Record<string, ScenarioPack> = {
  cli: CLI_PACK,
  orm: ORM_PACK,
  result: RESULT_PACK,
  router: ROUTER_PACK,
  schema: SCHEMA_PACK,
  state: STATE_PACK,
  stream: STREAM_PACK,
  testing: TESTING_PACK,
  validation: VALIDATION_PACK,
};

/** Variant packs keyed by domain -> variant name -> pack */
const VARIANT_PACKS: Record<string, ScenarioPack[]> = {
  cli: [CLI_BUILDER_PACK, CLI_PARSER_PACK],
  router: [ROUTER_SERVER_PACK, ROUTER_CLIENT_PACK],
  testing: [TESTING_LIBRARY_PACK, TESTING_HTTP_PACK, TESTING_RUNNER_PACK],
  validation: [VALIDATION_SCHEMA_PACK, VALIDATION_DECODER_PACK],
};

/** Get a scenario pack by domain key */
export function getScenarioPack(domain: DomainKey): ScenarioPack | undefined {
  return SCENARIO_PACKS[domain];
}

/**
 * Get the best scenario pack variant for a domain, given the surface.
 * Tries each variant's applicability check and returns the first applicable one.
 * Falls back to the base pack if no variant is applicable.
 */
export function getScenarioPackWithVariant(
  domain: DomainKey,
  surface: PublicSurface,
  packageName?: string,
): ScenarioPack | undefined {
  const variants = VARIANT_PACKS[domain];
  if (variants) {
    for (const variant of variants) {
      if (!variant.isApplicable) {
        continue;
      }
      const check = variant.isApplicable(surface, packageName);
      if (check.applicable) {
        return variant;
      }
    }
  }
  // Fall back to base pack
  return SCENARIO_PACKS[domain];
}

/** Get all available scenario packs */
export function getAllScenarioPacks(): ScenarioPack[] {
  return Object.values(SCENARIO_PACKS);
}
