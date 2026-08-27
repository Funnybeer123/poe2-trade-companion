import { createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import {
  createTestWorld,
  fillInventory,
  observeLoot,
  observeTarget,
  openTrade,
} from "../../helpers/createTestWorld.js";

const scheduler = createScenarioScheduler();
const scenario = createTestScenario();

describe("scheduler interrupts", () => {
  it("sets interrupt true when moving to a higher-priority state", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      w.previousState = "Idle";
      w.flags.emergencyStopLatched = true;
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("EmergencyStop");
    expect(result.interrupt).toBe(true);
    expect(result.reason).toBe("emergency-stop-latched");
  });

  it("does not interrupt when remaining in the same state", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      observeTarget(w);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("Follow");
    expect(result.interrupt).toBe(false);
  });

  it("does not interrupt when dropping to a lower-priority state", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "TradeSession";
      observeTarget(w);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("Follow");
    expect(result.interrupt).toBe(false);
  });

  it("interrupts Follow for InventoryFull", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      observeTarget(w);
      fillInventory(w);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("InventoryFull");
    expect(result.interrupt).toBe(true);
  });

  it("interrupts Follow for HighValueLoot", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      observeTarget(w);
      observeLoot(w, [{ id: "mirror", screenPoint: { x: 1, y: 1 }, score: 90 }]);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("HighValueLoot");
    expect(result.interrupt).toBe(true);
  });

  it("interrupts Follow for TradeSession", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      observeTarget(w);
      openTrade(w);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("TradeSession");
    expect(result.interrupt).toBe(true);
  });
});
