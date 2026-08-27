import type { ConfidenceBucket, MarketQuote, NormalizedItem, ValuationResult } from "./types.js";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function filterOutliers(values: number[]): number[] {
  if (values.length < 4) return [...values].sort((a, b) => a - b);
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return sorted.filter((value) => value >= low && value <= high);
}

export function valueItem(item: NormalizedItem, quote: MarketQuote, currency = "exalted"): ValuationResult {
  const amounts = quote.comparables.map((entry) => entry.priceAmount);
  const used = filterOutliers(amounts);
  const candidateCount = amounts.length;
  const comparablesUsed = used.length;
  let confidence: ConfidenceBucket = "none";
  let lowConfidenceReason: string | undefined = "no comparables";
  if (comparablesUsed >= 8) {
    confidence = "high";
    lowConfidenceReason = undefined;
  } else if (comparablesUsed >= 4) {
    confidence = "medium";
    lowConfidenceReason = "thin sample";
  } else if (comparablesUsed >= 1) {
    confidence = "low";
    lowConfidenceReason = "very few comparables";
  }

  const low = percentile(used, 0.1);
  const fair = percentile(used, 0.5);
  const high = percentile(used, 0.9);
  const recommendedListing = Number((fair * 0.95).toFixed(2));

  return {
    itemIdentifier: item.fingerprint,
    itemType: item.itemClass,
    normalizedKeyStats: {
      itemLevel: item.itemLevel ?? 0,
      quality: item.quality ?? 0,
      rarity: item.rarity,
      modCount: item.mods.length,
    },
    providerName: quote.providerId,
    marketTimestamp: quote.fetchedAt,
    candidateCount,
    comparablesUsed,
    low,
    fair,
    high,
    recommendedListing,
    currency,
    confidence,
    lowConfidenceReason,
  };
}
