import type { ConfidenceBucket, MarketQuote } from "../items/types.js";
import type { ListingQuoteSnapshot } from "../world-state/types.js";
import type { PricePolicy } from "./types.js";

export const DEFAULT_PRICE_POLICY: PricePolicy = {
  undercutPct: 0.03,
  markupPct: 0,
  minConfidence: "medium",
  staleAfterMs: 6 * 60 * 60 * 1000,
};

export const CONFIDENCE_RANK: Record<ConfidenceBucket, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const LISTING_PRICE_EPSILON = 0.001;
export const STALE_LISTING_DEFAULT_MS = DEFAULT_PRICE_POLICY.staleAfterMs;

export type QuoteLike = Pick<
  MarketQuote,
  "fair" | "low" | "currency" | "confidence" | "lowConfidenceReason" | "quotedAtMs" | "providerId"
>;

export interface RecommendedListing {
  price: number;
  currency: string;
  source: "fair-undercut" | "low-floor" | "min-price";
  isGuaranteedSalePrice: false;
  fair?: number;
  low?: number;
}

export interface RecommendSkip {
  skip: true;
  reason: string;
  isGuaranteedSalePrice: false;
}

export type RecommendListingResult = RecommendedListing | RecommendSkip;

export function resolvePricePolicy(overrides: Partial<PricePolicy> = {}): PricePolicy {
  return {
    undercutPct: overrides.undercutPct ?? DEFAULT_PRICE_POLICY.undercutPct,
    markupPct: overrides.markupPct ?? DEFAULT_PRICE_POLICY.markupPct,
    minPrice: overrides.minPrice ?? DEFAULT_PRICE_POLICY.minPrice,
    minConfidence: overrides.minConfidence ?? DEFAULT_PRICE_POLICY.minConfidence,
    staleAfterMs: overrides.staleAfterMs ?? DEFAULT_PRICE_POLICY.staleAfterMs,
  };
}

export function meetsMinConfidence(
  quoteConfidence: ConfidenceBucket,
  minConfidence: ConfidenceBucket,
): boolean {
  return CONFIDENCE_RANK[quoteConfidence] >= CONFIDENCE_RANK[minConfidence];
}

export function isListingStale(
  listedAtMs: number | undefined,
  nowMs: number,
  staleAfterMs: number = DEFAULT_PRICE_POLICY.staleAfterMs,
): boolean {
  if (listedAtMs === undefined) {
    return false;
  }
  return nowMs - listedAtMs >= staleAfterMs;
}

export function isMarketThrottled(quote?: Pick<QuoteLike, "lowConfidenceReason" | "confidence">): boolean {
  const reason = quote?.lowConfidenceReason ?? "";
  return /429|throttl|rate-limit|rate_limit/i.test(reason);
}

export function roundListingPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatListingPrice(value: number): string {
  const rounded = roundListingPrice(value);
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function parsePriceText(
  priceText: string | undefined,
): { price: number; currency?: string } | undefined {
  if (priceText === undefined) {
    return undefined;
  }
  const trimmed = priceText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z][A-Za-z0-9 -]*)?/.exec(trimmed);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const price = Number(match[1]);
  if (!Number.isFinite(price)) {
    return undefined;
  }
  const currencyRaw = match[2]?.trim();
  return {
    price,
    currency: currencyRaw === undefined || currencyRaw.length === 0 ? undefined : currencyRaw,
  };
}

export function pricesMatch(
  observed: number | undefined,
  expected: number | undefined,
  epsilon = LISTING_PRICE_EPSILON,
): boolean {
  if (observed === undefined || expected === undefined) {
    return false;
  }
  return Math.abs(observed - expected) <= epsilon;
}

export function currenciesMatch(observed?: string, expected?: string): boolean {
  if (expected === undefined || expected.length === 0) {
    return true;
  }
  if (observed === undefined || observed.length === 0) {
    return true;
  }
  return observed.trim().toLowerCase().startsWith(expected.trim().toLowerCase());
}

export function listingPriceMatchesText(
  priceText: string | undefined,
  expectedPrice: number | undefined,
  expectedCurrency?: string,
): boolean {
  const parsed = parsePriceText(priceText);
  if (parsed === undefined) {
    return false;
  }
  return pricesMatch(parsed.price, expectedPrice) && currenciesMatch(parsed.currency, expectedCurrency);
}

export function recommendListingPrice(
  quote: QuoteLike | ListingQuoteSnapshot,
  policy: PricePolicy = DEFAULT_PRICE_POLICY,
): RecommendListingResult {
  if (quote.fair === undefined || !Number.isFinite(quote.fair)) {
    return { skip: true, reason: "listing-skip:no-fair", isGuaranteedSalePrice: false };
  }

  const raw = roundListingPrice(quote.fair * (1 - policy.undercutPct) * (1 + policy.markupPct));
  let price = raw;
  let source: RecommendedListing["source"] = "fair-undercut";

  if (quote.low !== undefined && Number.isFinite(quote.low) && price < quote.low) {
    price = roundListingPrice(quote.low);
    source = "low-floor";
  }
  if (policy.minPrice !== undefined && price < policy.minPrice) {
    price = roundListingPrice(policy.minPrice);
    source = "min-price";
  }

  return {
    price,
    currency: quote.currency,
    source,
    isGuaranteedSalePrice: false,
    fair: quote.fair,
    low: quote.low,
  };
}

export function isRecommendedSkip(result: RecommendListingResult): result is RecommendSkip {
  return "skip" in result && result.skip;
}
