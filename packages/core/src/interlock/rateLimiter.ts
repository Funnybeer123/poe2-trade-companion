import type { Clock } from "../clock.js";

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly clock: Clock,
    initialActionsPerMinute = 30,
  ) {
    this.tokens = Math.max(0, initialActionsPerMinute);
    this.lastRefillMs = clock.nowMs();
  }

  refill(actionsPerMinute: number): void {
    const rate = Math.max(0, actionsPerMinute);
    const now = this.clock.nowMs();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    if (rate <= 0) {
      this.tokens = 0;
      this.lastRefillMs = now;
      return;
    }
    this.tokens = Math.min(rate, this.tokens + (elapsedMs * rate) / 60_000);
    this.lastRefillMs = now;
  }

  hasToken(actionsPerMinute: number): boolean {
    this.refill(actionsPerMinute);
    return this.tokens >= 1;
  }

  tryConsume(actionsPerMinute: number): boolean {
    this.refill(actionsPerMinute);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
