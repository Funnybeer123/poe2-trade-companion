import {
  PRICE_ESTIMATE_LABEL,
  formatPriceEstimate,
  priceDisplayMentionsGuarantee,
  type MarketQuote,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const quote: MarketQuote = {
  providerId: "fixture",
  quotedAtMs: 1_756_245_600_000,
  currency: "divine",
  low: 12,
  fair: 15,
  high: 18,
  recommendedListing: 14.55,
  candidateCount: 8,
  comparableCount: 7,
  confidence: "high",
  comparables: [],
};

describe("price formatting", () => {
  it("shows an estimate, not a guaranteed sale price", () => {
    const display = formatPriceEstimate(quote);
    expect(display.isGuaranteedSalePrice).toBe(false);
    expect(display.label).toBe(PRICE_ESTIMATE_LABEL);
    expect(display.summary).toMatch(/estimate/i);
    expect(display.summary).toMatch(/not a guaranteed sale price/i);
    expect(display.fair).toBe(15);
    expect(display.comparableCount).toBe(7);
    expect(display.candidateCount).toBe(8);
    expect(priceDisplayMentionsGuarantee(display.summary)).toBe(false);
    expect(priceDisplayMentionsGuarantee(display.label)).toBe(false);
  });
});
