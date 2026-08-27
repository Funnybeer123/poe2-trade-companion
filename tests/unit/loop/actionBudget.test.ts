import { ActionBudget, ACTION_BUDGET_HOLD_REASON, FrozenClock, countableActions } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("ActionBudget", () => {
  it("exhausts at actionsPerMinute and refills after the window", () => {
    const clock = new FrozenClock(10_000);
    const budget = new ActionBudget(clock, 1);
    expect(budget.hasCapacity(1)).toBe(true);
    expect(budget.tryConsume(1)).toBe(true);
    expect(budget.hasCapacity(1)).toBe(false);
    expect(budget.tryConsume(1)).toBe(false);

    clock.advance(59_999);
    expect(budget.hasCapacity(1)).toBe(false);

    clock.advance(1);
    expect(budget.hasCapacity(1)).toBe(true);
    expect(budget.tryConsume(1)).toBe(true);
  });

  it("counts only game-affecting actions toward the budget", () => {
    expect(
      countableActions([
        { type: "noop" },
        { type: "wait" },
        { type: "mouse-click" },
        { type: "key-tap" },
      ]),
    ).toBe(2);
  });

  it("uses the documented hold reason", () => {
    expect(ACTION_BUDGET_HOLD_REASON).toBe("action-budget-exhausted");
  });
});
