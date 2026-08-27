import { DEFAULT_RECOVERY, SKIP_UNREACHABLE, estimateLootPickup } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestWorld, observeLoot } from "../../helpers/createTestWorld.js";

const POLICY = DEFAULT_RECOVERY["loot.unreachable"];

function lootObservation(world: ReturnType<typeof createTestWorld>) {
  return world.loot;
}

describe("loot.unreachable suppression", () => {
  it("suppresses an id for 15s after two observed failed pickups", () => {
    const world = createTestWorld((next) => {
      observeLoot(next, [{ id: "exalted-1", labelText: "Exalted Orb", screenPoint: { x: 400, y: 300 } }]);
      next.inventory = {
        value: { occupied: 4, capacity: 60, cells: [], full: false },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.flags.pendingLootPickup = { id: "exalted-1", occupancy: 4, clickedAtMs: 10_000 };
    });

    const firstFail = estimateLootPickup({
      flags: world.flags,
      loot: lootObservation(world),
      inventory: world.inventory,
      nowMs: 10_300,
    });
    expect(firstFail.flags.lootAttemptCounts?.["exalted-1"]).toBe(1);
    expect(firstFail.flags.pendingLootPickup).toBeNull();
    expect(firstFail.loot.value[0]?.skipReason).toBeUndefined();

    const secondClick = {
      ...firstFail.flags,
      pendingLootPickup: { id: "exalted-1", occupancy: 4, clickedAtMs: 10_300 },
    };
    const secondFail = estimateLootPickup({
      flags: secondClick,
      loot: lootObservation(world),
      inventory: world.inventory,
      nowMs: 11_100,
    });
    expect(secondFail.flags.lootAttemptCounts?.["exalted-1"]).toBe(2);
    expect(secondFail.flags.lootSuppressedUntilMs?.["exalted-1"]).toBe(11_100 + (POLICY?.suppressMs ?? 15_000));
    expect(secondFail.loot.value[0]?.skipReason).toBe(SKIP_UNREACHABLE);

    const stillSuppressed = estimateLootPickup({
      flags: secondFail.flags,
      loot: lootObservation(world),
      inventory: world.inventory,
      nowMs: 20_000,
    });
    expect(stillSuppressed.loot.value[0]?.skipReason).toBe(SKIP_UNREACHABLE);

    const afterWindow = estimateLootPickup({
      flags: stillSuppressed.flags,
      loot: lootObservation(world),
      inventory: world.inventory,
      nowMs: 11_100 + (POLICY?.suppressMs ?? 15_000),
    });
    expect(afterWindow.loot.value[0]?.skipReason).toBeUndefined();
    expect(afterWindow.flags.lootAttemptCounts?.["exalted-1"]).toBeUndefined();
  });

  it("treats label disappearance as observed pickup success", () => {
    const world = createTestWorld((next) => {
      observeLoot(next, []);
      next.inventory = {
        value: { occupied: 4, capacity: 60, cells: [], full: false },
        confidence: 1,
        observedAtMs: 10_200,
        freshness: "fresh",
      };
      next.flags.pendingLootPickup = { id: "divine-1", occupancy: 4, clickedAtMs: 10_000 };
      next.flags.lootAttemptCounts = { "divine-1": 1 };
    });
    const result = estimateLootPickup({
      flags: world.flags,
      loot: world.loot,
      inventory: world.inventory,
      nowMs: 10_200,
    });
    expect(result.flags.pendingLootPickup).toBeNull();
    expect(result.flags.lootAttemptCounts?.["divine-1"]).toBeUndefined();
    expect(result.flags.lootSuppressedUntilMs?.["divine-1"]).toBeUndefined();
  });

  it("treats occupancy increase as observed pickup success", () => {
    const world = createTestWorld((next) => {
      observeLoot(next, [{ id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } }]);
      next.inventory = {
        value: { occupied: 5, capacity: 60, cells: [], full: false },
        confidence: 1,
        observedAtMs: 10_200,
        freshness: "fresh",
      };
      next.flags.pendingLootPickup = { id: "divine-1", occupancy: 4, clickedAtMs: 10_000 };
    });
    const result = estimateLootPickup({
      flags: world.flags,
      loot: world.loot,
      inventory: world.inventory,
      nowMs: 10_200,
    });
    expect(result.flags.pendingLootPickup).toBeNull();
    expect(result.flags.lootAttemptCounts?.["divine-1"]).toBeUndefined();
  });
});
