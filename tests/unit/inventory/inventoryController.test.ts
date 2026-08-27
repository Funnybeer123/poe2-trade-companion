import {
  InventoryController,
  SHADOW_MISMATCH_REASON,
  SKIP_INVENTORY_FULL,
  applyPostDecisionEffects,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, fillInventory } from "../../helpers/createTestWorld.js";

describe("InventoryController", () => {
  it("sets stashSessionActive when inventory is full and emits no transfers", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "InventoryFull";
      fillInventory(next);
    });
    const decision = new InventoryController().decide(world, createTestScenario());
    expect(decision.module).toBe("inventory");
    expect(decision.state).toBe("InventoryFull");
    expect(decision.reason).toBe(SKIP_INVENTORY_FULL);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: SKIP_INVENTORY_FULL }]);
    expect(decision.intendedActions.some((action) => action.type === "mouse-drag")).toBe(false);

    const next = applyPostDecisionEffects(world, decision, 10_000);
    expect(next.flags.stashSessionActive).toBe(true);
  });

  it("traces shadow-mismatch without inventing items or sending transfers", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "InventoryFull";
      fillInventory(next);
      next.flags.shadowMismatch = true;
    });
    const decision = new InventoryController().decide(world, createTestScenario());
    expect(decision.reason).toBe(SHADOW_MISMATCH_REASON);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: SHADOW_MISMATCH_REASON }]);
    expect(world.inventory.value.cells).toEqual([]);
  });

  it("reports inventory-observed when the grid is not full", () => {
    const world = createTestWorld();
    const decision = new InventoryController().decide(world, createTestScenario());
    expect(decision.reason).toBe("inventory-observed");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "inventory-not-full" }]);
  });
});
