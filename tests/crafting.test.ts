import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  AUTO_CRAFT_WHITELIST,
  DEFAULT_ORB_COSTS,
  ORB_NAMES,
  archetypeForClass,
  exaltedFromScore,
  expectedSlamGain,
  orbCosts,
  planCraft,
} from "../src/core/crafting.js";
import {
  PRICE_TABLE_SCHEMA_VERSION,
  starterPriceTable,
  stripStarterPlaceholders,
  type PriceTable,
} from "../src/core/priceTable.js";

function item(lines: string[]): string {
  return lines.join("\n");
}

const RARE_OPEN_RING = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
  "+32% to Cold Resistance",
]);

const FULL_RARE_RING_ONE_DUD = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Coil",
  "Ruby Ring",
  "--------",
  "Item Level: 82",
  "--------",
  "+130 to maximum Life",
  "+41% to Fire Resistance",
  "+39% to Cold Resistance",
  "+35% to Lightning Resistance",
  "+22% to Chaos Resistance",
  "+7 to maximum Mana",
]);

const MAGIC_BOOTS_ONE_MOD = item([
  "Item Class: Boots",
  "Rarity: Magic",
  "Runner's Advance Boots",
  "Advance Boots",
  "--------",
  "Item Level: 78",
  "--------",
  "30% increased Movement Speed",
]);

const MAGIC_BOOTS_TWO_MODS = item([
  "Item Class: Boots",
  "Rarity: Magic",
  "Runner's Advance Boots of the Storm",
  "Advance Boots",
  "--------",
  "Item Level: 78",
  "--------",
  "30% increased Movement Speed",
  "+35% to Lightning Resistance",
]);

const WHITE_BODY = item([
  "Item Class: Body Armours",
  "Rarity: Normal",
  "Vaal Cuirass",
  "--------",
  "Item Level: 82",
]);

const LOW_ILVL_RARE = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Dusk Knot",
  "Iron Ring",
  "--------",
  "Item Level: 22",
  "--------",
  "+9 to maximum Life",
]);

const UNIDENTIFIED_RARE = item([
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Vaal Cuirass",
  "--------",
  "Item Level: 82",
  "--------",
  "Unidentified",
]);

const CORRUPTED_RARE = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
  "--------",
  "Corrupted",
]);

describe("crafting economy", () => {
  it("prices orbs at the verified defaults straight off the starter table", () => {
    // The starter table used to ship divine = 40 / chaos = 0.5 placeholders
    // that outranked the accurate defaults by exact-name match.
    expect(orbCosts(starterPriceTable())).toEqual(DEFAULT_ORB_COSTS);
    expect(starterPriceTable().entries.map((entry) => entry.id)).not.toContain("divine-orb");
    expect(starterPriceTable().entries.map((entry) => entry.id)).not.toContain("chaos-orb");
  });

  it("strips untouched legacy placeholders and keeps edited rows", () => {
    const legacy: PriceTable = {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: "exalted",
      entries: [
        { id: "divine-orb", match: { name: "Divine Orb" }, value: 40, note: "Edit to the current rate." },
        { id: "exalted-orb", match: { name: "Exalted Orb" }, value: 1 },
        { id: "chaos-orb", match: { name: "Chaos Orb" }, value: 0.5 },
        { id: "any-unique", match: { rarity: "Unique" }, value: 1 },
      ],
    };
    expect(orbCosts(legacy).divine).toBe(40);
    const stripped = stripStarterPlaceholders(legacy);
    expect(stripped.entries.map((entry) => entry.id)).toEqual(["exalted-orb", "any-unique"]);
    expect(orbCosts(stripped)).toEqual(DEFAULT_ORB_COSTS);

    const edited: PriceTable = {
      ...legacy,
      entries: [
        { id: "divine-orb", match: { name: "Divine Orb" }, value: 500 },
        { id: "chaos-orb", match: { name: "Chaos Orb" }, value: 0.5 },
      ],
    };
    const kept = stripStarterPlaceholders(edited);
    expect(kept.entries.map((entry) => entry.id)).toEqual(["divine-orb"]);
    expect(orbCosts(kept).divine).toBe(500);

    // Nothing to strip returns the very same table object.
    expect(stripStarterPlaceholders(stripped)).toBe(stripped);
  });

  it("prices every orb and lets the user's price table override by name", () => {
    const table: PriceTable = {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: "exalted",
      entries: [
        { id: "divine", match: { name: "Divine Orb" }, value: 400 },
        { id: "chaos", match: { name: "Chaos Orb" }, value: 5 },
      ],
    };
    const costs = orbCosts(table);
    expect(costs.divine).toBe(400);
    expect(costs.chaos).toBe(5);
    expect(costs.exalted).toBe(DEFAULT_ORB_COSTS.exalted);
    expect(Object.keys(ORB_NAMES).sort()).toEqual(Object.keys(DEFAULT_ORB_COSTS).sort());
  });

  it("maps appraisal scores onto the exalted curve consistently", () => {
    expect(exaltedFromScore(0)).toBe(0);
    expect(exaltedFromScore(40)).toBe(0);
    // Market-convexity anchors: score 55 ≈ 1 ex, 70 ≈ 3 ex, 100 ≈ 16 ex.
    expect(exaltedFromScore(55)).toBeCloseTo(1, 1);
    expect(exaltedFromScore(70)).toBeCloseTo(3, 1);
    expect(exaltedFromScore(100)).toBeCloseTo(15, 1);
    // Scores past 100 clamp — projections cannot invent value.
    expect(exaltedFromScore(130)).toBe(exaltedFromScore(100));
  });
});

describe("archetypes", () => {
  it("covers the common gear classes", () => {
    for (const cls of ["Rings", "Belts", "Amulets", "Boots", "Gloves", "Helmets", "Body Armours", "Wands", "Bows", "Quarterstaves"]) {
      expect(archetypeForClass(cls), cls).toBeDefined();
    }
    expect(archetypeForClass("Stackable Currency")).toBeUndefined();
  });

  it("estimates slam gains with class-specific odds", () => {
    const boots = archetypeForClass("Boots")!;
    const gain = expectedSlamGain(boots, 30);
    expect(gain.pGood).toBe(boots.pGoodSlam);
    expect(gain.deltaGood).toBeGreaterThan(gain.deltaWeak);
    expect(gain.expectedDelta).toBeGreaterThan(0);
  });

  it("keeps every desirable family id resolvable", () => {
    for (const archetype of ARCHETYPES) {
      const gain = expectedSlamGain(archetype, 0);
      expect(gain.deltaGood, archetype.id).toBeGreaterThan(0);
    }
  });
});

const RARE_OPEN_RING_WITH_RUNE = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+25% to Lightning Resistance (rune)",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
  "+32% to Cold Resistance",
]);

describe("planCraft decisions", () => {
  it("does not count a socketed rune against the open affixes", () => {
    const plain = planCraft(RARE_OPEN_RING);
    const withRune = planCraft(RARE_OPEN_RING_WITH_RUNE);
    expect(withRune.openAffixes).toBe(plain.openAffixes);
    expect(withRune.action).toBe(plain.action);
  });

  it("slams open affixes on a coherent rare and marks it auto-eligible", () => {
    const plan = planCraft(RARE_OPEN_RING);
    expect(plan.action).toBe("exalt");
    expect(plan.orb).toBe("exalted");
    expect(plan.openAffixes).toBe(3);
    expect(plan.onArchetypeMods.length).toBeGreaterThanOrEqual(3);
    expect(plan.expectedProfit).toBeGreaterThan(0);
    expect(plan.confidence).toBeGreaterThanOrEqual(70);
    expect(plan.autoEligible).toBe(true);
  });

  it("regals a magic item that has on-archetype mods", () => {
    const plan = planCraft(MAGIC_BOOTS_TWO_MODS);
    expect(plan.action).toBe("regal");
    expect(plan.autoEligible).toBe(true);
  });

  it("augments a one-mod magic item", () => {
    const plan = planCraft(MAGIC_BOOTS_ONE_MOD);
    expect(plan.action).toBe("augment");
    expect(plan.cost).toBeLessThan(0.2);
  });

  it("starts the transmute ladder on a high-ilvl white base", () => {
    const plan = planCraft(WHITE_BODY);
    expect(plan.action).toBe("transmute");
    expect(plan.archetypeId).toBe("body-armour");
  });

  it("recommends but never automates removal orbs on a full rare", () => {
    const plan = planCraft(FULL_RARE_RING_ONE_DUD);
    expect(["chaos-swap", "sell", "hold", "divine"]).toContain(plan.action);
    if (plan.action === "chaos-swap") {
      expect(plan.autoEligible).toBe(false);
      expect(AUTO_CRAFT_WHITELIST.has(plan.action)).toBe(false);
    }
  });

  it("skips low item-level gear entirely", () => {
    const plan = planCraft(LOW_ILVL_RARE);
    expect(plan.action).toBe("skip");
    expect(plan.autoEligible).toBe(false);
  });

  it("asks for identification before spending orbs", () => {
    const plan = planCraft(UNIDENTIFIED_RARE);
    expect(plan.action).toBe("identify");
    expect(plan.autoEligible).toBe(false);
  });

  it("never crafts corrupted items", () => {
    const plan = planCraft(CORRUPTED_RARE);
    expect(["sell", "skip"]).toContain(plan.action);
    expect(plan.autoEligible).toBe(false);
  });

  it("stops at the per-item budget", () => {
    const plan = planCraft(RARE_OPEN_RING, { spentSoFar: 7.5, policy: { perItemBudget: 8 } });
    expect(plan.action).toBe("sell");
    expect(plan.reasons.join(" ")).toMatch(/budget/i);
  });

  it("respects the confidence gate", () => {
    const strict = planCraft(RARE_OPEN_RING, { policy: { minAutoConfidence: 95 } });
    expect(strict.action).toBe("exalt");
    expect(strict.autoEligible).toBe(false);
  });

  it("explains every confidence adjustment in the reasons", () => {
    const plan = planCraft(RARE_OPEN_RING);
    expect(plan.reasons.some((reason) => /confidence/.test(reason))).toBe(true);
    expect(plan.reasons.some((reason) => /archetype/.test(reason))).toBe(true);
  });

  it("handles garbage text as a confident skip", () => {
    const plan = planCraft("not an item at all");
    expect(plan.action).toBe("skip");
    expect(plan.confidence).toBeGreaterThan(80);
  });
});
