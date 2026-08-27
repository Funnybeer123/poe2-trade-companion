import { LootController, SKIP_INVENTORY_FULL } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, fillInventory, observeLoot } from "../../helpers/createTestWorld.js";

describe("LootController", () => {
  it("clicks the highest-ranked eligible label and records pick/skip reasons", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "HighValueLoot";
      next.inventory = {
        value: { occupied: 4, capacity: 60, cells: [], full: false },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      observeLoot(next, [
        { id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 900, y: 500 } },
        { id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 800, y: 400 } },
      ]);
    });
    const decision = new LootController().decide(world, createTestScenario());
    expect(decision.reason).toContain("pick:divine-1");
    expect(decision.reason).toContain("skip:wisdom-1:below-min-score");
    expect(decision.intendedActions).toEqual([
      { type: "mouse-click", x: 800, y: 400, button: "left" },
    ]);
  });

  it("issues no pickup clicks when inventory is full", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "LootPickup";
      fillInventory(next);
      observeLoot(next, [
        { id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 800, y: 400 } },
      ]);
    });
    const decision = new LootController().decide(world, createTestScenario());
    expect(decision.reason).toBe(SKIP_INVENTORY_FULL);
    expect(decision.intendedActions.every((action) => action.type !== "mouse-click")).toBe(true);
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: SKIP_INVENTORY_FULL }]);
  });

  it("backs off and then suppresses after two failed attempts", () => {
    const controller = new LootController();
    const scenario = createTestScenario();
    const base = (attempts: number, clockMs: number, lastAttemptMs: number) =>
      createTestWorld((next) => {
        next.selectedState = "LootPickup";
        next.clockMs = clockMs;
        next.inventory = {
          value: { occupied: 4, capacity: 60, cells: [], full: false },
          confidence: 1,
          observedAtMs: clockMs,
          freshness: "fresh",
        };
        next.flags.lootAttemptCounts = { "exalted-1": attempts };
        next.flags.lootLastAttemptMs = { "exalted-1": lastAttemptMs };
        observeLoot(next, [
          { id: "exalted-1", labelText: "Exalted Orb", screenPoint: { x: 700, y: 350 } },
        ]);
      });

    const backoff = controller.decide(base(1, 10_200, 10_000), scenario);
    expect(backoff.reason).toBe("loot-backoff");
    expect(backoff.intendedActions[0]?.type).toBe("noop");
    expect(backoff.recoveryOf).toBe("loot.unreachable");

    const retry = controller.decide(base(1, 10_300, 10_000), scenario);
    expect(retry.reason).toContain("pick:exalted-1");
    expect(retry.retryIndex).toBe(2);
    expect(retry.intendedActions[0]?.type).toBe("mouse-click");

    const suppressed = controller.decide(base(2, 11_100, 10_300), scenario);
    expect(suppressed.intendedActions[0]?.type).toBe("noop");
    expect(suppressed.suppressTargetIds).toEqual(["exalted-1"]);
    expect(suppressed.recoveryOf).toBe("loot.unreachable");
  });

  it("stops generated loot input on emergency stop", () => {
    const world = createTestWorld((next) => {
      next.flags.emergencyStopLatched = true;
      observeLoot(next, [{ id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } }]);
    });
    const decision = new LootController().decide(world, createTestScenario());
    expect(decision.reason).toBe("emergency-stop");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
  });
});
