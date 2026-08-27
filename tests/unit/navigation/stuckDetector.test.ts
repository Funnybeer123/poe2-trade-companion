import { detectStuck, stuckRecoveryAttempt } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("stuck detector", () => {
  it("does not count the first observation as stuck", () => {
    const first = detectStuck({
      currentPoint: { x: 1600, y: 200 },
      prevNoProgressTicks: 0,
      stuckTicks: 12,
    });
    expect(first).toEqual({ noProgressTicks: 0, isStuck: false, progressed: false });
  });

  it("increments no-progress ticks when the point does not move", () => {
    const point = { x: 1600, y: 200 };
    let ticks = 0;
    let stuck = false;
    for (let i = 0; i < 12; i += 1) {
      const result = detectStuck({
        prevPoint: point,
        currentPoint: point,
        prevNoProgressTicks: ticks,
        stuckTicks: 12,
      });
      ticks = result.noProgressTicks;
      stuck = result.isStuck;
    }
    expect(ticks).toBe(12);
    expect(stuck).toBe(true);
    expect(stuckRecoveryAttempt(ticks, 12)).toBe(1);
  });

  it("resets when the target moves far enough", () => {
    const afterStuck = detectStuck({
      prevPoint: { x: 1600, y: 200 },
      currentPoint: { x: 1400, y: 400 },
      prevNoProgressTicks: 11,
      stuckTicks: 12,
    });
    expect(afterStuck.progressed).toBe(true);
    expect(afterStuck.noProgressTicks).toBe(0);
    expect(afterStuck.isStuck).toBe(false);
  });

  it("resets when the current point is missing", () => {
    const result = detectStuck({
      prevPoint: { x: 1600, y: 200 },
      prevNoProgressTicks: 9,
      stuckTicks: 12,
    });
    expect(result.noProgressTicks).toBe(0);
    expect(result.isStuck).toBe(false);
  });
});
