import { nextLostTargetTicks } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("lost-target tick count", () => {
  it("increments while the target is missing and resets when it returns", () => {
    let ticks = 0;
    ticks = nextLostTargetTicks(ticks, false);
    ticks = nextLostTargetTicks(ticks, false);
    ticks = nextLostTargetTicks(ticks, false);
    expect(ticks).toBe(3);
    ticks = nextLostTargetTicks(ticks, true);
    expect(ticks).toBe(0);
  });

  it("reaches the default lost-target threshold of 8", () => {
    let ticks = 0;
    for (let i = 0; i < 8; i += 1) {
      ticks = nextLostTargetTicks(ticks, false);
    }
    expect(ticks).toBe(8);
    ticks = nextLostTargetTicks(ticks, false);
    expect(ticks).toBe(9);
  });
});
