import {
  AGING_MAX_AGE_MS,
  createEmptyWorldState,
  createReplayArming,
  createStateEstimator,
  FRESH_MAX_AGE_MS,
  FrozenClock,
  type TargetCue,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const TARGET: TargetCue = { identity: "qa-target", screenPoint: { x: 4, y: 4 } };

describe("StateEstimator freshness buckets", () => {
  it("marks a just-observed target fresh", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const world = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: 1,
      capturedAtMs: 10_000,
      evidenceId: "e1",
      target: { value: TARGET, confidence: 0.9, observedAtMs: 10_000, freshness: "fresh" },
    });
    expect(world.target.freshness).toBe("fresh");
  });

  it("marks an omitted target aging then missing after the stale window", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const present = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: 1,
      capturedAtMs: 10_000,
      evidenceId: "e1",
      target: { value: TARGET, confidence: 0.9, observedAtMs: 10_000, freshness: "fresh" },
    });
    expect(present.target.freshness).toBe("fresh");

    clock.advance(FRESH_MAX_AGE_MS);
    const aging = estimator.estimate(present, { tickId: 2, capturedAtMs: clock.nowMs(), evidenceId: "e2" });
    expect(aging.target.freshness).toBe("aging");
    expect(aging.target.value?.identity).toBe("qa-target");

    clock.advance(AGING_MAX_AGE_MS - FRESH_MAX_AGE_MS);
    const missing = estimator.estimate(aging, { tickId: 3, capturedAtMs: clock.nowMs(), evidenceId: "e3" });
    expect(missing.target.freshness).toBe("missing");
    expect(missing.target.value).toBeNull();
  });
});
