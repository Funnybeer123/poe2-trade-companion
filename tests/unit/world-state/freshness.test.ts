import { AGING_MAX_AGE_MS, computeFreshness, FRESH_MAX_AGE_MS } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("computeFreshness", () => {
  it("returns missing when never observed", () => {
    expect(computeFreshness(undefined, 1_000)).toBe("missing");
    expect(computeFreshness(Number.NaN, 1_000)).toBe("missing");
  });

  it("returns fresh below 250ms", () => {
    expect(computeFreshness(1_000, 1_000)).toBe("fresh");
    expect(computeFreshness(1_000, 1_000 + FRESH_MAX_AGE_MS - 1)).toBe("fresh");
  });

  it("returns aging from 250ms inclusive and below 1000ms", () => {
    expect(computeFreshness(1_000, 1_000 + FRESH_MAX_AGE_MS)).toBe("aging");
    expect(computeFreshness(1_000, 1_000 + AGING_MAX_AGE_MS - 1)).toBe("aging");
  });

  it("returns stale at 1000ms and beyond", () => {
    expect(computeFreshness(1_000, 1_000 + AGING_MAX_AGE_MS)).toBe("stale");
    expect(computeFreshness(1_000, 10_000)).toBe("stale");
  });
});
