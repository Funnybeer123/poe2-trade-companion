import type { ConfidenceBucket, ValuationResult } from "./types.js";

export const DEFAULT_MARKET_STALE_AFTER_MS = 30 * 60 * 1_000;

export type OpportunityVerdict = "strong" | "watch" | "skip" | "insufficient-data";

export interface MarketOpportunityInput {
  valuation: ValuationResult;
  acquisitionPrice: number;
  feeRatePercent?: number;
  nowMs?: number;
  staleAfterMs?: number;
}

export interface MarketOpportunity {
  currency: string;
  acquisitionPrice: number;
  resaleEstimate: number;
  estimatedFees: number;
  totalCost: number;
  estimatedProfit: number;
  returnPercent: number;
  confidence: ConfidenceBucket;
  candidateCount: number;
  sampleSize: number;
  marketTimestamp: string;
  isStale: boolean;
  verdict: OpportunityVerdict;
  warnings: string[];
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

export function analyzeMarketOpportunity(input: MarketOpportunityInput): MarketOpportunity {
  const {
    valuation,
    acquisitionPrice,
    feeRatePercent = 0,
    nowMs = Date.now(),
    staleAfterMs = DEFAULT_MARKET_STALE_AFTER_MS,
  } = input;

  if (!Number.isFinite(acquisitionPrice) || acquisitionPrice <= 0) {
    throw new RangeError("acquisitionPrice must be greater than zero");
  }
  if (!Number.isFinite(feeRatePercent) || feeRatePercent < 0) {
    throw new RangeError("feeRatePercent cannot be negative");
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new RangeError("staleAfterMs cannot be negative");
  }

  const resaleEstimate = valuation.recommendedListing;
  const estimatedFees = round(resaleEstimate * (feeRatePercent / 100));
  const totalCost = round(acquisitionPrice + estimatedFees);
  const estimatedProfit = round(resaleEstimate - totalCost);
  const returnPercent = totalCost > 0 ? round((estimatedProfit / totalCost) * 100) : 0;
  const timestampMs = Date.parse(valuation.marketTimestamp);
  const isStale =
    !Number.isFinite(timestampMs) ||
    timestampMs > nowMs + 60_000 ||
    nowMs - timestampMs > staleAfterMs;
  const warnings: string[] = [];

  if (isStale) {
    warnings.push("Market data is stale or has an invalid timestamp; refresh before acting.");
  }
  if (valuation.confidence === "low" || valuation.confidence === "none") {
    warnings.push(
      valuation.lowConfidenceReason
        ? `Low confidence: ${valuation.lowConfidenceReason}.`
        : "Low confidence: the comparable sample is too small.",
    );
  }
  if (estimatedProfit <= 0) {
    warnings.push("Estimated costs meet or exceed the suggested resale price.");
  }

  let verdict: OpportunityVerdict;
  if (valuation.comparablesUsed === 0 || valuation.confidence === "none") {
    verdict = "insufficient-data";
  } else if (estimatedProfit <= 0) {
    verdict = "skip";
  } else if (isStale || valuation.confidence === "low" || returnPercent < 15) {
    verdict = "watch";
  } else {
    verdict = "strong";
  }

  return {
    currency: valuation.currency,
    acquisitionPrice: round(acquisitionPrice),
    resaleEstimate: round(resaleEstimate),
    estimatedFees,
    totalCost,
    estimatedProfit,
    returnPercent,
    confidence: valuation.confidence,
    candidateCount: valuation.candidateCount,
    sampleSize: valuation.comparablesUsed,
    marketTimestamp: valuation.marketTimestamp,
    isStale,
    verdict,
    warnings,
  };
}
