import { InventoryController, SKIP_INVENTORY_FULL, applyPostDecisionEffects } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, fillInventory, observeLoot } from "../../helpers/createTestWorld.js";

describe("InventoryController", () => {
  it("returns inventory-full and the loop stub sets stashSessionActive", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "InventoryFull";
      fillInventory(next);
      observeLoot(next, [{ id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } }]);
    });
    const decision = new InventoryController().decide(world, createTestScenario());
    expect(decision.module).toBe("inventory");
    expect(decision.state).toBe("InventoryFull");
    expect(decision.reason).toBe(SKIP_INVENTORY_FULL);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: SKIP_INVENTORY_FULL }]);

    const next = applyPostDecisionEffects(world, decision, 10_000);
    expect(next.flags.stashSessionActive).toBe(true);
  });
});
