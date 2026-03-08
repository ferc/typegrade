import type { DomainKey } from "../types.js";
import { ORM_PACK } from "./orm-pack.js";
import { RESULT_PACK } from "./result-pack.js";
import { ROUTER_PACK } from "./router-pack.js";
import { SCHEMA_PACK } from "./schema-pack.js";
import { STREAM_PACK } from "./stream-pack.js";
import type { ScenarioPack } from "./types.js";
import { VALIDATION_PACK } from "./validation-pack.js";

export { evaluateScenarioPack } from "./types.js";
export type { ScenarioPack, ScenarioTest } from "./types.js";

const SCENARIO_PACKS: Record<string, ScenarioPack> = {
  orm: ORM_PACK,
  result: RESULT_PACK,
  router: ROUTER_PACK,
  schema: SCHEMA_PACK,
  stream: STREAM_PACK,
  validation: VALIDATION_PACK,
};

/** Get a scenario pack by domain key */
export function getScenarioPack(domain: DomainKey): ScenarioPack | undefined {
  return SCENARIO_PACKS[domain];
}

/** Get all available scenario packs */
export function getAllScenarioPacks(): ScenarioPack[] {
  return Object.values(SCENARIO_PACKS);
}
