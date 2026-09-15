/**
 * Evaluate — what comes back: listing rows, the client-side sort/filter/
 * group helpers, the estimated band, the bulk-exchange summary and the
 * 7-day history slice.
 *
 * Every number produced here is an ESTIMATE built from other players' asks.
 * `estimateFor` reuses the app's own valuation stack (`summarizeComps` +
 * `valueItemLocally`) so the band, its provider and its confidence read the
 * same as the Item log's — one valuation story, not two.
 *
 * Pure: no fs, no network; `now` is always passed in.
 */
import { valueItemLocally } from "./localValuation.js";
import type { PriceTable } from "./priceTable.js";
import { computeTrend, type TrendSeries } from "./priceTrends.js";
import type { StatCatalogue } from "./statIds.js";
import type { LearnedTiers } from "./tierLearning.js";
import { summarizeComps, type CompListing, type CompsSummary } from "./tradeComps.js";
import {
  describeListing,
  priceInExalted,
  priceNote,
  type ExchangeOffer,
  type TradeListing,
} from "./tradeListings.js";
import type { ParsedItem } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";
import type {
  EvaluateEstimate,
  EvaluateExchange,
  EvaluateExchangeOfferRow,
  EvaluateHistory,
  EvaluateItemSummary,
  EvaluateListingRow,
} from "../shared/evaluate.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function propertyValue(listing: TradeListing, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  const hit = listing.item.properties.find((property) => property.name.trim().toLowerCase() === wanted);
  return hit ? hit.values.join(", ") : undefined;
}

function requirementValue(listing: TradeListing, name: string): number | undefined {
  const wanted = name.trim().toLowerCase();
  const hit = listing.item.requirements.find(
    (requirement) => requirement.name.trim().toLowerCase() === wanted,
  );
  const value = hit ? Number(hit.value) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * One fetched listing as a result row. `describeListing` (F4) owns the
 * price/age/DPS/defence reading so Evaluate and Market show a listing the
 * same way; everything added here is Evaluate's own column set.
 */
export function listingRow(
  listing: TradeListing,
  now: number,
  priceTable?: PriceTable,
): EvaluateListingRow {
  const display = describeListing(listing, { now, ...(priceTable ? { priceTable } : {}) });
  const item = listing.item;
  const price = listing.price ? { amount: listing.price.amount, currency: listing.price.currency } : undefined;
  const qualityText = propertyValue(listing, "Quality");
  const qualityMatch = qualityText ? /([+-]?\d+(?:\.\d+)?)/.exec(qualityText) : undefined;
  const quality =
    item.quality ?? (qualityMatch && Number.isFinite(Number(qualityMatch[1])) ? Number(qualityMatch[1]) : undefined);
  return {
    id: listing.id,
    ...(price ? { price } : {}),
    priceText: display.priceText,
    ...(display.priceExalted !== undefined ? { priceExalted: display.priceExalted } : {}),
    ...(display.fractional ? { fractional: display.fractional } : {}),
    seller: listing.seller.account,
    ...(listing.seller.character ? { character: listing.seller.character } : {}),
    presence: display.online,
    ...(listing.indexedAt ? { indexedAt: listing.indexedAt } : {}),
    ...(display.ageMs !== undefined ? { ageMs: display.ageMs } : {}),
    stale: display.stale,
    listingType: listing.listingType,
    ...(listing.whisper ? { whisper: listing.whisper } : {}),
    ...(item.name ? { name: item.name } : {}),
    typeLine: item.typeLine,
    ...(item.itemLevel !== undefined ? { itemLevel: item.itemLevel } : {}),
    ...(display.requiredLevel !== undefined
      ? { requiredLevel: display.requiredLevel }
      : requirementValue(listing, "Level") !== undefined
        ? { requiredLevel: requirementValue(listing, "Level")! }
        : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(item.gemLevel !== undefined ? { gemLevel: item.gemLevel } : {}),
    ...(item.sockets !== undefined ? { sockets: item.sockets } : {}),
    ...(item.runeSockets !== undefined ? { runeSockets: item.runeSockets } : {}),
    ...(item.stackSize !== undefined ? { stackSize: item.stackSize } : {}),
    ...(display.dps !== undefined || display.pdps !== undefined || display.edps !== undefined
      ? {
          dps: {
            ...(display.dps !== undefined ? { total: display.dps } : {}),
            ...(display.pdps !== undefined ? { pdps: display.pdps } : {}),
            ...(display.edps !== undefined ? { edps: display.edps } : {}),
          },
        }
      : {}),
    ...(display.arQ20 !== undefined ||
    display.evQ20 !== undefined ||
    display.esQ20 !== undefined ||
    display.wardQ20 !== undefined
      ? {
          defences: {
            ...(display.arQ20 !== undefined ? { arQ20: display.arQ20 } : {}),
            ...(display.evQ20 !== undefined ? { evQ20: display.evQ20 } : {}),
            ...(display.esQ20 !== undefined ? { esQ20: display.esQ20 } : {}),
            ...(display.wardQ20 !== undefined ? { wardQ20: display.wardQ20 } : {}),
          },
        }
      : {}),
    flags: [...display.flags],
    stashNote: price ? priceNote(price, "price") : "",
    buyoutNote: price ? priceNote(price, "b/o") : "",
    mods: {
      enchant: [...item.enchantMods],
      implicit: [...item.implicitMods],
      explicit: [...item.explicitMods],
      fractured: [...item.fracturedMods],
      desecrated: [...item.desecratedMods],
      rune: [...item.runeMods],
    },
    properties: item.properties.map((property) => ({
      name: property.name,
      value: property.values.join(", "),
    })),
    requirements: item.requirements.map((requirement) => ({
      name: requirement.name,
      value: requirement.value,
    })),
  };
}

/** A priced listing as comps input; unpriced rows say nothing about value. */
export function toCompListing(listing: TradeListing): CompListing | undefined {
  if (!listing.price) return undefined;
  return {
    id: listing.id,
    name: listing.item.name ?? "",
    baseType: listing.item.baseType ?? listing.item.typeLine,
    mods: [...listing.item.explicitMods, ...listing.item.desecratedMods, ...listing.item.fracturedMods],
    priceAmount: listing.price.amount,
    priceCurrency: listing.price.currency,
    ...(listing.seller.account ? { accountName: listing.seller.account } : {}),
    ...(listing.indexedAt ? { indexed: listing.indexedAt } : {}),
    ...(listing.whisper ? { whisper: listing.whisper } : {}),
  };
}

export interface EstimateInput {
  parsed: ParsedItem;
  listings: readonly TradeListing[];
  basis: EvaluateEstimate["basis"];
  priceTable?: PriceTable;
  verdict?: TierVerdict;
  learnedTiers?: LearnedTiers;
  statIds?: StatCatalogue;
  now: Date;
}

/**
 * The band. Stat-filtered listings matched our mods by construction, so the
 * similarity floor drops to 0 for them (it is still computed for display);
 * a base-type search keeps the usual 0.5 bar.
 */
export function estimateFor(input: EstimateInput): EvaluateEstimate {
  const comps: CompListing[] = [];
  for (const listing of input.listings) {
    const comp = toCompListing(listing);
    if (comp) comps.push(comp);
  }
  const ourMods = input.parsed.mods.map((mod) => mod.text);
  const summary: CompsSummary = summarizeComps(ourMods, comps, input.basis, {
    ...(input.priceTable ? { priceTable: input.priceTable } : {}),
    minSimilarity: input.basis === "stat-filtered" ? 0 : 0.5,
    itemClass: input.parsed.itemClass,
    ...(input.learnedTiers ? { learnedTiers: input.learnedTiers } : {}),
    ...(input.statIds ? { statIds: input.statIds } : {}),
  });
  const valuation = valueItemLocally({
    parsed: input.parsed,
    ...(input.priceTable ? { priceTable: input.priceTable } : {}),
    ...(input.verdict ? { verdict: input.verdict } : {}),
    comps: summary,
    now: input.now,
  });
  return {
    valuation,
    sampleSize: summary.sampleSize,
    candidateCount: input.listings.length,
    confidence: valuation.confidence,
    basis: input.basis,
    ...(summary.caution ? { caution: summary.caution } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sort / filter / group (client-side only — never a new request)
// ---------------------------------------------------------------------------

export type RowSortKey =
  | "price"
  | "age"
  | "dps"
  | "ilvl"
  | "gemLevel"
  | "requiredLevel"
  | "sockets"
  | "quality"
  | "stock";

function sortValue(row: EvaluateListingRow, key: RowSortKey): number | undefined {
  switch (key) {
    case "price":
      return row.priceExalted;
    case "age":
      return row.ageMs;
    case "dps":
      return row.dps?.total;
    case "ilvl":
      return row.itemLevel;
    case "gemLevel":
      return row.gemLevel;
    case "requiredLevel":
      return row.requiredLevel;
    case "sockets":
      return row.runeSockets ?? row.sockets;
    case "quality":
      return row.quality;
    case "stock":
      return row.stackSize;
    default:
      return undefined;
  }
}

/** Rows without the sort value always land last, whichever direction. */
export function sortRows(
  rows: readonly EvaluateListingRow[],
  key: RowSortKey,
  direction: "asc" | "desc",
): EvaluateListingRow[] {
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === undefined && right === undefined) {
      return (a.priceExalted ?? 0) - (b.priceExalted ?? 0);
    }
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    if (left === right) return (a.priceExalted ?? 0) - (b.priceExalted ?? 0);
    return (left - right) * factor;
  });
}

export interface RowFilters {
  currency?: string;
  onlineOnly?: boolean;
  maxAgeMs?: number;
  secureOnly?: boolean;
}

export function filterRows(
  rows: readonly EvaluateListingRow[],
  filters: RowFilters,
): EvaluateListingRow[] {
  return rows.filter((row) => {
    if (filters.currency && row.price?.currency !== filters.currency) return false;
    if (filters.onlineOnly && row.presence !== "online") return false;
    if (filters.secureOnly && row.listingType !== "secure") return false;
    if (filters.maxAgeMs !== undefined && (row.ageMs ?? 0) > filters.maxAgeMs) return false;
    return true;
  });
}

export interface SellerGroup {
  seller: string;
  rows: EvaluateListingRow[];
  cheapest: EvaluateListingRow;
}

/** One entry per seller, cheapest listing first inside and between groups. */
export function groupBySeller(rows: readonly EvaluateListingRow[]): SellerGroup[] {
  const groups = new Map<string, EvaluateListingRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.seller);
    if (bucket) bucket.push(row);
    else groups.set(row.seller, [row]);
  }
  return [...groups.entries()]
    .map(([seller, entries]) => {
      const sorted = sortRows(entries, "price", "asc");
      return { seller, rows: sorted, cheapest: sorted[0]! };
    })
    .sort((a, b) => (a.cheapest.priceExalted ?? 0) - (b.cheapest.priceExalted ?? 0));
}

export function currencyCounts(
  rows: readonly EvaluateListingRow[],
): Array<{ currency: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const currency = row.price?.currency;
    if (!currency) continue;
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
}

// ---------------------------------------------------------------------------
// Bulk exchange
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : round2((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** How many offers the median is taken over — the cheapest ones only. */
const MEDIAN_WINDOW = 20;

/**
 * The bulk view for a stackable: what one unit of the WANTED item costs in
 * the have-side currency. trade2 quotes `have.amount` of ours for
 * `want.amount` of theirs, so the per-unit ask is have ÷ want.
 */
export function exchangeSummary(
  offers: readonly ExchangeOffer[],
  url: string,
  now: Date,
  quoteCurrency = "exalted",
): EvaluateExchange {
  const rows: EvaluateExchangeOfferRow[] = [];
  const perUnit: number[] = [];
  let stockTotal = 0;
  for (const offer of offers) {
    const unit =
      offer.want.amount > 0 && Number.isFinite(offer.have.amount)
        ? round2(offer.have.amount / offer.want.amount)
        : undefined;
    if (unit !== undefined && unit > 0) perUnit.push(unit);
    stockTotal += Number.isFinite(offer.stock) ? offer.stock : 0;
    rows.push({
      id: offer.id,
      seller: offer.seller.account,
      online: offer.seller.online === true,
      ratio: `${offer.have.amount} ${offer.have.currency} : ${offer.want.amount} ${offer.want.currency}`,
      stock: Number.isFinite(offer.stock) ? offer.stock : 0,
      ...(unit !== undefined ? { perUnitQuoted: unit } : {}),
      ...(offer.whisper ? { whisper: offer.whisper } : {}),
    });
  }
  const cheapest = [...perUnit].sort((a, b) => a - b);
  const best = cheapest[0];
  const medianAsk = median(cheapest.slice(0, MEDIAN_WINDOW));
  return {
    offers: rows,
    ...(best !== undefined ? { bestAskQuoted: best } : {}),
    ...(medianAsk !== undefined ? { medianAskQuoted: medianAsk } : {}),
    stockTotal,
    quoteCurrency,
    url,
    fetchedAt: now.toISOString(),
  };
}

/**
 * The feed's own price for the same item, for the "feed price" cross-check
 * next to the exchange median. Returns undefined when the table has no row.
 */
export function feedPriceExalted(
  item: EvaluateItemSummary,
  priceTable: PriceTable | undefined,
): number | undefined {
  if (!priceTable) return undefined;
  const entry = priceTable.entries
    .filter((row) => row.match.name?.trim().toLowerCase() === item.name.trim().toLowerCase())
    .sort((a, b) => b.value - a.value)[0];
  if (!entry) return undefined;
  return priceTable.currency === "exalted"
    ? round2(entry.value)
    : priceInExalted(entry.value, priceTable.currency, priceTable);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** How many daily bars the sparkline draws. */
export const HISTORY_BARS = 7;

/**
 * The item's 7-day bars out of the market-trends cache. Matching is by name
 * (case-insensitive); a unique must also agree on its base type so two
 * uniques sharing a name cannot swap histories.
 */
export function historyFor(
  series: readonly TrendSeries[],
  item: EvaluateItemSummary,
  fetchedAt: string | undefined,
  stale: boolean,
  now: Date,
): EvaluateHistory | undefined {
  const name = item.name.trim().toLowerCase();
  if (!name) return undefined;
  const base = item.baseType.trim().toLowerCase();
  const match = series.find((entry) => {
    if (entry.name.trim().toLowerCase() !== name) return false;
    if (!entry.unique) return true;
    return !base || !entry.baseType || entry.baseType.trim().toLowerCase() === base;
  });
  if (!match || match.points.length === 0) return undefined;
  const trend = computeTrend(match, now);
  return {
    points: match.points.slice(-HISTORY_BARS).map((point) => ({
      time: point.time,
      price: point.price,
      quantity: point.quantity,
    })),
    ...(match.current !== undefined ? { current: match.current } : {}),
    ...(trend.change3d !== undefined ? { change3d: trend.change3d } : {}),
    ...(trend.change7d !== undefined ? { change7d: trend.change7d } : {}),
    volume7d: trend.volume7d,
    ...(fetchedAt ? { fetchedAt } : {}),
    stale,
  };
}
