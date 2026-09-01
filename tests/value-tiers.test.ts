import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyPriceTable,
  entryMatches,
  lookupPrice,
  starterPriceTable,
  validatePriceTable,
  type PriceTable,
} from "../src/core/priceTable.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  emptyValueTierRules,
  evaluateValueTier,
  starterValueTierRules,
  validateValueTierRules,
  type ValueTierRules,
} from "../src/core/valueTiers.js";

const rareBody = readFileSync(
  path.join(process.cwd(), "fixtures", "items", "rare-body.txt"),
  "utf8",
);
const uniqueBow = readFileSync(
  path.join(process.cwd(), "fixtures", "items", "unique-bow.txt"),
  "utf8",
);
const exalted = readFileSync(
  path.join(process.cwd(), "fixtures", "items", "exalted.txt"),
  "utf8",
);

function rules(partial: Partial<ValueTierRules>): ValueTierRules {
  return { ...emptyValueTierRules(), ...partial };
}

describe("price table", () => {
  it("validates a well-formed table and rejects matchless entries", () => {
    const good = validatePriceTable({
      currency: "exalted",
      entries: [{ id: "a", match: { name: "Divine Orb" }, value: 40 }],
    });
    expect(good.valid).toBe(true);
    expect(good.table?.entries).toHaveLength(1);

    const bad = validatePriceTable({
      entries: [{ id: "b", match: {}, value: 3 }],
    });
    expect(bad.valid).toBe(false);
    expect(bad.issues[0]?.message).toMatch(/at least one field/);
  });

  it("prefers the most specific matching entry", () => {
    const table: PriceTable = {
      ...emptyPriceTable(),
      entries: [
        { id: "any-unique", match: { rarity: "Unique" }, value: 1 },
        { id: "named", match: { name: "Widowhail", rarity: "Unique" }, value: 25 },
      ],
    };
    const hit = lookupPrice(table, { name: "Widowhail", rarity: "Unique" });
    expect(hit?.entry.id).toBe("named");
    expect(hit?.value).toBe(25);
  });

  it("honours minItemLevel and case-insensitive matching", () => {
    const match = { baseType: "advanced maraketh coat", minItemLevel: 80 };
    expect(entryMatches(match, { baseType: "Advanced Maraketh Coat", itemLevel: 82 })).toBe(true);
    expect(entryMatches(match, { baseType: "Advanced Maraketh Coat", itemLevel: 70 })).toBe(false);
  });

  it("ships a starter table the user can edit", () => {
    const table = starterPriceTable();
    expect(validatePriceTable(table).valid).toBe(true);
    expect(lookupPrice(table, { name: "Divine Orb" })?.value).toBeGreaterThan(0);
  });
});

describe("value tier evaluation", () => {
  it("never dumps unparseable text", () => {
    const verdict = evaluateValueTier("random clipboard content", {
      rules: rules({ dump: [{ name: "everything", regex: "random" }] }),
    });
    expect(verdict.tier).toBe("unknown");
    expect(verdict.source).toBe("safety");
  });

  it("always pulls unidentified items aside for review", () => {
    const unidentified = [
      "Item Class: Body Armours",
      "Rarity: Rare",
      "Advanced Maraketh Coat",
      "--------",
      "Item Level: 82",
      "--------",
      "Unidentified",
    ].join("\n");
    const verdict = evaluateValueTier(unidentified, {
      rules: rules({ dump: [{ name: "all rares", regex: '"Rarity: Rare"' }] }),
    });
    expect(verdict.tier).toBe("keep");
    expect(verdict.source).toBe("safety");
  });

  it("lets the price table outrank rules", () => {
    const table: PriceTable = {
      ...emptyPriceTable(),
      entries: [{ id: "ex", match: { name: "Exalted Orb" }, value: 10 }],
    };
    const verdict = evaluateValueTier(exalted, {
      rules: rules({ dump: [{ name: "currency", regex: "Currency" }] }),
      priceTable: table,
    });
    expect(verdict.tier).toBe("keep");
    expect(verdict.source).toBe("price-table");
    expect(verdict.price).toBe(10);
  });

  it("classifies keep before sell before dump when rules overlap", () => {
    const verdict = evaluateValueTier(rareBody, {
      rules: {
        keep: [{ name: "movement speed", regex: '"Movement Speed"' }],
        sell: [{ name: "any rare", regex: '"Rarity: Rare"' }],
        dump: [{ name: "any rare too", regex: '"Rarity: Rare"' }],
      },
    });
    expect(verdict.tier).toBe("keep");
    expect(verdict.matchedRules).toContain("movement speed");
  });

  it("supports resistance helper terms in tier rules", () => {
    const verdict = evaluateValueTier(rareBody, {
      rules: rules({ keep: [{ name: "double res", regex: '"ANY_RESIST >= 2"' }] }),
    });
    expect(verdict.tier).toBe("keep");
  });

  it("returns unknown when nothing matches", () => {
    const verdict = evaluateValueTier(uniqueBow, {
      rules: rules({ dump: [{ name: "normals", regex: '"Rarity: Normal"' }] }),
    });
    expect(verdict.tier).toBe("unknown");
    expect(verdict.source).toBe("default");
  });

  it("price threshold boundaries choose keep vs sell", () => {
    const table: PriceTable = {
      ...emptyPriceTable(),
      entries: [{ id: "ex", match: { name: "Exalted Orb" }, value: DEFAULT_TIER_THRESHOLDS.sellAtOrAbove }],
    };
    const verdict = evaluateValueTier(exalted, { rules: emptyValueTierRules(), priceTable: table });
    expect(verdict.tier).toBe("sell");
  });

  it("ships starter rules that validate", () => {
    expect(validateValueTierRules(starterValueTierRules())).toEqual([]);
  });

  it("flags invalid bucket rules with their tier and index", () => {
    const issues = validateValueTierRules(
      rules({ sell: [{ name: "broken", regex: "(" }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ tier: "sell", index: 0 });
  });
});
