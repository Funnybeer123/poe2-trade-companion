import type { MarketQuote, QuoteContext } from "../items/types.js";
import type { QuoteLookup } from "../items/compositeDesirability.js";
import type { MarketCachePort } from "../market/marketCache.js";
import { marketCacheKey } from "../market/marketCache.js";
import type { ListingCatalogItem, ListingQuoteSnapshot } from "../world-state/types.js";
import { isMarketThrottled } from "./pricePolicy.js";

export const DEFAULT_LISTING_QUOTE_CONTEXT: QuoteContext = {
  league: "Standard",
  realm: "poe2",
  maxAgeMs: 3_600_000,
};

export function snapshotToQuote(snapshot: ListingQuoteSnapshot): MarketQuote {
  return {
    providerId: snapshot.providerId,
    quotedAtMs: snapshot.quotedAtMs,
    currency: snapshot.currency,
    low: snapshot.low,
    fair: snapshot.fair,
    high: snapshot.high,
    candidateCount: snapshot.candidateCount,
    comparableCount: snapshot.comparableCount,
    confidence: snapshot.confidence,
    lowConfidenceReason: snapshot.lowConfidenceReason,
    comparables: [],
  };
}

export function resolveListingQuote(input: {
  item?: ListingCatalogItem;
  quotes?: QuoteLookup;
  cache?: MarketCachePort;
  context?: QuoteContext;
  nowMs: number;
}): { quote?: MarketQuote; fromCache: boolean } {
  const context = input.context ?? DEFAULT_LISTING_QUOTE_CONTEXT;
  const catalogQuote = input.item === undefined ? undefined : snapshotToQuote(input.item.quote);
  const lookedUp =
    input.item === undefined || input.quotes === undefined
      ? undefined
      : input.quotes.lookup(
          {
            fingerprint: input.item.fingerprint,
            modifiers: [],
            pseudos: {},
          },
          context,
        );

  const quote = catalogQuote ?? lookedUp;
  const cacheKey =
    input.item === undefined
      ? undefined
      : marketCacheKey({
          providerId: quote?.providerId ?? "fixture",
          league: context.league,
          realm: context.realm,
          fingerprint: input.item.fingerprint,
        });
  const cached =
    cacheKey === undefined || input.cache === undefined
      ? undefined
      : input.cache.get(cacheKey, input.nowMs, context.maxAgeMs);

  if (quote !== undefined && isMarketThrottled(quote) && cached !== undefined) {
    return { quote: cached, fromCache: true };
  }
  if (quote === undefined && cached !== undefined) {
    return { quote: cached, fromCache: true };
  }
  return { quote, fromCache: false };
}
