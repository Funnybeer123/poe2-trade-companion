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

describe("EmergencyStop vs trade", () => {
  it("selects EmergencyStop over an open trade window", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "TradeSession";
      w.flags.emergencyStopLatched = true;
      openTrade(w);
      observeTarget(w);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("EmergencyStop");
    expect(result.interrupt).toBe(true);
  });

  it("selects EmergencyStop over tradeRequested fixture flag", () => {
    const world = createTestWorld((w) => {
      w.flags.emergencyStopLatched = true;
      w.flags.tradeRequested = true;
    });
    expect(scheduler.select(world, scenario).state).toBe("EmergencyStop");
  });
});

describe("InventoryFull vs loot and follow", () => {
  it("selects InventoryFull over loot pickup and follow", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "LootPickup";
      fillInventory(w);
      observeTarget(w);
      observeLoot(w, [{ id: "orb", screenPoint: { x: 4, y: 4 }, score: 55 }]);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("InventoryFull");
    expect(result.interrupt).toBe(true);
  });
});

describe("HighValueLoot vs follow, not trade", () => {
  it("selects HighValueLoot over Follow", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      observeTarget(w);
      observeLoot(w, [{ id: "mirror", screenPoint: { x: 8, y: 8 }, score: 85 }]);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("HighValueLoot");
    expect(result.interrupt).toBe(true);
  });

  it("does not select HighValueLoot over TradeSession", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "HighValueLoot";
      openTrade(w);
      observeTarget(w);
      observeLoot(w, [{ id: "mirror", screenPoint: { x: 8, y: 8 }, score: 99 }]);
    });
    const result = scheduler.select(world, scenario);
    expect(result.state).toBe("TradeSession");
    expect(result.state).not.toBe("HighValueLoot");
    expect(result.interrupt).toBe(true);
  });
});
