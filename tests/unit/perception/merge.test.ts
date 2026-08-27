import {
  AGING_MAX_AGE_MS,
  createEmptyWorldState,
  createReplayArming,
  createStateEstimator,
  FRESH_MAX_AGE_MS,
  FrozenClock,
  type Observation,
  type TargetCue,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const TARGET_A: TargetCue = { identity: "alpha", screenPoint: { x: 10, y: 10 } };
const TARGET_B: TargetCue = { identity: "bravo", screenPoint: { x: 20, y: 20 } };

function targetObs(
  value: TargetCue | null,
  confidence: number,
  observedAtMs: number,
): Observation<TargetCue | null> {
  return { value, confidence, observedAtMs, freshness: "fresh" };
}

function frame(tickId: number, capturedAtMs: number, target?: Observation<TargetCue | null>) {
  return {
    tickId,
    capturedAtMs,
    evidenceId: `e${String(tickId)}`,
    target,
  };
}

describe("StateEstimator merge rules", () => {
  it("replaces when the newer observation has confidence >= prev", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const prev = estimator.estimate(createEmptyWorldState({ clock }), frame(1, 10_000, targetObs(TARGET_A, 0.5, 10_000)));
    const next = estimator.estimate(prev, frame(2, 10_000, targetObs(TARGET_B, 0.5, 10_000)));
    expect(next.target.value?.identity).toBe("bravo");
    expect(next.target.confidence).toBe(0.5);
  });

  it("keeps prev when a lower-confidence newer observation arrives while prev is fresh", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const prev = estimator.estimate(
      createEmptyWorldState({ clock }),
      frame(1, 10_000, targetObs(TARGET_A, 0.9, 10_000)),
    );
    clock.advance(FRESH_MAX_AGE_MS - 1);
    const next = estimator.estimate(prev, frame(2, clock.nowMs(), targetObs(TARGET_B, 0.2, clock.nowMs())));
    expect(next.target.value?.identity).toBe("alpha");
    expect(next.target.confidence).toBe(0.9);
    expect(next.target.freshness).toBe("fresh");
  });

  it("keeps prev when a lower-confidence newer observation arrives while prev is aging", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const prev = estimator.estimate(
      createEmptyWorldState({ clock }),
      frame(1, 10_000, targetObs(TARGET_A, 0.9, 10_000)),
    );
    clock.advance(FRESH_MAX_AGE_MS);
    const next = estimator.estimate(prev, frame(2, clock.nowMs(), targetObs(TARGET_B, 0.1, clock.nowMs())));
    expect(next.target.value?.identity).toBe("alpha");
    expect(next.target.freshness).toBe("aging");
  });

  it("replaces a lower-confidence newer observation when prev is stale", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const prev = estimator.estimate(
      createEmptyWorldState({ clock }),
      frame(1, 10_000, targetObs(TARGET_A, 0.9, 10_000)),
    );
    clock.advance(AGING_MAX_AGE_MS);
    const next = estimator.estimate(prev, frame(2, clock.nowMs(), targetObs(TARGET_B, 0.2, clock.nowMs())));
    expect(next.target.value?.identity).toBe("bravo");
    expect(next.target.confidence).toBe(0.2);
    expect(next.target.freshness).toBe("fresh");
  });

  it("replaces a lower-confidence newer observation when prev is missing", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const next = estimator.estimate(
      createEmptyWorldState({ clock }),
      frame(1, 10_000, targetObs(TARGET_B, 0.1, 10_000)),
    );
    expect(next.target.value?.identity).toBe("bravo");
  });

  it("recomputes freshness from the clock when keeping the previous observation", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const prev = estimator.estimate(
      createEmptyWorldState({ clock }),
      frame(1, 10_000, targetObs(TARGET_A, 0.9, 10_000)),
    );
    expect(prev.target.freshness).toBe("fresh");
    clock.advance(FRESH_MAX_AGE_MS);
    const next = estimator.estimate(prev, frame(2, clock.nowMs(), targetObs(TARGET_B, 0.1, clock.nowMs())));
    expect(next.target.value?.identity).toBe("alpha");
    expect(next.target.freshness).toBe("aging");
  });
});
