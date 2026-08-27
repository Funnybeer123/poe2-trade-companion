import {
  DEFAULT_RECOVERY,
  STASH_FAILED_MOVE_KEY,
  STASH_FAILED_OR_TIMED_OUT_REASON,
  STASH_FALLBACK_TAB_FULL_REASON,
  STASH_PLAN_EMPTY_REASON,
  STASH_WRONG_TAB_KEY,
  StashController,
  applyPostDecisionEffects,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createStashWorld, inventoryCells, stashCells } from "../../helpers/stashWorld.js";

describe("StashController", () => {
  it("emits a confirmed-plan drag for the highest-value item", () => {
    const world = createStashWorld((next) => {
      next.inventory = {
        value: {
          occupied: 2,
          capacity: 4,
          full: false,
          cells: inventoryCells([
            { x: 0, y: 0, fingerprint: "divine-1" },
            { x: 1, y: 0, fingerprint: "chaos-1" },
          ]),
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.stash = {
        value: { tabId: "currency", tabName: "Currency", cells: stashCells("currency"), tabFull: false },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.module).toBe("stash");
    expect(decision.reason).toContain("stash-move:divine-1");
    expect(decision.intendedActions[0]?.type).toBe("mouse-drag");
    const next = applyPostDecisionEffects(world, decision, 10_000);
    expect(next.flags.pendingStashTransfer?.fingerprint).toBe("divine-1");
    expect(next.flags.pendingStashTransfer?.kind).toBe("move");
  });

  it("clears stashSessionActive when the plan is empty and inventory is not full", () => {
    const world = createStashWorld((next) => {
      next.inventory = {
        value: { occupied: 0, capacity: 4, full: false, cells: inventoryCells([]) },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.stash = {
        value: { tabId: "currency", cells: stashCells("currency"), tabFull: false },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.reason).toBe(STASH_PLAN_EMPTY_REASON);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: STASH_PLAN_EMPTY_REASON }]);
    const next = applyPostDecisionEffects(world, decision, 10_000);
    expect(next.flags.stashSessionActive).toBe(false);
  });

  it("clicks the destination tab when the visible tab is wrong", () => {
    const world = createStashWorld((next) => {
      next.inventory = {
        value: {
          occupied: 1,
          capacity: 4,
          full: false,
          cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.stash = {
        value: { tabId: "dump", tabName: "Dump", cells: stashCells("dump"), tabFull: false },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.reason).toBe("stash-tab:currency");
    expect(decision.intendedActions[0]).toMatchObject({ type: "mouse-click", button: "left" });
  });

  it("retries a failed move at most three times then SafetyHold / FailedOrTimedOut", () => {
    const world = createStashWorld((next) => {
      next.clockMs = 20_000;
      next.inventory = {
        value: {
          occupied: 1,
          capacity: 4,
          full: false,
          cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
        },
        confidence: 0.95,
        observedAtMs: 20_000,
        freshness: "fresh",
      };
      next.stash = {
        value: { tabId: "currency", cells: stashCells("currency"), tabFull: false },
        confidence: 0.9,
        observedAtMs: 20_000,
        freshness: "fresh",
      };
      next.flags.pendingStashTransfer = {
        fingerprint: "divine-1",
        from: { kind: "inventory", x: 0, y: 0 },
        to: { kind: "stash", tabId: "currency", x: 0, y: 0 },
        kind: "move",
        attempts: 3,
        lastAttemptMs: 10_000,
        destTabId: "currency",
        reason: "HighValueSell:currency",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.state).toBe("SafetyHold");
    expect(decision.reason).toContain(STASH_FAILED_OR_TIMED_OUT_REASON);
    expect(decision.recoveryOf).toBe(STASH_FAILED_MOVE_KEY);
    expect(decision.retryIndex).toBe(3);
    expect(DEFAULT_RECOVERY["stash.failed-move"]?.maxAttempts).toBe(3);
    const next = applyPostDecisionEffects(world, decision, 20_000);
    expect(next.flags.stashSafetyHold).toBe(true);
    expect(next.flags.stashSessionActive).toBe(false);
  });

  it("retries a wrong tab at most three times", () => {
    const world = createStashWorld((next) => {
      next.clockMs = 20_000;
      next.inventory = {
        value: {
          occupied: 1,
          capacity: 4,
          full: false,
          cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
        },
        confidence: 0.95,
        observedAtMs: 20_000,
        freshness: "fresh",
      };
      next.stash = {
        value: { tabId: "dump", cells: stashCells("dump"), tabFull: false },
        confidence: 0.9,
        observedAtMs: 20_000,
        freshness: "fresh",
      };
      next.flags.pendingStashTransfer = {
        fingerprint: "divine-1",
        from: { kind: "inventory", x: 0, y: 0 },
        to: { kind: "stash", tabId: "currency", x: 0, y: 0 },
        kind: "tab-click",
        attempts: 3,
        lastAttemptMs: 10_000,
        destTabId: "currency",
        reason: "Currency:currency",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.reason).toContain(STASH_FAILED_OR_TIMED_OUT_REASON);
    expect(decision.recoveryOf).toBe(STASH_WRONG_TAB_KEY);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: decision.reason }]);
  });

  it("enters SafetyHold when fallback tab is also full", () => {
    const world = createStashWorld((next) => {
      next.inventory = {
        value: {
          occupied: 1,
          capacity: 4,
          full: false,
          cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.stash = {
        value: {
          tabId: "currency",
          cells: stashCells("currency", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]),
          tabFull: true,
        },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.flags.stashItemCatalog = {
        "divine-1": { class: "Currency", category: "HighValueSell", score: 95 },
      };
    });
    const withDump = {
      ...world,
      stash: {
        ...world.stash,
        value: {
          ...world.stash.value,
          cells: [
            ...stashCells("currency", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]),
            ...stashCells("dump", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]),
          ],
        },
      },
    };
    const decision = new StashController().decide(withDump, createTestScenario());
    expect(decision.state).toBe("SafetyHold");
    expect(decision.reason).toContain(STASH_FALLBACK_TAB_FULL_REASON);
  });

  it("returns emergency-stop and emits no drag", () => {
    const world = createStashWorld((next) => {
      next.flags.emergencyStopLatched = true;
      next.inventory = {
        value: {
          occupied: 1,
          capacity: 4,
          full: false,
          cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new StashController().decide(world, createTestScenario());
    expect(decision.state).toBe("EmergencyStop");
    expect(decision.reason).toBe("emergency-stop");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
  });
});
