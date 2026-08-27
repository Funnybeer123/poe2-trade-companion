import { createEmptyWorldState, createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld } from "../../helpers/createTestWorld.js";

const scheduler = createScenarioScheduler();

describe("scheduler missing observations", () => {
  it("does not throw on an empty world and holds for a missing process", () => {
    const world = createEmptyWorldState();
    expect(() => scheduler.select(world, createTestScenario())).not.toThrow();
    expect(scheduler.select(world, createTestScenario()).state).toBe("SafetyHold");
  });

  it("treats tradeRequested as an active trade even without a trade window observation", () => {
    const world = createTestWorld((w) => {
      w.flags.tradeRequested = true;
    });
    expect(scheduler.select(world, createTestScenario()).state).toBe("TradeSession");
  });

  it("falls through to Idle when the scenario is disabled and the process is allowlisted", () => {
    const world = createTestWorld();
    const result = scheduler.select(world, createTestScenario({ enabled: false }));
    expect(result.state).toBe("Idle");
  });
});
