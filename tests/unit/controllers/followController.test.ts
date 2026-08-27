import { FollowController, IdleController, RecoveryController } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, observeTarget } from "../../helpers/createTestWorld.js";

describe("FollowController", () => {
  it("records a mouse-click toward a derived target point outside the band", () => {
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

  it("returns noop when the target is inside the follow band", () => {
    const world = createTestWorld((next) => {
      observeTarget(next, 0.92);
      if (next.target.value) {
        next.target.value.screenPoint = { x: 960, y: 540 };
      }
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.reason).toBe("follow-target");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "inside-follow-band" }]);
  });

  it("returns noop when selected without a screen point", () => {
    const world = createTestWorld((next) => {
      next.target = {
        value: { identity: "qa-target" },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "follow-no-point" }]);
  });

  it("emits stuck-recovery while the stuck detector is latched", () => {
    const world = createTestWorld((next) => {
      observeTarget(next, 0.92);
      next.stuck = {
        value: { isStuck: true, reason: "no-progress", ticks: 12 },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.reason).toBe("stuck-recovery");
    expect(decision.recoveryOf).toBe("follow.stuck");
    expect(decision.retryIndex).toBe(1);
    expect(decision.intendedActions[0]?.type).toBe("mouse-click");
  });

  it("stops generated follow input on emergency stop", () => {
    const world = createTestWorld((next) => {
      observeTarget(next, 0.92);
      next.flags.emergencyStopLatched = true;
    });
    const decision = new FollowController().decide(world, createTestScenario());
    expect(decision.reason).toBe("emergency-stop");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
  });
});

describe("IdleController", () => {
  it("returns a noop decision", () => {
    const decision = new IdleController().decide(
      createTestWorld(),
      createTestScenario({ id: "follow-only" }),
    );
    expect(decision.state).toBe("Idle");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "idle:follow-only" }]);
  });
});

describe("RecoveryController", () => {
  it("emits a bounded lost-target scan click", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "RecoverTarget";
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
    const decision = new RecoveryController().decide(world, createTestScenario());
    expect(decision.reason).toBe("lost-target");
    expect(decision.recoveryOf).toBe("follow.lost-target");
    expect(decision.retryIndex).toBe(2);
    expect(decision.intendedActions[0]?.type).toBe("mouse-click");
  });

  it("stops scanning after maxAttempts so recovery terminates", () => {
    const controller = new RecoveryController();
    const scenario = createTestScenario();
    const clicks: number[] = [];
    for (let lostTargetTicks = 1; lostTargetTicks <= 20; lostTargetTicks += 1) {
      const world = createTestWorld((next) => {
        next.selectedState = "RecoverTarget";
        next.target = {
          value: null,
          confidence: 0,
          observedAtMs: 10_000,
          freshness: "missing",
        };
        next.stuck = {
          value: {
            isStuck: false,
            reason: lostTargetTicks > 8 ? "lost-target-exhausted" : "lost-target",
            lostTargetTicks,
          },
          confidence: 1,
          observedAtMs: 10_000,
          freshness: "fresh",
        };
      });
      const decision = controller.decide(world, scenario);
      clicks.push(decision.intendedActions.filter((action) => action.type === "mouse-click").length);
    }
    expect(clicks.filter((count) => count > 0)).toHaveLength(5);
    expect(clicks.slice(5).every((count) => count === 0)).toBe(true);
  });
});
