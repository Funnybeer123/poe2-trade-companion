/**
 * Bulk currency exchange: the have/want pickers and the way offers are
 * grouped and phrased.
 *
 * The currency id list is curated (`src/data/market/exchange-currencies.json`)
 * until `PriceFeedService.fetchStatic()` answers with the site's own list;
 * rows carry `verified` so the UI can mark the guesses.
 *
 * Pure: no Electron, no DOM, no network.
 */
import { divineRateOf } from "./inventoryLedger.js";
import type { PriceTable } from "./priceTable.js";
import {
  TRADE_CURRENCY_NAMES,
  currencyRateInExalted,
  normalizeTradeCurrency,
  type ExchangeOffer,
  type TradeListingSeller,
} from "./tradeListings.js";
import type { ExchangeQuery } from "./tradeQuery.js";

export interface ExchangeCurrencyOption {
  /** trade2 currency id ("divine", "exalted", "chaos", …). */
  id: string;
  label: string;
  category: string;
  /** The id was seen in a live whisper or comp, not guessed. */
  verified: boolean;
  /** The price table knows a rate for it (so a ratio can be sanity-checked). */
  rateKnown?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * Currency options from the curated file (or the `/data/static` payload
 * when one is supplied — same tolerant walk), each marked with whether the
 * price table can price it.
 */
export function exchangeCurrencyOptions(data: unknown, priceTable?: PriceTable): ExchangeCurrencyOption[] {
  const rows: ExchangeCurrencyOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string, category: string, verified: boolean): void => {
    const clean = id.trim().toLowerCase();
    if (!ID_PATTERN.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    const rate = currencyRateInExalted(clean, priceTable);
    rows.push({
      id: clean,
      label: label.trim() || TRADE_CURRENCY_NAMES[clean] || clean,
      category: category.trim() || "currency",
      verified,
      ...(rate !== undefined ? { rateKnown: true } : {}),
    });
  };

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      // The /data/static shape first: { id, label, entries: [{ id, text }] }
      // — its group rows carry an id and a label too, so the presence of
      // `entries` is what tells the two shapes apart.
      if (Array.isArray(entry.entries)) {
        const group = typeof entry.label === "string" ? entry.label : typeof entry.id === "string" ? entry.id : "currency";
        for (const child of entry.entries) {
          if (!isRecord(child)) continue;
          if (typeof child.id !== "string") continue;
          push(child.id, typeof child.text === "string" ? child.text : child.id, group, true);
        }
        continue;
      }
      // The curated shape.
      if (typeof entry.id === "string" && typeof entry.label === "string") {
        push(entry.id, entry.label, typeof entry.category === "string" ? entry.category : "currency", entry.verified === true);
      }
    }
  } else if (isRecord(data) && Array.isArray(data.result)) {
    return exchangeCurrencyOptions(data.result, priceTable);
  }
  return rows;
}

export interface SellerOfferGroup {
  seller: TradeListingSeller;
  offers: ExchangeOffer[];
  /** The whisper of the first offer — one line, one click, never automatic. */
  whisper?: string;
}

/** All of one seller's offers under one card, in the order they arrived. */
export function groupOffersBySeller(offers: readonly ExchangeOffer[]): SellerOfferGroup[] {
  const groups = new Map<string, SellerOfferGroup>();
  const order: string[] = [];
  for (const offer of offers) {
    const key = offer.seller.account.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { seller: offer.seller, offers: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.offers.push(offer);
    if (!group.whisper && offer.whisper) group.whisper = offer.whisper;
  }
  return order.map((key) => groups.get(key)!);
}

/**
 * More than two currencies in play means the interesting question is "who
 * can do the whole swap", so the results group by seller automatically.
 */
export function shouldGroupBySeller(query: ExchangeQuery): boolean {
  return query.have.length + query.want.length > 2;
}

export interface ExchangeRateRow {
  id: string;
  name: string;
  /** Estimate from the price feed, not a trade2 quote. */
  exalted?: number;
  divine?: number;
}

/**
 * The "market insights" strip above the exchange results: what the price
 * feed thinks each side is worth, so a ratio can be read against something.
 * Always an estimate — the feed is poe2scout, not the in-game exchange.
 */
export function exchangeRateStrip(query: ExchangeQuery, priceTable: PriceTable): ExchangeRateRow[] {
  const divineRate = divineRateOf(priceTable);
  const rows: ExchangeRateRow[] = [];
  const seen = new Set<string>();
  for (const id of [...query.have, ...query.want]) {
    const clean = normalizeTradeCurrency(id) ?? id.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const exalted = currencyRateInExalted(clean, priceTable);
    rows.push({
      id: clean,
      name: TRADE_CURRENCY_NAMES[clean] ?? clean,
      ...(exalted !== undefined ? { exalted } : {}),
      ...(exalted !== undefined && divineRate > 0 ? { divine: Math.round((exalted / divineRate) * 1000) / 1000 } : {}),
    });
  }
  return rows;
}

function shortLabel(id: string): string {
  return TRADE_CURRENCY_NAMES[id] ?? id;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * "1 divine → 402 exalted" for a normal ratio; below one unit it reads the
 * other way round ("0.0025 divine per exalted") so the number stays legible.
 */
export function formatRatio(offer: ExchangeOffer): string {
  const have = shortLabel(offer.have.currency);
  const want = shortLabel(offer.want.currency);
  if (offer.have.amount <= 0 || offer.want.amount <= 0) return `${have} → ${want}`;
  const perHave = offer.want.amount / offer.have.amount;
  if (perHave >= 1) return `1 ${have} → ${round(perHave)} ${want}`;
  return `${round(offer.have.amount / offer.want.amount)} ${have} per ${want}`;
}
