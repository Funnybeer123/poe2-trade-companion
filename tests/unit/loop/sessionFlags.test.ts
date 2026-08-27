import {
  InventoryController,
  ListingController,
  LootController,
  applyPostDecisionEffects,
  beginListingSession,
  beginStashSession,
  beginTradeSession,
  clearInFlightStep,
  endStashSession,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, fillInventory } from "../../helpers/createTestWorld.js";

describe("orchestrator flag ownership", () => {
  it("keeps InventoryController decision-only and starts stash via beginStashSession", () => {
    const world = createTestWorld((next) => {
      next.selectedState = "InventoryFull";
      fillInventory(next);
    });
    const before = structuredClone(world.flags);
    const decision = new InventoryController().decide(world, createTestScenario());
    expect(world.flags).toEqual(before);
    expect(world.flags.stashSessionActive).toBe(false);
    expect(decision.intendedActions.every((action) => action.type === "noop")).toBe(true);

    const owned = beginStashSession(world.flags);
    expect(owned.stashSessionActive).toBe(true);
    expect(world.flags.stashSessionActive).toBe(false);

    const applied = applyPostDecisionEffects(world, decision, 10_000);
    expect(applied.flags.stashSessionActive).toBe(true);
  });

  it("starts listing and trade sessions only through orchestrator-owned helpers", () => {
    const world = createTestWorld();
    expect(new ListingController().decide(world, createTestScenario()).module).toBe("listing");
    expect(world.flags.listingSessionActive).toBe(false);
    expect(world.flags.tradeRequested).toBe(false);

    const listing = beginListingSession(world.flags, [
      {
        fingerprint: "astramentis-1",
        quote: {
          providerId: "fixture",
          quotedAtMs: 10_000,
          currency: "divine",
          fair: 15,
          candidateCount: 4,
          comparableCount: 3,
          confidence: "high",
        },
      },
    ]);
    expect(listing.listingSessionActive).toBe(true);
    expect(listing.listingCatalog?.[0]?.fingerprint).toBe("astramentis-1");

    const trade = beginTradeSession(world.flags, {
      kind: "whisper-trade-request",
      source: "fixture",
      atMs: 10_000,
      requestedItemFingerprint: "astramentis-1",
    });
    expect(trade.tradeRequested).toBe(true);
    expect(trade.tradeEvent?.kind).toBe("whisper-trade-request");
  });

  it("clears only the interrupted module in-flight step and leaves counters intact", () => {
    const world = createTestWorld((next) => {
      next.flags.pendingLootPickup = { id: "exalted-1", occupancy: 4, clickedAtMs: 10_000 };
      next.flags.lootAttemptCounts = { "exalted-1": 1 };
      next.flags.lootLastAttemptMs = { "exalted-1": 10_000 };
      next.flags.pendingStashTransfer = {
        fingerprint: "divine-1",
        from: { kind: "inventory", x: 0, y: 0 },
        to: { kind: "stash", tabId: "currency", x: 0, y: 0 },
        kind: "move",
        attempts: 2,
        lastAttemptMs: 10_000,
        destTabId: "currency",
        reason: "stash-move:divine-1",
      };
    });

    const afterLoot = clearInFlightStep(world.flags, "loot");
    expect(afterLoot.pendingLootPickup).toBeNull();
    expect(afterLoot.lootAttemptCounts).toEqual({ "exalted-1": 1 });
    expect(afterLoot.lootLastAttemptMs).toEqual({ "exalted-1": 10_000 });
    expect(afterLoot.pendingStashTransfer?.attempts).toBe(2);

    const afterStash = clearInFlightStep(world.flags, "stash");
    expect(afterStash.pendingStashTransfer).toBeNull();
    expect(afterStash.pendingLootPickup?.id).toBe("exalted-1");
    expect(endStashSession(world.flags).stashSessionActive).toBe(false);
  });

  it("does not let LootController mutate session flags", () => {
    const world = createTestWorld();
    const flags = structuredClone(world.flags);
    new LootController().decide(world, createTestScenario());
    expect(world.flags).toEqual(flags);
  });
});
