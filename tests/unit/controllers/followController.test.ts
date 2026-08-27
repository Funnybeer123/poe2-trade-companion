import { FollowController, IdleController } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, observeTarget } from "../../helpers/createTestWorld.js";

describe("Phase 04 controller placeholders", () => {
  it("FollowController records a mouse-click toward a derived target point", () => {
    const world = createTestWorld((next) => {
      observeTarget(next, 0.92);
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.module).toBe("follow");
    expect(decision.reason).toBe("follow-target");
    expect(decision.intendedActions).toEqual([
      { type: "mouse-click", x: 400, y: 300, button: "left" },
    ]);
  });

  it("FollowController returns noop when selected without a screen point", () => {
    const world = createTestWorld((next) => {
      next.target = {
        value: { identity: "qa-target" },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.intendedActions).toEqual([
      { type: "noop", reason: "follow-placeholder-no-point" },
    ]);
  });

  it("IdleController returns a noop decision", () => {
    const decision = new IdleController().decide(
      createTestWorld(),
      createTestScenario({ id: "follow-only" }),
    );
    expect(decision.state).toBe("Idle");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "idle:follow-only" }]);
  });
});
