import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  itemKindOf,
  itemSummary,
  pseudoTotals,
  tradeCurrencyIdFor,
  uniqueVariantsFor,
  staticCurrencyIds,
  PSEUDO_STATS,
} from "../src/core/evaluateItem.js";
import { parseItemText } from "../src/core/parseItem.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { TRADE_CURRENCY_NAMES } from "../src/core/tradeListings.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8");
}

function parse(name: string) {
  return parseItemText(fixture(name));
}

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:widowhail", match: { name: "Widowhail", baseType: "Crude Bow", rarity: "Unique" }, value: 40 },
    { id: "feed:poe2scout:cheap", match: { name: "Bough of Woe", baseType: "Crude Bow", rarity: "Unique" }, value: 4 },
    { id: "feed:poe2scout:other", match: { name: "Headhunter", baseType: "Heavy Belt", rarity: "Unique" }, value: 900 },
  ],
};

describe("itemKindOf", () => {
  it("reads the item class first and the rarity only as a fallback", () => {
    expect(itemKindOf(parse("rare-ring-resists.txt"))).toBe("rare");
    expect(itemKindOf(parse("weapon-quarterstaff.txt"))).toBe("rare");
    expect(itemKindOf(parse("gem-support.txt"))).toBe("gem");
    expect(itemKindOf(parse("flask-life.txt"))).toBe("flask");
    expect(itemKindOf(parse("currency-divine.txt"))).toBe("currency");
    expect(itemKindOf(parse("unidentified-unique-bow.txt"))).toBe("unidentified-unique");
  });
});

describe("pseudoTotals", () => {
  it("sums resistances the way the trade site does: all-elemental counts once per element", () => {
    const totals = pseudoTotals(parse("rare-ring-resists.txt"));
    const byId = new Map(totals.map((total) => [total.id, total.value]));
    // fire 31 + 9, cold 27 + 9, lightning 0 + 9 → 85 elemental
    expect(byId.get("total_fire_resistance")).toBe(40);
    expect(byId.get("total_cold_resistance")).toBe(36);
    expect(byId.get("total_lightning_resistance")).toBe(9);
    expect(byId.get("total_elemental_resistance")).toBe(85);
    expect(byId.get("total_resistance")).toBe(85);
    expect(byId.get("count_resistances")).toBe(3);
    expect(byId.get("total_life")).toBe(72);
  });

  it("counts a socketed rune line for attributes and never an enchant", () => {
    const totals = pseudoTotals(parse("rare-ring-resists.txt"));
    const strength = totals.find((total) => total.id === "total_strength");
    expect(strength?.value).toBe(38);
    // The parser strips the trailing "(rune)" tag into mod.kind.
    expect(strength?.sources).toEqual(["+38 to Strength"]);
    expect(totals.some((total) => total.id === "total_all_attributes")).toBe(false);
  });

  it("returns nothing for a Sanctum relic (its lines are not searchable stats)", () => {
    const relic = parseItemText(
      [
        "Item Class: Relics",
        "Rarity: Rare",
        "Sacred Urn",
        "Urn Relic",
        "--------",
        "Item Level: 80",
        "--------",
        "+31% to Fire Resistance",
      ].join("\n"),
    );
    expect(pseudoTotals(relic, "relic")).toEqual([]);
  });

  it("ships one catalogue text per pseudo id and never invents an id", () => {
    expect(new Set(PSEUDO_STATS.map((stat) => stat.id)).size).toBe(PSEUDO_STATS.length);
    for (const stat of PSEUDO_STATS) expect(stat.statText).toContain("#");
  });
});

describe("tradeCurrencyIdFor", () => {
  it("round-trips every id in TRADE_CURRENCY_NAMES and refuses the unknown", () => {
    for (const [id, name] of Object.entries(TRADE_CURRENCY_NAMES)) {
      expect(tradeCurrencyIdFor(name)).toBe(id);
    }
    expect(tradeCurrencyIdFor("Breach Splinter")).toBeUndefined();
  });
});

describe("staticCurrencyIds", () => {
  it("reads the ids /data/static prints and skips anything else", () => {
    const ids = staticCurrencyIds({
      result: [
        {
          id: "Currency",
          entries: [
            { id: "vault-key", text: "Vault Key", image: "x" },
            { id: "exalted", text: "Exalted Orb" },
            { id: 7, text: "Broken" },
            { text: "No id" },
          ],
        },
        { id: "Junk" },
        "nonsense",
      ],
    });
    expect(ids.get("vault key")).toBe("vault-key");
    expect(ids.get("exalted orb")).toBe("exalted");
    expect(ids.size).toBe(2);
    expect(staticCurrencyIds(undefined).size).toBe(0);
    expect(staticCurrencyIds({ result: "nope" }).size).toBe(0);
  });
});

describe("uniqueVariantsFor", () => {
  it("lists the price table's uniques on that base, most valuable first", () => {
    expect(uniqueVariantsFor("Crude Bow", TABLE)).toEqual(["Widowhail", "Bough of Woe"]);
    expect(uniqueVariantsFor("Ruby Ring", TABLE)).toEqual([]);
    expect(uniqueVariantsFor("Crude Bow", undefined)).toEqual([]);
  });
});

describe("itemSummary", () => {
  it("carries the weapon DPS with its Q20 estimate", () => {
    const summary = itemSummary(parse("weapon-quarterstaff.txt"));
    expect(summary.kind).toBe("rare");
    expect(summary.dps?.aps).toBe(1.4);
    expect(summary.dps?.pdps).toBe(91);
    expect(summary.dps?.edps).toBe(25.2);
    expect(summary.dps?.total).toBe(116.2);
    // 91 × 120 / 112 = 97.5
    expect(summary.dps?.pdpsQ20).toBe(97.5);
    expect(summary.quality).toBe(12);
  });

  it("counts open affixes and seals a corrupted item", () => {
    const summary = itemSummary(parse("rare-ring-resists.txt"));
    expect(summary.maxAffixes).toBe(6);
    expect(summary.affixCount).toBe(3);
    expect(summary.openAffixes).toBe(3);

    const corrupted = parseItemText(`${fixture("rare-ring-resists.txt")}\n--------\nCorrupted`);
    expect(itemSummary(corrupted).openAffixes).toBe(0);
    expect(itemSummary(corrupted).corrupted).toBe(true);
  });

  it("resolves a currency id and the stack count for a stackable", () => {
    const summary = itemSummary(parse("currency-divine.txt"));
    expect(summary.kind).toBe("currency");
    expect(summary.currencyId).toBe("divine");
    expect(summary.stackCount).toBe(4);
  });

  it("offers unique variants for an unidentified unique and the required level", () => {
    const summary = itemSummary(parse("unidentified-unique-bow.txt"), { priceTable: TABLE });
    expect(summary.kind).toBe("unidentified-unique");
    expect(summary.identified).toBe(false);
    expect(summary.uniqueVariants).toEqual(["Widowhail", "Bough of Woe"]);
  });

  it("reads gem level and rune sockets", () => {
    expect(itemSummary(parse("gem-support.txt")).gemLevel).toBe(18);
    expect(itemSummary(parse("weapon-quarterstaff.txt")).runeSockets).toBe(2);
  });
});
