import { FrozenClock, TokenBucketRateLimiter } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("TokenBucketRateLimiter", () => {
  it("allows actionsPerMinute tokens and blocks the next", () => {
    const clock = new FrozenClock(0);
    const limiter = new TokenBucketRateLimiter(clock, 2);
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume(2)).toBe(false);
    expect(limiter.hasToken(2)).toBe(false);
  });

  it("refills after a minute on a frozen clock", () => {
    const clock = new FrozenClock(0);
    const limiter = new TokenBucketRateLimiter(clock, 1);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
    clock.advance(60_000);
    expect(limiter.tryConsume(1)).toBe(true);
  });
});
