import { formatListingPrice, recommendListingPrice } from "../listing/pricePolicy.js";
import type { MarketQuote, ValuationResult } from "../items/types.js";

export const PRICE_ESTIMATE_LABEL = "Estimated value (not a guaranteed sale price)";

export interface PriceEstimateDisplay {
  label: typeof PRICE_ESTIMATE_LABEL;
  isGuaranteedSalePrice: false;
  providerId: string;
  quotedAtMs: number;
  currency: string;
  low?: number;
  fair?: number;
  high?: number;
  recommendedListing?: number;
  candidateCount: number;
  comparableCount: number;
  confidence: MarketQuote["confidence"];
  lowConfidenceReason?: string;
  summary: string;
}

function formatAmount(value: number | undefined, currency: string): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${formatListingPrice(value)} ${currency}`;
}

export function formatPriceEstimate(quote: MarketQuote): PriceEstimateDisplay {
  const recommended =
    quote.recommendedListing ??
    (() => {
      const result = recommendListingPrice(quote);
      return "skip" in result ? undefined : result.price;
    })();
  return {
    label: PRICE_ESTIMATE_LABEL,
    isGuaranteedSalePrice: false,
    providerId: quote.providerId,
    quotedAtMs: quote.quotedAtMs,
    currency: quote.currency,
    low: quote.low,
    fair: quote.fair,
    high: quote.high,
    recommendedListing: recommended,
    candidateCount: quote.candidateCount,
    comparableCount: quote.comparableCount,
    confidence: quote.confidence,
    lowConfidenceReason: quote.lowConfidenceReason,
    summary: [
      `Estimate ${formatAmount(quote.fair, quote.currency)}`,
      `(low ${formatAmount(quote.low, quote.currency)} / high ${formatAmount(quote.high, quote.currency)})`,
      `recommended listing ${formatAmount(recommended, quote.currency)}; not a guaranteed sale price`,
    ].join(" "),
  };
}

export function formatValuationEstimate(valuation: ValuationResult): PriceEstimateDisplay {
  return formatPriceEstimate(valuation.quote);
}

export function priceDisplayMentionsGuarantee(text: string): boolean {
  return /\bguaranteed sale\b/i.test(text) && !/\bnot a guaranteed sale\b/i.test(text);
}
