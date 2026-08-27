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

describe("disabled modules", () => {
  it("cannot select Follow when the follow module is disabled", () => {
    const world = createTestWorld((w) => {
      observeTarget(w);
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["loot", "inventory", "perception"] }),
    );
    expect(result.state).toBe("Idle");
    expect(result.state).not.toBe("Follow");
    expect(result.state).not.toBe("RecoverTarget");
  });

  it("cannot select LootPickup or HighValueLoot when loot is disabled", () => {
    const world = createTestWorld((w) => {
      observeLoot(w, [{ id: "mirror", screenPoint: { x: 1, y: 1 }, score: 99 }]);
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["follow", "inventory", "perception"] }),
    );
    expect(result.state).toBe("RecoverTarget");
    expect(result.state).not.toBe("LootPickup");
    expect(result.state).not.toBe("HighValueLoot");
  });

  it("cannot select TradeSession when trade is disabled", () => {
    const world = createTestWorld((w) => {
      openTrade(w);
      observeTarget(w);
    });
    const result = scheduler.select(
      world,
      createTestScenario({
        enabledModules: ["follow", "loot", "inventory", "stash", "perception"],
      }),
    );
    expect(result.state).toBe("Follow");
    expect(result.state).not.toBe("TradeSession");
  });

  it("cannot select InventoryFull when stash is disabled", () => {
    const world = createTestWorld((w) => {
      fillInventory(w);
      observeTarget(w);
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["follow", "loot", "inventory", "perception"] }),
    );
    expect(result.state).toBe("Follow");
    expect(result.state).not.toBe("InventoryFull");
  });

  it("cannot select a disabled-module state even if its world flags are set", () => {
    const world = createTestWorld((w) => {
      w.flags.listingSessionActive = true;
      w.flags.stashSessionActive = true;
      observeTarget(w);
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["follow", "perception"] }),
    );
    expect(result.state).toBe("Follow");
    expect(result.state).not.toBe("Listing");
    expect(result.state).not.toBe("StashSort");
  });
});
