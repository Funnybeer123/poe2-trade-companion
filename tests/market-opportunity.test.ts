import { describe, expect, it } from "vitest";
import { analyzeMarketOpportunity } from "../src/core/marketOpportunity.js";
import type { ValuationResult } from "../src/core/types.js";

function valuation(overrides: Partial<ValuationResult> = {}): ValuationResult {
  return {
    itemIdentifier: "test-ring",
    itemType: "Rings",
    normalizedKeyStats: {},
    providerName: "fixture",
    marketTimestamp: "2026-08-26T05:00:00.000Z",
    candidateCount: 10,
    comparablesUsed: 8,
    low: 80,
    fair: 100,
    high: 120,
    recommendedListing: 95,
    currency: "exalted",
    confidence: "high",
    ...overrides,
  };
}

describe("market opportunity analysis", () => {
  it("calculates potential profit after estimated costs", () => {
    const result = analyzeMarketOpportunity({
      valuation: valuation(),
      acquisitionPrice: 50,
      feeRatePercent: 5,
      nowMs: Date.parse("2026-08-26T05:10:00.000Z"),
    });

    expect(result).toMatchObject({
      resaleEstimate: 95,
      estimatedFees: 4.75,
      totalCost: 54.75,
      estimatedProfit: 40.25,
      returnPercent: 73.52,
      sampleSize: 8,
      candidateCount: 10,
      isStale: false,
      verdict: "strong",
    });
  });

  it("downgrades profitable stale opportunities and warns the user", () => {
    const result = analyzeMarketOpportunity({
      valuation: valuation(),
      acquisitionPrice: 50,
      nowMs: Date.parse("2026-08-26T06:00:01.000Z"),
    });

    expect(result.verdict).toBe("watch");
    expect(result.isStale).toBe(true);
    expect(result.warnings).toContain(
      "Market data is stale or has an invalid timestamp; refresh before acting.",
    );
  });

  it("does not promote thin or missing comparable samples", () => {
    const thin = analyzeMarketOpportunity({
      valuation: valuation({
        confidence: "low",
        comparablesUsed: 2,
        lowConfidenceReason: "very few comparables",
      }),
      acquisitionPrice: 50,
      nowMs: Date.parse("2026-08-26T05:10:00.000Z"),
    });
    const missing = analyzeMarketOpportunity({
      valuation: valuation({
        confidence: "none",
        candidateCount: 0,
        comparablesUsed: 0,
        recommendedListing: 0,
        lowConfidenceReason: "no comparables",
      }),
      acquisitionPrice: 50,
      nowMs: Date.parse("2026-08-26T05:10:00.000Z"),
    });

    expect(thin.verdict).toBe("watch");
    expect(thin.warnings).toContain("Low confidence: very few comparables.");
    expect(missing.verdict).toBe("insufficient-data");
  });

  it("marks an estimated loss as a skip", () => {
    const result = analyzeMarketOpportunity({
      valuation: valuation(),
      acquisitionPrice: 100,
      feeRatePercent: 2,
      nowMs: Date.parse("2026-08-26T05:10:00.000Z"),
    });

    expect(result.estimatedProfit).toBeLessThan(0);
    expect(result.verdict).toBe("skip");
    expect(result.warnings).toContain(
      "Estimated costs meet or exceed the suggested resale price.",
    );
  });

  it("rejects invalid acquisition and fee inputs", () => {
    expect(() =>
      analyzeMarketOpportunity({ valuation: valuation(), acquisitionPrice: 0 }),
    ).toThrow("acquisitionPrice must be greater than zero");
    expect(() =>
      analyzeMarketOpportunity({
        valuation: valuation(),
        acquisitionPrice: 50,
        feeRatePercent: -1,
      }),
    ).toThrow("feeRatePercent cannot be negative");
  });
});
