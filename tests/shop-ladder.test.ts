import { describe, expect, it } from "vitest";
import { starterPriceTable, type PriceTable } from "../src/core/priceTable.js";
import { bucketTabs, defaultShopConfig, type ActiveListing, type ShopConfig } from "../src/core/shopListings.js";
import { bucketOfPrice, planBucketLadder, type PriceSuggestion } from "../src/core/shopPricing.js";

/**
 * The bucket ladder (docs/HANDOFF-shop-listings.md, PRICE-BUCKET TABS): the
 * tab name is the price, so a stale app listing steps DOWN by moving to a
 * cheaper bucket. Every hold and move is reported; user-priced listings
 * never move.
 */

const TABLE: PriceTable = {
  ...starterPriceTable(),
  entries: [
    ...starterPriceTable().entries,
    // Pinned explicitly: the starter table no longer ships placeholder rates.
    { id: "test-divine", match: { name: "Divine Orb" }, value: 40 },
    { id: "test-chaos", match: { name: "Chaos Orb" }, value: 0.5 },
  ],
};
const BUCKETS = bucketTabs(["1Ex", "5Ex", "10Ex", "1D", "2D"], TABLE); // 1, 5, 10, 40, 80 ex
const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

function config(overrides: Partial<ShopConfig> = {}): ShopConfig {
  return { ...defaultShopConfig(), shopTab: "1Ex", bucketTabs: ["1Ex", "5Ex", "10Ex", "1D", "2D"], ...overrides };
}

function listing(overrides: Partial<ActiveListing> = {}): ActiveListing {
  return {
    fingerprint: "f1",
    name: "Doom Loop",
    itemClass: "Rings",
    count: 1,
    price: { amount: 10, currency: "exalted", exalted: 10 },
    listedAt: daysAgo(4),
    pricedAt: daysAgo(4),
    lastEventAt: daysAgo(4),
    by: "app",
    ...overrides,
  };
}

function suggestionAt(target: number): PriceSuggestion {
  return {
    targetExalted: target,
    display: { amount: Math.max(1, Math.round(target)), currency: "exalted", exalted: Math.max(1, Math.round(target)) },
    comps: { at: daysAgo(0), basis: "base-type", sampleSize: 5, candidateCount: 5, anchorExalted: target },
    cautions: [],
  };
}

describe("bucketOfPrice", () => {
  it("matches a ledger price to its bucket by amount and folded currency", () => {
    expect(bucketOfPrice({ amount: 1, currency: "div" }, BUCKETS)?.label).toBe("1D");
    expect(bucketOfPrice({ amount: 5, currency: "exalted" }, BUCKETS)?.label).toBe("5Ex");
    expect(bucketOfPrice({ amount: 3, currency: "exalted" }, BUCKETS)).toBeUndefined();
    expect(bucketOfPrice(undefined, BUCKETS)).toBeUndefined();
  });
});

describe("planBucketLadder", () => {
  it("moves a stale app listing one bucket down after the first step (age alone, no comps)", () => {
    const plan = planBucketLadder({ listings: [listing()], buckets: BUCKETS, config: config(), nowMs: NOW });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ from: { label: "10Ex" }, to: { label: "5Ex" } });
    expect(plan.moves[0]!.reasons[0]).toMatch(/no comps, age alone/);
    expect(plan.report).toHaveLength(1);
    expect(plan.report[0]).toMatch(/^move 1x Doom Loop/);
  });

  it("snaps to the stepped-down value once several steps have passed", () => {
    // 2D (80 ex) priced 7 days ago: second step (-12%) → 70.4 → dearest bucket ≤ 70.4 = 1D.
    const plan = planBucketLadder({
      listings: [listing({ price: { amount: 2, currency: "divine", exalted: 80 }, pricedAt: daysAgo(7) })],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.moves[0]).toMatchObject({ from: { label: "2D" }, to: { label: "1D" } });
    // A huge second step lands under 10Ex → the % rule snaps two buckets down.
    const steep = planBucketLadder({
      listings: [listing({ price: { amount: 2, currency: "divine", exalted: 80 }, pricedAt: daysAgo(7) })],
      buckets: BUCKETS,
      config: config({ ladder: [{ afterDays: 3, stepPercent: 8 }, { afterDays: 6, stepPercent: 90 }] }),
      nowMs: NOW,
    });
    expect(steep.moves[0]!.to.label).toBe("5Ex");
  });

  it("never drops more than one bucket on the first step, whatever the percent", () => {
    const plan = planBucketLadder({
      listings: [listing({ price: { amount: 1, currency: "divine", exalted: 40 } })],
      buckets: BUCKETS,
      config: config({ ladder: [{ afterDays: 3, stepPercent: 90 }] }),
      nowMs: NOW,
    });
    expect(plan.moves[0]).toMatchObject({ from: { label: "1D" }, to: { label: "10Ex" } });
  });

  it("holds before the first ladder step, at the cheapest bucket, and off-bucket prices", () => {
    const plan = planBucketLadder({
      listings: [
        listing({ fingerprint: "fresh", name: "Fresh", pricedAt: daysAgo(1) }),
        listing({ fingerprint: "floor", name: "Floor", price: { amount: 1, currency: "exalted", exalted: 1 } }),
        listing({ fingerprint: "odd", name: "Odd", price: { amount: 3, currency: "exalted", exalted: 3 } }),
        listing({ fingerprint: "none", name: "None", price: undefined }),
      ],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.holds.map((hold) => hold.reasons[0])).toEqual([
      expect.stringMatching(/before the first ladder step/),
      expect.stringMatching(/already in the cheapest bucket/),
      expect.stringMatching(/not a bucket price/),
      expect.stringMatching(/no price on the ledger record/),
    ]);
    expect(plan.holds[3]!.badges).toContain("UNPRICED");
    expect(plan.report).toHaveLength(4);
  });

  it("never moves user-priced listings", () => {
    const plan = planBucketLadder({
      listings: [listing({ by: "user" }), listing({ fingerprint: "u2", by: "unknown" })],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.holds.every((hold) => hold.badges.includes("USER-PRICED"))).toBe(true);
  });

  it("holds when comps still support the current bucket (market did not move)", () => {
    const plan = planBucketLadder({
      listings: [listing()],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
      compsFor: () => suggestionAt(11),
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.holds[0]!.reasons[0]).toMatch(/market did not move/);
  });

  it("moves with comps as the floor when the market moved", () => {
    const plan = planBucketLadder({
      listings: [listing({ price: { amount: 1, currency: "divine", exalted: 40 }, pricedAt: daysAgo(7) })],
      buckets: BUCKETS,
      config: config({ ladder: [{ afterDays: 3, stepPercent: 8 }, { afterDays: 6, stepPercent: 90 }] }),
      nowMs: NOW,
      compsFor: () => suggestionAt(8),
    });
    // -90% would land at 4 ex → 1Ex, but the comps floor (8 ex) keeps it at 5Ex.
    expect(plan.moves[0]).toMatchObject({ from: { label: "1D" }, to: { label: "5Ex" } });
    expect(plan.moves[0]!.reasons[0]).toMatch(/comps floor 8 ex/);
  });

  it("with ladderWithoutComps off, no comps (or unusable comps) means hold", () => {
    const off = config({ ladderWithoutComps: false });
    const noComps = planBucketLadder({ listings: [listing()], buckets: BUCKETS, config: off, nowMs: NOW });
    expect(noComps.moves).toHaveLength(0);
    expect(noComps.holds[0]!.reasons[0]).toMatch(/ladderWithoutComps is off/);
    const refused = planBucketLadder({
      listings: [listing()],
      buckets: BUCKETS,
      config: off,
      nowMs: NOW,
      compsFor: () => ({ refusal: "sample-too-small", detail: "1 comparable(s), need 3" }),
    });
    expect(refused.holds[0]!.reasons[0]).toMatch(/comps unusable/);
    // With the default (on), a refusal falls back to age alone.
    const on = planBucketLadder({
      listings: [listing()],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
      compsFor: () => ({ refusal: "no-comps", detail: "no priced comparable listings" }),
    });
    expect(on.moves).toHaveLength(1);
  });

  it("caps the moves at maxActionsPerRun and reports the cap", () => {
    const listings = Array.from({ length: 4 }, (_, index) => listing({ fingerprint: `f${index}`, name: `Item ${index}` }));
    const plan = planBucketLadder({ listings, buckets: BUCKETS, config: config({ maxActionsPerRun: 2 }), nowMs: NOW });
    expect(plan.moves).toHaveLength(2);
    expect(plan.report[plan.report.length - 1]).toMatch(/capped at 2/);
  });

  it("flags STALE on every listing past the stale threshold, held or moved", () => {
    const plan = planBucketLadder({
      listings: [listing({ by: "user" })],
      buckets: BUCKETS,
      config: config(),
      nowMs: NOW,
    });
    expect(plan.holds[0]!.badges).toEqual(["STALE", "USER-PRICED"]);
  });
});
