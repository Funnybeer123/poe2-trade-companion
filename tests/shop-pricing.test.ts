import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import { starterPriceTable } from "../src/core/priceTable.js";
import { defaultShopConfig, type ActiveListing, type ListingEvent } from "../src/core/shopListings.js";
import {
  denominatePrice,
  estimateSaleProbability,
  isPriceRefusal,
  listingGate,
  percentileLowPrice,
  planEvictions,
  rankListingCandidates,
  repriceDecision,
  salesStats,
  suggestListingPrice,
  type PriceSuggestion,
} from "../src/core/shopPricing.js";
import type { CompsSummary } from "../src/core/tradeComps.js";

/**
 * The pricing policy behind docs/HANDOFF-shop-listings.md: low-percentile
 * anchors (never the minimum), troll-floor guards, the reprice ladder with
 * its delist floor, and the double gate (appraisal confidence AND usable
 * comps) in front of every auto-listing.
 */

const AT = "2026-09-02T10:00:00.000Z";
const NOW = Date.parse("2026-09-05T10:00:00.000Z");

function comps(prices: number[], overrides: Partial<CompsSummary> = {}): CompsSummary {
  const sorted = [...prices].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return {
    sampleSize: sorted.length,
    candidateCount: sorted.length,
    lowest: sorted[0],
    median,
    currency: "exalted",
    basis: "base-type",
    comps: sorted.map((price) => ({ price, similarity: 1, name: "", baseType: "Gold Ring" })),
    ...overrides,
  };
}

function config(overrides: Partial<ReturnType<typeof defaultShopConfig>> = {}) {
  return { ...defaultShopConfig(), shopTab: "Shop", ...overrides };
}

function appListing(overrides: Partial<ActiveListing> = {}): ActiveListing {
  return {
    fingerprint: "f1",
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    price: { amount: 10, currency: "exalted", exalted: 10 },
    listedAt: "2026-09-01T10:00:00.000Z",
    pricedAt: "2026-09-01T10:00:00.000Z",
    lastEventAt: "2026-09-01T10:00:00.000Z",
    by: "app",
    ...overrides,
  };
}

describe("percentile anchor", () => {
  it("uses the Nth-lowest comparable, never the minimum", () => {
    expect(percentileLowPrice([1, 5, 6, 7, 8, 9, 10, 12], 25)).toBe(5);
    expect(percentileLowPrice([4], 25)).toBe(4);
    expect(percentileLowPrice([], 25)).toBeUndefined();
  });
});

describe("denomination", () => {
  it("prices in whole exalted below the divine rate and divines above", () => {
    const table = starterPriceTable(); // divine = 40 exalted
    expect(denominatePrice(7.4, table)).toEqual({ amount: 7, currency: "exalted", exalted: 7 });
    expect(denominatePrice(85, table)).toEqual({ amount: 2, currency: "divine", exalted: 80 });
    expect(denominatePrice(0.4, table)).toEqual({ amount: 1, currency: "exalted", exalted: 1 });
  });
});

describe("suggestListingPrice", () => {
  it("undercuts the low-percentile comp", () => {
    const suggestion = suggestListingPrice(comps([10, 11, 12, 13]), config(), { at: AT });
    expect(isPriceRefusal(suggestion)).toBe(false);
    if (!isPriceRefusal(suggestion)) {
      // 25th percentile of 4 = the lowest (10); minus 5% = 9.5 → 10 exalted display.
      expect(suggestion.targetExalted).toBe(9.5);
      expect(suggestion.display).toMatchObject({ amount: 10, currency: "exalted" });
      expect(suggestion.comps.anchorExalted).toBe(10);
    }
  });

  it("refuses tiny samples", () => {
    const suggestion = suggestListingPrice(comps([10, 12]), config(), { at: AT });
    expect(suggestion).toMatchObject({ refusal: "sample-too-small" });
  });

  it("guards against a troll floor by pulling the anchor toward the median", () => {
    const wide = comps([1, 38, 40, 42, 44], {
      caution: "Floor (1 ex) sits far under the median (40 ex) — trust the median.",
    });
    const suggestion = suggestListingPrice(wide, config(), { at: AT });
    expect(isPriceRefusal(suggestion)).toBe(false);
    if (!isPriceRefusal(suggestion)) {
      expect(suggestion.comps.anchorExalted).toBeGreaterThanOrEqual(20);
      expect(suggestion.cautions.length).toBeGreaterThan(0);
    }
  });

  it("refuses when the target lands under the listing floor", () => {
    const suggestion = suggestListingPrice(comps([0.4, 0.5, 0.6]), config(), { at: AT });
    expect(suggestion).toMatchObject({ refusal: "below-floor" });
  });
});

describe("reprice ladder", () => {
  function suggestionAt(target: number): PriceSuggestion {
    return {
      targetExalted: target,
      display: { amount: Math.max(1, Math.round(target)), currency: "exalted", exalted: Math.max(1, Math.round(target)) },
      comps: { at: AT, basis: "base-type", sampleSize: 5, candidateCount: 5, anchorExalted: target },
      cautions: [],
    };
  }

  it("holds a fresh listing", () => {
    const decision = repriceDecision({
      listing: appListing({ pricedAt: "2026-09-04T10:00:00.000Z" }),
      suggestion: suggestionAt(8),
      config: config(),
      nowMs: NOW,
    });
    expect(decision.action).toBe("hold");
    expect(decision.badges).not.toContain("STALE");
  });

  it("steps a stale listing down when the market moved", () => {
    const decision = repriceDecision({
      listing: appListing(), // priced 4 days before NOW
      suggestion: suggestionAt(5),
      config: config(),
      nowMs: NOW,
    });
    expect(decision.badges).toContain("STALE");
    expect(decision.action).toBe("reprice");
    // 10 ex stepped by the first ladder rung (-8%) = 9.2 → but never below
    // the suggestion; display rounds to whole exalted.
    expect(decision.to).toMatchObject({ currency: "exalted", amount: 9 });
  });

  it("holds a stale listing whose comps still support the price", () => {
    const decision = repriceDecision({
      listing: appListing(),
      suggestion: suggestionAt(11),
      config: config(),
      nowMs: NOW,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.some((reason) => /market did not move/.test(reason))).toBe(true);
  });

  it("reprices UP when comps sit far above the listing", () => {
    const decision = repriceDecision({
      listing: appListing({ pricedAt: "2026-09-04T10:00:00.000Z" }),
      suggestion: suggestionAt(20),
      config: config(),
      nowMs: NOW,
    });
    expect(decision.badges).toContain("UNDERPRICED");
    expect(decision.action).toBe("reprice");
    expect(decision.to?.amount).toBe(20);
  });

  it("delists at the floor instead of racing to zero", () => {
    const decision = repriceDecision({
      listing: appListing({ price: { amount: 1, currency: "exalted", exalted: 1 } }),
      suggestion: suggestionAt(0.3),
      config: config({ minListExalted: 0 }),
      nowMs: NOW,
    });
    expect(decision.action).toBe("delist");
  });

  it("never touches a user-priced listing", () => {
    const decision = repriceDecision({
      listing: appListing({ by: "user" }),
      suggestion: suggestionAt(2),
      config: config(),
      nowMs: NOW,
    });
    expect(decision.action).toBe("hold");
    expect(decision.badges).toContain("USER-PRICED");
  });

  it("holds rather than guessing when comps are unusable", () => {
    const decision = repriceDecision({
      listing: appListing(),
      suggestion: { refusal: "sample-too-small", detail: "1 comparable(s), need 3" },
      config: config(),
      nowMs: NOW,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.some((reason) => /comps unusable/.test(reason))).toBe(true);
  });
});

describe("auto-list gate", () => {
  const CURRENCY_TEXT = [
    "Item Class: Stackable Currency",
    "Rarity: Currency",
    "Divine Orb",
    "--------",
    "Stack Size: 1/20",
  ].join("\n");
  const strongAppraisal = appraiseItem(CURRENCY_TEXT, { priceTable: starterPriceTable() });

  it("demands BOTH appraisal confidence and usable comps", () => {
    expect(strongAppraisal.confidence).toBeGreaterThanOrEqual(60);
    const noComps = listingGate({
      appraisal: strongAppraisal,
      tier: "sell",
      config: config(),
      at: AT,
    });
    expect(noComps).toMatchObject({ ok: false });

    const lowConfidence = listingGate({
      appraisal: { ...strongAppraisal, confidence: 30 },
      tier: "sell",
      comps: comps([10, 11, 12, 13]),
      config: config(),
      at: AT,
    });
    expect(lowConfidence).toMatchObject({ ok: false });

    const both = listingGate({
      appraisal: strongAppraisal,
      tier: "sell",
      comps: comps([10, 11, 12, 13]),
      config: config(),
      at: AT,
      priceTable: starterPriceTable(),
    });
    expect(both.ok).toBe(true);
  });

  it("never lists keep-tier or dump-tier items", () => {
    for (const tier of ["keep", "dump"] as const) {
      const result = listingGate({
        appraisal: strongAppraisal,
        tier,
        comps: comps([10, 11, 12, 13]),
        config: config(),
        at: AT,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("flags estimates above the cap for per-item confirmation", () => {
    const result = listingGate({
      appraisal: strongAppraisal,
      tier: "sell",
      comps: comps([100, 110, 120, 130]),
      config: config(), // cap = 1 divine = 40 exalted in the starter table
      at: AT,
      priceTable: starterPriceTable(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.needsConfirmation).toMatch(/cap/);
  });
});

describe("slot economics", () => {
  const soldHistory: ListingEvent[] = [
    {
      at: "2026-08-20T00:00:00.000Z",
      kind: "listed",
      fingerprint: "h1",
      name: "Old Ring",
      itemClass: "Rings",
      count: 4,
      by: "app",
      certainty: "verified",
    },
    {
      at: "2026-08-24T00:00:00.000Z",
      kind: "sold",
      fingerprint: "h1",
      name: "Old Ring",
      itemClass: "Rings",
      count: 3,
      by: "unknown",
      certainty: "heuristic",
      realized: { amount: 5, currency: "exalted", exalted: 5 },
    },
    {
      at: "2026-08-28T00:00:00.000Z",
      kind: "delisted",
      fingerprint: "h1",
      name: "Old Ring",
      itemClass: "Rings",
      count: 1,
      by: "app",
      certainty: "verified",
    },
  ];

  it("summarizes realized sales per class", () => {
    const stats = salesStats(soldHistory);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      itemClass: "Rings",
      listed: 4,
      sold: 3,
      delisted: 1,
      realizedExalted: 15,
      medianDaysToSale: 4,
    });
  });

  it("classes that actually sell rank higher", () => {
    const stats = salesStats(soldHistory);
    const withHistory = estimateSaleProbability(5, stats[0]);
    const without = estimateSaleProbability(5);
    expect(withHistory).toBeGreaterThan(without);
  });

  function candidate(name: string, exalted: number, cellCount = 1) {
    return {
      fingerprint: name,
      name,
      itemClass: "Rings",
      cellCount,
      suggestion: {
        targetExalted: exalted,
        display: { amount: exalted, currency: "exalted", exalted },
        comps: { at: AT, basis: "base-type", sampleSize: 5, candidateCount: 5 },
        cautions: [],
      },
    };
  }

  it("ranks candidates by expected value", () => {
    const ranked = rankListingCandidates([candidate("cheap", 2), candidate("rich", 30)]);
    expect(ranked[0]!.name).toBe("rich");
    expect(ranked[0]!.expectedValue).toBeGreaterThan(ranked[1]!.expectedValue);
  });

  it("evicts only clearly-worse stale app listings, and reports every eviction", () => {
    const stale = appListing({ price: { amount: 2, currency: "exalted", exalted: 2 } });
    const fresh = appListing({
      fingerprint: "f2",
      pricedAt: "2026-09-05T00:00:00.000Z",
      listedAt: "2026-09-05T00:00:00.000Z",
    });
    const userOwned = appListing({ fingerprint: "f3", by: "user" });
    const ranked = rankListingCandidates([candidate("rich", 30)]);
    const plan = planEvictions({
      active: [stale, fresh, userOwned],
      candidates: ranked,
      freeCells: 0,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.evict).toEqual([stale]);
    expect(plan.admitted).toHaveLength(1);
    expect(plan.report).toHaveLength(1);
    expect(plan.report[0]).toMatch(/evicting stale/);
  });

  it("admits nothing when the shop is full of protected listings", () => {
    const userOwned = appListing({ by: "user" });
    const ranked = rankListingCandidates([candidate("rich", 30)]);
    const plan = planEvictions({
      active: [userOwned],
      candidates: ranked,
      freeCells: 0,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.admitted).toHaveLength(0);
    expect(plan.evict).toHaveLength(0);
  });
});

describe("magic item base type for comps", () => {
  it("derives the base from the single magic header line", async () => {
    const { magicBaseType, buildCompsQuery } = await import("../src/core/tradeComps.js");
    const { parseItemText } = await import("../src/core/parseItem.js");
    expect(magicBaseType("Entombing Bandit Mace of the Champion")).toBe("Bandit Mace");
    expect(magicBaseType("Bandit Mace of the Champion")).toBe("Bandit Mace");
    expect(magicBaseType("Flaming Adherent Bow of the Parched")).toBe("Adherent Bow");
    expect(magicBaseType("Entombing Bandit Mace")).toBe("Bandit Mace");
    const parsed = parseItemText(
      ["Item Class: One Hand Maces", "Rarity: Magic", "Entombing Bandit Mace of the Champion", "--------", "Item Level: 70"].join("\n"),
    );
    const query = buildCompsQuery(parsed);
    expect((query?.body as { query: { type: string } }).query.type).toBe("Bandit Mace");
  });
});

describe("floor vs undercut", () => {
  it("lists at the floor when the comps sit exactly at it, vendors only below it", () => {
    const atFloor = suggestListingPrice(comps([1, 1, 1, 2]), config(), { at: AT });
    expect(isPriceRefusal(atFloor)).toBe(false);
    if (!isPriceRefusal(atFloor)) {
      expect(atFloor.targetExalted).toBe(1);
      expect(atFloor.display).toMatchObject({ amount: 1, currency: "exalted" });
    }
    expect(suggestListingPrice(comps([0.4, 0.5, 0.6]), config(), { at: AT })).toMatchObject({ refusal: "below-floor" });
  });
});
