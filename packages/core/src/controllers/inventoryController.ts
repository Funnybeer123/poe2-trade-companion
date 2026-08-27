import type { BotDecision } from "../input/types.js";
import { SKIP_INVENTORY_FULL } from "../loot/skipReasons.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

export class InventoryController implements Controller {
  readonly module = "inventory" as const;

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    void scenario;
    if (world.flags.emergencyStopLatched) {
      return {
        module: this.module,
        state: "EmergencyStop",
        reason: "emergency-stop",
        confidence: 1,
        intendedActions: [{ type: "noop", reason: "emergency-stop" }],
        evidenceIds: world.inventory.evidenceId ? [world.inventory.evidenceId] : [],
      };
    }

    if (world.inventory.value.full) {
      return {
        module: this.module,
        state: "InventoryFull",
        reason: SKIP_INVENTORY_FULL,
        confidence: world.inventory.confidence,
        intendedActions: [{ type: "noop", reason: SKIP_INVENTORY_FULL }],
        evidenceIds: world.inventory.evidenceId ? [world.inventory.evidenceId] : [],
      };
    }

    return {
      module: this.module,
      state: world.selectedState,
      reason: "inventory-observed",
      confidence: world.inventory.confidence,
      intendedActions: [{ type: "noop", reason: "inventory-not-full" }],
      evidenceIds: world.inventory.evidenceId ? [world.inventory.evidenceId] : [],
    };
  }
}
