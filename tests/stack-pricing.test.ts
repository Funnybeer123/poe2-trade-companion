import { describe, expect, it } from "vitest";
import { appraiseItem, stackCountOf } from "../src/core/appraisal.js";
import { parseItemText } from "../src/core/parseItem.js";
import { starterPriceTable, type PriceTable } from "../src/core/priceTable.js";
import { bucketFor, bucketTabs, defaultShopConfig, parseShopConfig } from "../src/core/shopListings.js";
import { stackBucketValue } from "../src/core/shopPricing.js";

/**
 * Stack pricing (docs/HANDOFF-shop-listings.md): whether SET ITEM PRICE
 * prices a currency stack as a whole or per unit is UNVERIFIED live. The
 * config picks the mode, the plan line says which, and the first live
 * stack listing is step-gated so the user reads the tooltip once.
 */

const STACK_TEXT = (count: number) =>
  [
    "Item Class: Stackable Currency",
    "Rarity: Currency",
    "Chaos Orb",
    "--------",
    `Stack Size: ${count}/20`,
    "--------",
    "Reforges a Rare item with new random modifiers",
  ].join("\n");

/** A table where a chaos orb is worth 0.26 ex, the handoff's own example. */
function table(): PriceTable {
  const base = starterPriceTable();
  return {
    ...base,
    entries: [
      ...base.entries,
      { id: "test-chaos", match: { name: "Chaos Orb" }, value: 0.26 },
      { id: "test-divine", match: { name: "Divine Orb" }, value: 40 },
    ],
  };
}

describe("stackCountOf", () => {
  it("reads the current stack size from the item's properties", () => {
    expect(stackCountOf(parseItemText(STACK_TEXT(20)))).toBe(20);
    expect(stackCountOf(parseItemText(STACK_TEXT(1)))).toBe(1);
    expect(stackCountOf(parseItemText("Item Class: Rings\nRarity: Rare\nDoom Loop\nGold Ring"))).toBeUndefined();
  });
});

describe("stackBucketValue", () => {
  const estimate = appraiseItem(STACK_TEXT(20), { priceTable: table() }).estimatedValue!;

  it("the appraisal itself is whole-stack (unit × count)", () => {
    expect(estimate).toMatchObject({ amount: 5.2, unitValue: 0.26, stackCount: 20, basis: "price-table-stack" });
  });

  it("buckets the whole stack under 'whole' and the orb under 'per-unit'", () => {
    const whole = stackBucketValue(estimate, "whole")!;
    expect(whole).toMatchObject({ value: 5.2, count: 20, unitValue: 0.26, mode: "whole", label: "STACK ×20 (whole)" });
    const perUnit = stackBucketValue(estimate, "per-unit")!;
    expect(perUnit).toMatchObject({ value: 0.26, mode: "per-unit", label: "STACK ×20 (per-unit)" });
  });

  it("lands the same 20-stack in 5Ex under 'whole' and under the floor under 'per-unit'", () => {
    const buckets = bucketTabs(["1Ex", "5Ex", "10Ex"], table());
    expect(bucketFor(stackBucketValue(estimate, "whole")!.value, buckets)?.label).toBe("5Ex");
    expect(bucketFor(stackBucketValue(estimate, "per-unit")!.value, buckets)).toBeUndefined();
  });

  it("returns undefined for single items and single-orb stacks", () => {
    expect(stackBucketValue({ amount: 3, unitValue: 3 }, "whole")).toBeUndefined();
    expect(stackBucketValue({ amount: 0.26, unitValue: 0.26, stackCount: 1 }, "whole")).toBeUndefined();
  });
});

describe("shop config: stackPricing + ladderWithoutComps", () => {
  it("defaults to whole-stack pricing and age-only laddering", () => {
    const config = defaultShopConfig();
    expect(config.stackPricing).toBe("whole");
    expect(config.ladderWithoutComps).toBe(true);
  });

  it("sanitizes both fields and reports a bad stackPricing value", () => {
    const good = parseShopConfig({ shopTab: "1Ex", stackPricing: "per-unit", ladderWithoutComps: false });
    expect(good.config.stackPricing).toBe("per-unit");
    expect(good.config.ladderWithoutComps).toBe(false);
    const bad = parseShopConfig({ shopTab: "1Ex", stackPricing: "each", ladderWithoutComps: "yes" });
    expect(bad.config.stackPricing).toBe("whole");
    expect(bad.config.ladderWithoutComps).toBe(true);
    expect(bad.issues.some((issue) => /stackPricing/.test(issue))).toBe(true);
  });
});
