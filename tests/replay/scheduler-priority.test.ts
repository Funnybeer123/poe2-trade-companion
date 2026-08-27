import { createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { loadSchedulerPriorityFixtures } from "../helpers/schedulerPriorityFixtures.js";

const scheduler = createScenarioScheduler();

describe("scheduler-priority replay", () => {
  it("replays eight JSON snapshots through the live ScenarioScheduler", () => {
    const fixtures = loadSchedulerPriorityFixtures();
    expect(fixtures).toHaveLength(8);

    const selected = fixtures.map((fixture) => {
      const result = scheduler.select(fixture.world, fixture.scenario);
      expect(result.state).toBe(fixture.expect.state);
      if (fixture.expect.interrupt !== undefined) {
        expect(result.interrupt).toBe(fixture.expect.interrupt);
      }
      return result.state;
    });

    expect(selected).toEqual([
      "EmergencyStop",
      "SafetyHold",
      "TradeSession",
      "InventoryFull",
      "HighValueLoot",
      "TradeSession",
      "Follow",
      "Idle",
    ]);
  });
});
