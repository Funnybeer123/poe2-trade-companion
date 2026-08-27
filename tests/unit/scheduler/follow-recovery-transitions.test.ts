import { createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, observeTarget } from "../../helpers/createTestWorld.js";

const scheduler = createScenarioScheduler();

describe("follow recovery scheduler transitions", () => {
  it("selects Follow when the target is fresh", () => {
    const world = createTestWorld((next) => {
      observeTarget(next);
    });
    expect(scheduler.select(world, createTestScenario()).state).toBe("Follow");
  });

  it("selects RecoverTarget when the target is missing", () => {
    const world = createTestWorld((next) => {
      next.target = {
        value: null,
        confidence: 0,
        observedAtMs: 10_000,
        freshness: "missing",
      };
      next.stuck = {
        value: { isStuck: false, reason: "lost-target", lostTargetTicks: 2 },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    expect(scheduler.select(world, createTestScenario()).state).toBe("RecoverTarget");
  });

  it("selects SafetyHold with stuck-exhausted after follow.stuck maxAttempts", () => {
    const world = createTestWorld((next) => {
      observeTarget(next);
      next.selectedState = "Follow";
      next.stuck = {
        value: { isStuck: true, reason: "stuck-exhausted", ticks: 15 },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const result = scheduler.select(world, createTestScenario());
    expect(result.state).toBe("SafetyHold");
    expect(result.reason).toBe("stuck-exhausted");
  });

  it("selects Idle after lost-target recovery is exhausted", () => {
    const world = createTestWorld((next) => {
      next.target = {
        value: null,
        confidence: 0,
        observedAtMs: 10_000,
        freshness: "missing",
      };
      next.stuck = {
        value: { isStuck: false, reason: "lost-target-exhausted", lostTargetTicks: 9 },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const result = scheduler.select(
      world,
      createTestScenario({ enabledModules: ["follow", "recovery"] }),
    );
    expect(result.state).toBe("Idle");
  });

  it("selects EmergencyStop from a follow tick when the latch is set", () => {
    const world = createTestWorld((next) => {
      observeTarget(next);
      next.selectedState = "Follow";
      next.flags.emergencyStopLatched = true;
    });
    expect(scheduler.select(world, createTestScenario()).state).toBe("EmergencyStop");
  });
});
