import { describe, expect, it } from "vitest";
import { scoreDesirability } from "../src/core/desirability.js";
import { parseItemText } from "../src/core/parseItem.js";
import { buildSearchRegex } from "../src/core/searchRegex.js";
import type { ValuationResult } from "../src/core/types.js";

describe("AND-combined stash queries", () => {
  it("emits one query with every selection as its own quoted term", () => {
    const result = buildSearchRegex(["maximum Life", "Fire Resistance"], {
      combine: "and",
      maxLength: 50,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.queries).toHaveLength(1);
    const query = result.queries[0]!;
    expect(query.stashQuery).toBe('"maximum Life" "Fire Resistance"');
    expect(query.length).toBeLessThanOrEqual(50);
    const probe = new RegExp(query.query, query.flags);
    expect(probe.test("+30 to maximum Life\n+20% to Fire Resistance")).toBe(true);
    expect(probe.test("+30 to maximum Life")).toBe(false);
  });

  it("reports a conflict instead of splitting an over-budget AND set", () => {
    const result = buildSearchRegex(
      ["maximum Life", "Fire Resistance", "Cold Resistance"],
      { combine: "and", maxLength: 30 },
    );
    expect(result.queries).toHaveLength(0);
    expect(result.conflicts.join(" ")).toMatch(/AND terms cannot be split/);
  });

  it("still validates numeric selections inside an AND set", () => {
    const result = buildSearchRegex(
      {
        selections: [
          { field: "mod", representativeLine: "+32% to Fire Resistance", min: 30, max: 40 },
          { field: "text", text: "Rarity: Rare" },
        ],
        options: { combine: "and", maxLength: 60 },
      },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.queries[0]!.stashQuery).toMatch(/^".+" ".+"$/);
    const probe = new RegExp(result.queries[0]!.query, "i");
    expect(probe.test("Rarity: Rare\n+35% to Fire Resistance")).toBe(true);
    expect(probe.test("Rarity: Rare\n+45% to Fire Resistance")).toBe(false);
  });
});

describe("desirability craft category", () => {
  const flatValuation: ValuationResult = {
    itemIdentifier: "x",
    itemType: "Rings",
    normalizedKeyStats: { itemLevel: 60, quality: 0, rarity: "Rare", modCount: 4 },
    providerName: "fixture",
    marketTimestamp: "1970-01-01T00:00:00.000Z",
    candidateCount: 0,
    comparablesUsed: 0,
    low: 0,
    fair: 0,
    high: 0,
    recommendedListing: 0,
    currency: "exalted",
    confidence: "none",
    lowConfidenceReason: "no comparables",
  };

  it("classifies a cheap multi-mod rare as craft, not vendor", () => {
    const item = parseItemText(
      [
        "Item Class: Rings",
        "Rarity: Rare",
        "Doom Loop",
        "Iron Ring",
        "--------",
        "Item Level: 60",
        "--------",
        "+10 to maximum Life",
        "+8% to Fire Resistance",
        "+7% to Cold Resistance",
        "+6 to Strength",
      ].join("\n"),
    );
    const result = scoreDesirability(item, flatValuation);
    expect(item.mods.length).toBeGreaterThanOrEqual(4);
    expect(result.score).toBeLessThan(55);
    expect(result.category).toBe("craft");
  });
});
