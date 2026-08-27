import type { BotDecision } from "../input/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

export class IdleController implements Controller {
  readonly module = "orchestrator" as const;

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    return {
      module: this.module,
      state: "Idle",
      reason: "idle",
      confidence: 1,
      intendedActions: [{ type: "noop", reason: `idle:${scenario.id}` }],
      evidenceIds: world.ui.evidenceId ? [world.ui.evidenceId] : [],
    };
  }
}
