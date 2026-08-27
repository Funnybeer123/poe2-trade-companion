import {
  DEFAULT_PRICE_POLICY,
  formatListingPrice,
  isListingStale,
  isMarketThrottled,
  listingPriceMatchesText,
  meetsMinConfidence,
  parsePriceText,
  recommendListingPrice,
  resolvePricePolicy,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const quote = {
  providerId: "fixture",
  quotedAtMs: 10_000,
  currency: "divine",
  low: 12,
  fair: 15,
  high: 18,
  confidence: "high" as const,
};

describe("listing price policy", () => {
  it("recommends fair * (1 - undercutPct) and never a guaranteed sale", () => {
    const result = recommendListingPrice(quote);
    expect("skip" in result && result.skip).toBe(false);
    if ("skip" in result) {
      return;
    }
    expect(result.price).toBe(14.55);
    expect(result.currency).toBe("divine");
    expect(result.source).toBe("fair-undercut");
    expect(result.isGuaranteedSalePrice).toBe(false);
    expect(result.fair).toBe(15);
    expect(DEFAULT_PRICE_POLICY.undercutPct).toBe(0.03);
    expect(DEFAULT_PRICE_POLICY.markupPct).toBe(0);
    expect(DEFAULT_PRICE_POLICY.minConfidence).toBe("medium");
    expect(DEFAULT_PRICE_POLICY.staleAfterMs).toBe(6 * 60 * 60 * 1000);
  });

  it("floors the recommendation at low when undercut would go below it", () => {
    const result = recommendListingPrice({ ...quote, low: 14.6 });
    expect("skip" in result && result.skip).toBe(false);
    if ("skip" in result) {
      return;
    }
    expect(result.price).toBe(14.6);
    expect(result.source).toBe("low-floor");
    expect(result.isGuaranteedSalePrice).toBe(false);
  });

  it("applies minPrice after the low floor", () => {
    const result = recommendListingPrice(quote, resolvePricePolicy({ minPrice: 16 }));
    expect("skip" in result && result.skip).toBe(false);
    if ("skip" in result) {
      return;
    }
    expect(result.price).toBe(16);
    expect(result.source).toBe("min-price");
  });

  it("skips when fair is missing", () => {
    const result = recommendListingPrice({ ...quote, fair: undefined });
    expect(result).toMatchObject({ skip: true, isGuaranteedSalePrice: false });
  });

  it("detects stale listings after the configured window", () => {
    expect(isListingStale(undefined, 10_000)).toBe(false);
    expect(isListingStale(10_000, 10_000 + 6 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(isListingStale(10_000, 10_000 + 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("treats medium as the default minimum confidence", () => {
    expect(meetsMinConfidence("high", "medium")).toBe(true);
    expect(meetsMinConfidence("medium", "medium")).toBe(true);
    expect(meetsMinConfidence("low", "medium")).toBe(false);
    expect(meetsMinConfidence("none", "medium")).toBe(false);
  });

  it("parses listing UI price text and matches the recommendation", () => {
    expect(parsePriceText("14.55 divine")).toEqual({ price: 14.55, currency: "divine" });
    expect(formatListingPrice(14.55)).toBe("14.55");
    expect(listingPriceMatchesText("14.55 divine", 14.55, "divine")).toBe(true);
    expect(listingPriceMatchesText("20 divine", 14.55, "divine")).toBe(false);
  });

  it("recognizes market 429 / throttle reasons", () => {
    expect(isMarketThrottled({ confidence: "none", lowConfidenceReason: "http-429" })).toBe(true);
    expect(isMarketThrottled({ confidence: "high", lowConfidenceReason: undefined })).toBe(false);
  });
});
