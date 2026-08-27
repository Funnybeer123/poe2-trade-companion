import { EmergencyStop } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("EmergencyStop latch", () => {
  it("trips and stays latched until explicit rearm", () => {
    const stop = new EmergencyStop();
    expect(stop.isLatched()).toBe(false);
    stop.trip();
    expect(stop.isLatched()).toBe(true);
    expect(() => stop.rearm({ explicit: true })).not.toThrow();
    expect(stop.isLatched()).toBe(false);
  });

  it("does not rearm without explicit: true", () => {
    const stop = new EmergencyStop();
    stop.trip();
    expect(() => stop.rearm({ explicit: false as unknown as true })).toThrow(/explicit/);
    expect(stop.isLatched()).toBe(true);
  });
});
