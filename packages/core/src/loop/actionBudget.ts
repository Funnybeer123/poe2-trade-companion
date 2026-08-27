import type { Clock } from "../clock.js";

export const ACTION_BUDGET_HOLD_REASON = "action-budget-exhausted";

export class ActionBudget {
  #tokens: number;
  #lastRefillMs: number;
  readonly #clock: Clock;

  constructor(clock: Clock, initialActionsPerMinute = 30) {
    this.#clock = clock;
    this.#tokens = Math.max(0, initialActionsPerMinute);
    this.#lastRefillMs = clock.nowMs();
  }

  refill(actionsPerMinute: number): void {
    const rate = Math.max(0, actionsPerMinute);
    const now = this.#clock.nowMs();
    const elapsedMs = Math.max(0, now - this.#lastRefillMs);
    if (rate <= 0) {
      this.#tokens = 0;
      this.#lastRefillMs = now;
      return;
    }
    this.#tokens = Math.min(rate, this.#tokens + (elapsedMs * rate) / 60_000);
    this.#lastRefillMs = now;
  }

  remaining(actionsPerMinute: number): number {
    this.refill(actionsPerMinute);
    return this.#tokens;
  }

  hasCapacity(actionsPerMinute: number): boolean {
    this.refill(actionsPerMinute);
    return this.#tokens >= 1;
  }

  tryConsume(actionsPerMinute: number, count = 1): boolean {
    this.refill(actionsPerMinute);
    if (this.#tokens < count) {
      return false;
    }
    this.#tokens -= count;
    return true;
  }
}

export function countableActions(actions: ReadonlyArray<{ type: string }>): number {
  return actions.filter((action) => action.type !== "noop" && action.type !== "wait").length;
}
