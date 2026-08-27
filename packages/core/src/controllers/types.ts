import type { BotDecision } from "../input/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { ModuleId, WorldState } from "../world-state/types.js";

export interface Controller {
  readonly module: ModuleId;
  decide(world: WorldState, scenario: AutomationScenario): BotDecision;
}
