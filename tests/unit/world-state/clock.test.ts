import { createEmptyWorldState, FrozenClock, SystemClock } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("Clock", () => {
  it("FrozenClock returns a fixed time until advance", () => {
    const clock = new FrozenClock(42);
    expect(clock.nowMs()).toBe(42);
    expect(clock.nowMs()).toBe(42);
    clock.advance(8);
    expect(clock.nowMs()).toBe(50);
  });

  it("createEmptyWorldState stamps clockMs from the injected clock", () => {
    const clock = new FrozenClock(7_777);
    const world = createEmptyWorldState({ clock });
    expect(world.clockMs).toBe(7_777);
    expect(world.capturedAtMs).toBe(7_777);
    expect(world.selectedState).toBe("Idle");
    expect(world.flags.emergencyStopLatched).toBe(false);
    expect(world.flags.highValueInterruptScore).toBe(85);
    expect(world.process.freshness).toBe("missing");
    expect(world.process.value.allowlisted).toBe(false);
  });

  it("SystemClock returns a finite timestamp", () => {
    const now = new SystemClock().nowMs();
    expect(Number.isFinite(now)).toBe(true);
    expect(now).toBeGreaterThan(0);
  });
});
