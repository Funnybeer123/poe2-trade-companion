import { DEFAULT_SORT_RULES, matchSortRule, ruleMatches } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("sortRules", () => {
  it("matches currency class before high-value category", () => {
    const rule = matchSortRule({
      class: "Currency",
      category: "HighValueSell",
      score: 95,
    });
    expect(rule?.id).toBe("currency-class");
    expect(rule?.tabId).toBe("currency");
    expect(rule?.fallbackTabId).toBe("dump");
  });

  it("matches unique rarity to the uniques tab", () => {
    const rule = matchSortRule({ rarity: "Unique", category: "KeepUse", score: 70 });
    expect(rule?.bucket).toBe("Uniques");
    expect(rule?.tabId).toBe("uniques");
  });

  it("matches desirability categories to product-spec destinations", () => {
    expect(matchSortRule({ category: "HighValueSell" })?.tabId).toBe("high-value-sell");
    expect(matchSortRule({ category: "Sell" })?.tabId).toBe("normal-sell");
    expect(matchSortRule({ category: "CraftCandidate" })?.tabId).toBe("crafting");
    expect(matchSortRule({ category: "BulkCommodity" })?.tabId).toBe("bulk");
    expect(matchSortRule({ category: "VendorLowValue" })?.tabId).toBe("vendor");
    expect(matchSortRule({ category: "Dump" })?.tabId).toBe("dump");
  });

  it("does not match KeepUse or ManualReview on default rules", () => {
    expect(matchSortRule({ category: "KeepUse", class: "Body Armours" })).toBeUndefined();
    expect(matchSortRule({ category: "ManualReview" })).toBeUndefined();
  });

  it("requires every declared constraint to match", () => {
    const rule = DEFAULT_SORT_RULES.find((entry) => entry.id === "currency-class");
    expect(rule).toBeDefined();
    if (rule === undefined) {
      return;
    }
    expect(ruleMatches(rule, { class: "Currency" })).toBe(true);
    expect(ruleMatches(rule, { class: "Waystone" })).toBe(false);
  });
});
