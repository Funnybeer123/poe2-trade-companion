import { describe, expect, it } from "vitest";
import { FollowController, LootController, TradeController } from "../src/core/controllers.js";
import { generateLootFilter } from "../src/core/lootFilter.js";
import { planSort, searchCatalog } from "../src/core/catalog.js";
import { PRESET_SCENARIOS } from "../src/core/scenarios.js";
import type { PerceptionFrame } from "../src/core/types.js";

const frame = (over: Partial<PerceptionFrame>): PerceptionFrame => ({
  timestamp: "t",
  windowTitle: "Path of Exile 2",
  processName: "PathOfExile.exe",
  loot: [],
  evidenceHash: "h",
  confidence: 0.9,
  ...over,
});

describe("controllers and catalog", () => {
  it("follows and picks up according to policy", () => {
    const scenario = PRESET_SCENARIOS.find((entry) => entry.id === "full-loop")!;
    const follow = new FollowController().decide(
      frame({ navigationTarget: { id: "leader", screenX: 0.2, screenY: 0.5, confidence: 0.9 } }),
      scenario,
    );
    expect(follow.intended[0]?.key).toBe("A");
    const loot = new LootController().decide(
      frame({ loot: [{ id: "1", label: "junk", screenX: 0.5, screenY: 0.5, desirability: 10 }] }),
      scenario,
    );
    expect(loot.rule).toBe("skip-low-value");
  });

  it("rejects wrong currency trades", () => {
    const scenario = PRESET_SCENARIOS.find((entry) => entry.id === "trade-session")!;
    const decision = new TradeController().decide(
      frame({
        tradeWindowOpen: true,
        offeredCurrencyAmount: 1,
        placedItemFingerprint: "abc",
      }),
      scenario,
      "abc",
    );
    expect(decision.outcome).toBe("reject");
  });

  it("searches catalog and plans sort", () => {
    const items = [
      {
        fingerprint: "1",
        name: "Storm Veil",
        baseType: "Coat",
        itemClass: "Body Armours",
        location: "inventory",
        recommendation: "sell" as const,
        fairValue: 10,
      },
    ];
    expect(searchCatalog(items, { text: "storm" })).toHaveLength(1);
    expect(planSort(items, { sell: "sale" })[0]?.destinationTab).toBe("sale");
  });

  it("generates a local loot filter", () => {
    const filter = generateLootFilter({ hideBelowScore: 40, highlightUniques: true, name: "qa" });
    expect(filter).toContain("Rarity Unique");
    expect(filter).toContain("Hide");
  });
});
