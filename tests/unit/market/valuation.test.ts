import { LOCKED_OUTLIER_METHOD, tukeyInliers, valueFromPrices, type NormalizedItem } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const item: NormalizedItem = {
  fingerprint: "test",
  name: "Divine Orb",
  rarity: "currency",
  modifiers: [],
  pseudos: {},
};

describe("Tukey 1.5 IQR outlier drop", () => {
  it("locks tukey-1.5-iqr and drops a high outlier", () => {
    expect(LOCKED_OUTLIER_METHOD).toBe("tukey-1.5-iqr");
    const prices = [10, 11, 12, 12, 13, 14, 100];
    const { inliers, outlierFlags } = tukeyInliers(prices);
    expect(outlierFlags[6]).toBe(true);
    expect(inliers).toEqual([10, 11, 12, 12, 13, 14]);
    expect(inliers).not.toContain(100);
  });

  it("does not flag outliers when the sample is smaller than 4", () => {
    expect(tukeyInliers([1, 50, 2]).outlierFlags).toEqual([false, false, false]);
  });

  it("builds a valuation that is never a guaranteed sale price", () => {
    const valuation = valueFromPrices(item, {
      providerId: "fixture",
      quotedAtMs: 1_000,
      currency: "exalted",
      points: [
        { id: "a", price: 10, currency: "exalted" },
        { id: "b", price: 11, currency: "exalted" },
        { id: "c", price: 12, currency: "exalted" },
        { id: "d", price: 13, currency: "exalted" },
        { id: "e", price: 100, currency: "exalted" },
      ],
    });
    expect(valuation.isGuaranteedSalePrice).toBe(false);
    expect(valuation.outlierMethod).toBe("tukey-1.5-iqr");
    expect(valuation.quote.providerId).toBe("fixture");
    expect(valuation.quote.quotedAtMs).toBe(1_000);
    expect(valuation.quote.candidateCount).toBe(5);
    expect(valuation.quote.comparableCount).toBe(4);
    expect(valuation.quote.low).toBeDefined();
    expect(valuation.quote.fair).toBeDefined();
    expect(valuation.quote.high).toBeDefined();
    expect(valuation.quote.recommendedListing).toBe(valuation.quote.fair);
    expect(valuation.quote.confidence).toBe("medium");
    expect(valuation.quote.comparables.filter((row) => row.outlier)).toHaveLength(1);
    expect(JSON.stringify(valuation)).not.toMatch(/guaranteed sale price/i);
  });
});
