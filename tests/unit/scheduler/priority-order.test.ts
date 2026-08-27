import { createScenarioScheduler, STATE_PRIORITY, type AutomationStateId } from "@poe2tc/core";
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

describe("STATE_PRIORITY", () => {
  it("uses the documented order (lower number wins)", () => {
    expect(STATE_PRIORITY).toEqual({
      EmergencyStop: 0,
      SafetyHold: 1,
      TradeSession: 2,
      InventoryFull: 3,
      HighValueLoot: 4,
      Listing: 5,
      StashSort: 6,
      LootPickup: 7,
      Follow: 8,
      RecoverTarget: 9,
      Idle: 10,
    });
  });

  it("assigns a unique priority to every state", () => {
    const values = Object.values(STATE_PRIORITY);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("scheduler priority order table", () => {
  it.each([
    {
      name: "EmergencyStop",
      expected: "EmergencyStop" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        world.flags.emergencyStopLatched = true;
        openTrade(world);
      },
    },
    {
      name: "SafetyHold",
      expected: "SafetyHold" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        world.process.value.allowlisted = false;
        observeTarget(world);
      },
    },
    {
      name: "TradeSession",
      expected: "TradeSession" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        openTrade(world);
        observeTarget(world);
        observeLoot(world, [
          { id: "a", screenPoint: { x: 1, y: 1 }, score: 90 },
        ]);
      },
    },
    {
      name: "InventoryFull",
      expected: "InventoryFull" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        fillInventory(world);
        observeTarget(world);
        observeLoot(world, [{ id: "a", screenPoint: { x: 1, y: 1 }, score: 40 }]);
      },
    },
    {
      name: "HighValueLoot",
      expected: "HighValueLoot" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        observeTarget(world);
        observeLoot(world, [{ id: "mirror", screenPoint: { x: 2, y: 2 }, score: 95 }]);
      },
    },
    {
      name: "Listing",
      expected: "Listing" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        world.flags.listingSessionActive = true;
        observeTarget(world);
      },
    },
    {
      name: "StashSort",
      expected: "StashSort" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        world.flags.stashSessionActive = true;
        observeTarget(world);
      },
    },
    {
      name: "LootPickup",
      expected: "LootPickup" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        observeTarget(world);
        observeLoot(world, [{ id: "orb", screenPoint: { x: 3, y: 3 }, score: 50 }]);
      },
    },
    {
      name: "Follow",
      expected: "Follow" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        observeTarget(world);
      },
    },
    {
      name: "RecoverTarget",
      expected: "RecoverTarget" satisfies AutomationStateId,
      patch: (world: ReturnType<typeof createTestWorld>) => {
        world.target = {
          value: null,
          confidence: 0,
          observedAtMs: 10_000,
          freshness: "missing",
        };
      },
    },
    {
      name: "Idle",
      expected: "Idle" satisfies AutomationStateId,
      patch: undefined,
      scenario: createTestScenario({
        enabledModules: ["inventory", "perception"],
      }),
    },
  ])("selects $name when that state's predicate is the highest eligible", ({ expected, patch, scenario }) => {
    const world = createTestWorld(patch);
    const result = scheduler.select(world, scenario ?? createTestScenario());
    expect(result.state).toBe(expected);
  });
});
