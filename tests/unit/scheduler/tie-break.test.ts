import { createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, observeTarget } from "../../helpers/createTestWorld.js";

const scheduler = createScenarioScheduler();

describe("scheduler tie-break", () => {
  it("keeps the current state when it is still the highest eligible state", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Follow";
      w.previousState = "Idle";
      observeTarget(w);
    });
    const result = scheduler.select(world, createTestScenario());
    expect(result.state).toBe("Follow");
    expect(result.interrupt).toBe(false);
    expect(result.reason).toBe("follow-target-acquired");
  });

  it("keeps Idle when Idle is current and no higher state is eligible", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Idle";
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["inventory", "perception"] }),
    );
    expect(result.state).toBe("Idle");
    expect(result.interrupt).toBe(false);
  });

  it("does not keep a lower-priority current state when a higher one is eligible", () => {
    const world = createTestWorld((w) => {
      w.selectedState = "Idle";
      observeTarget(w);
    });
    const result = scheduler.select(world, createTestScenario());
    expect(result.state).toBe("Follow");
    expect(result.interrupt).toBe(true);
  });
});
