import { followDirection, screenCenter, vectorToTarget } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("follow direction math", () => {
  it("computes the screen-center to target vector and a click when outside the band", () => {
    const center = screenCenter(1920, 1080);
    expect(center).toEqual({ x: 960, y: 540 });
    const target = { x: 1600, y: 200 };
    const { dx, dy, distance } = vectorToTarget(center, target);
    expect(dx).toBe(640);
    expect(dy).toBe(-340);
    expect(distance).toBeCloseTo(Math.hypot(640, -340));

    const directed = followDirection({ target, maxFollowDistancePx: 140 });
    expect(directed.distance).toBeGreaterThan(140);
    expect(directed.actions).toEqual([{ type: "mouse-click", x: 1600, y: 200, button: "left" }]);
  });

  it("returns noop when the target is inside the follow band", () => {
    const directed = followDirection({
      target: { x: 1000, y: 560 },
      maxFollowDistancePx: 140,
    });
    expect(directed.distance).toBeLessThanOrEqual(140);
    expect(directed.actions).toEqual([{ type: "noop", reason: "inside-follow-band" }]);
  });

  it("returns noop at the exact screen center", () => {
    const directed = followDirection({ target: { x: 960, y: 540 } });
    expect(directed.distance).toBe(0);
    expect(directed.actions).toEqual([{ type: "noop", reason: "inside-follow-band" }]);
  });
});
