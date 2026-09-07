/**
 * Local valuation: the ValuationResult behind a price check, built from the
 * signals the app actually has instead of bundled demo quotes.
 *
 * Precedence (strongest evidence first):
 *   1. price-table hit — the user's own table, fed by poe2scout; exact
 *      names/bases only, stack-aware for currency piles;
 *   2. trade2 comps — real listings for THIS item (core/tradeComps.ts),
 *      already filtered by mod similarity and priced in exalted;
 *   3. appraisal — the mod-tier heuristic (core/appraisal.ts) mapped onto the
 *      crafting engine's score → exalted curve; explicitly low confidence;
 *   4. none — zeros, so nothing downstream mistakes silence for a price.
 *
 * Pure and deterministic: no I/O, no clock reads (the caller passes `now`).
 * Every number here is an estimate, never a guaranteed sale price.
 */

import { exaltedFromScore } from "./crafting.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import { defaultShopConfig } from "./shopListings.js";
import { isPriceRefusal, suggestListingPrice } from "./shopPricing.js";
import type { CompsSummary } from "./tradeComps.js";
import type { ConfidenceBucket, ParsedItem, ValuationResult } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";

export type LocalValuationProvider = "price-table" | "trade2-comps" | "appraisal" | "none";

/** Provider ids the renderer may see on a ValuationResult, fixture included. */
export const VALUATION_PROVIDER_LABELS: Record<LocalValuationProvider | "fixture", string> = {
  "price-table": "price table",
  "trade2-comps": "trade listings",
  appraisal: "appraisal",
  none: "no data",
  fixture: "demo prices",
};

export interface LocalValuationInput {
  parsed: ParsedItem;
  priceTable?: PriceTable;
  /** The tier verdict, when the caller ran the rules (carries the appraisal). */
  verdict?: TierVerdict;
  /** Cached or freshly fetched trade2 comps for this exact item. */
  comps?: CompsSummary;
  now: Date;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Same stack read appraiseItem uses: the "Stack Size: 12/20" property. */
function stackCount(parsed: ParsedItem): number | undefined {
  const property = parsed.properties.find((entry) => /^stack size$/i.test(entry.name));
  const count = property?.rolls?.[0]?.value;
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : undefined;
}

function keyStats(parsed: ParsedItem): ValuationResult["normalizedKeyStats"] {
  return {
    itemLevel: parsed.itemLevel ?? 0,
    quality: parsed.quality ?? 0,
    rarity: parsed.rarity,
    modCount: parsed.mods.length,
  };
}

function base(
  parsed: ParsedItem,
  providerName: LocalValuationProvider,
  marketTimestamp: string,
  currency: string,
): Pick<
  ValuationResult,
  "itemIdentifier" | "itemType" | "normalizedKeyStats" | "providerName" | "marketTimestamp" | "currency"
> {
  return {
    itemIdentifier: parsed.fingerprint,
    itemType: parsed.itemClass,
    normalizedKeyStats: keyStats(parsed),
    providerName,
    marketTimestamp,
    currency,
  };
}

function fromPriceTable(input: LocalValuationInput): ValuationResult | undefined {
  const { parsed, priceTable } = input;
  if (!priceTable) return undefined;
  const hit = lookupPrice(priceTable, {
    name: parsed.name,
    baseType: parsed.baseType,
    itemClass: parsed.itemClass,
    itemLevel: parsed.itemLevel,
    rarity: parsed.rarity,
  });
  if (!hit) return undefined;
  // "Exact names/bases only": a rarity- or class-wide row (the starter's
  // "any unique = 1 ex") is a triage floor, not this item's price — leave
  // the item to its comps and appraisal instead of a confident 1 ex.
  const byName = hit.entry.match.name !== undefined;
  if (!byName && hit.entry.match.baseType === undefined) return undefined;
  const count = /currency/i.test(parsed.itemClass) ? stackCount(parsed) : undefined;
  const amount = round2(hit.value * (count ?? 1));
  return {
    ...base(parsed, "price-table", priceTable.updatedAt ?? input.now.toISOString(), hit.currency),
    candidateCount: 1,
    comparablesUsed: 1,
    low: amount,
    fair: amount,
    high: amount,
    recommendedListing: amount,
    confidence: byName ? "high" : "medium",
    ...(byName ? {} : { lowConfidenceReason: "price table matched the base type, not this item" }),
  };
}

function compsConfidence(sampleSize: number): {
  confidence: ConfidenceBucket;
  reason?: string;
} {
  if (sampleSize >= 8) return { confidence: "high" };
  if (sampleSize >= 4) {
    return { confidence: "medium", reason: `thin sample: ${sampleSize} comparable listings` };
  }
  return {
    confidence: "low",
    reason: `very few comparables: ${sampleSize} listing${sampleSize === 1 ? "" : "s"}`,
  };
}

function fromComps(input: LocalValuationInput): ValuationResult | undefined {
  const { parsed, comps } = input;
  if (!comps || comps.sampleSize < 1) return undefined;
  const prices = comps.comps.map((entry) => entry.price);
  const fair = comps.median ?? prices[Math.floor((prices.length - 1) / 2)] ?? 0;
  const low = comps.lowest ?? Math.min(...prices);
  const high = prices.length > 0 ? Math.max(...prices, fair) : fair;
  const suggestion = suggestListingPrice(comps, defaultShopConfig(), {
    at: input.now.toISOString(),
    ...(input.priceTable ? { priceTable: input.priceTable } : {}),
  });
  const recommendedListing = isPriceRefusal(suggestion)
    ? round2(fair * 0.95)
    : round2(suggestion.targetExalted);
  const { confidence, reason } = compsConfidence(comps.sampleSize);
  const lowConfidenceReason = [reason, comps.caution].filter(Boolean).join(" — ");
  return {
    ...base(parsed, "trade2-comps", input.now.toISOString(), comps.currency),
    candidateCount: comps.candidateCount,
    comparablesUsed: comps.sampleSize,
    low: round2(low),
    fair: round2(fair),
    high: round2(high),
    recommendedListing,
    confidence,
    ...(lowConfidenceReason ? { lowConfidenceReason } : {}),
  };
}

function fromAppraisal(input: LocalValuationInput): ValuationResult | undefined {
  const appraisal = input.verdict?.appraisal;
  if (!appraisal || appraisal.valueScore <= 0) return undefined;
  const fair = exaltedFromScore(appraisal.valueScore);
  const confidence: ConfidenceBucket =
    appraisal.band === "very-high" || appraisal.band === "high"
      ? "medium"
      : appraisal.band === "medium"
        ? "low"
        : "none";
  return {
    ...base(input.parsed, "appraisal", input.now.toISOString(), "exalted"),
    candidateCount: 0,
    comparablesUsed: 0,
    low: round2(fair * 0.6),
    fair: round2(fair),
    high: round2(fair * 1.6),
    recommendedListing: round2(fair * 0.95),
    confidence,
    lowConfidenceReason: "heuristic appraisal — no listings",
  };
}

function none(input: LocalValuationInput): ValuationResult {
  return {
    ...base(input.parsed, "none", input.now.toISOString(), "exalted"),
    candidateCount: 0,
    comparablesUsed: 0,
    low: 0,
    fair: 0,
    high: 0,
    recommendedListing: 0,
    confidence: "none",
    lowConfidenceReason: "no price entry, listings, or appraisal evidence",
  };
}

/**
 * Value one parsed item from local evidence: price table, then trade2 comps,
 * then the appraisal heuristic, else an explicit "none".
 */
export function valueItemLocally(input: LocalValuationInput): ValuationResult {
  return fromPriceTable(input) ?? fromComps(input) ?? fromAppraisal(input) ?? none(input);
}
