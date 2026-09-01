/**
 * Live price feed: turns market snapshots (poe2scout today; poe.ninja or an
 * in-game exchange OCR read tomorrow) into price-table entries, without ever
 * touching what the user typed by hand.
 *
 * Ground rules:
 *   - The price table stays the single authority automation trusts. Feeds
 *     UPDATE the table; nothing reads a feed directly.
 *   - Feed-owned entries carry an id of the form `feed:{source}:{key}` and a
 *     provenance note. A refresh replaces exactly the entries of its own
 *     source; every other entry — especially manual ones — is untouched.
 *   - All values are in exalted orbs, the app's pricing unit (and poe2scout's
 *     base unit for PoE2 leagues, verified 2026-08-30).
 *
 * Endpoint shapes verified live against api.poe2scout.com (realm `poe2`):
 *   GET /poe2/Leagues                                     → league list
 *   GET /poe2/Leagues/{league}/Currencies/ByCategory      → paged currency
 *   GET /poe2/Leagues/{league}/Items                      → all priced items
 */

import type { PriceEntry, PriceTable } from "./priceTable.js";

export type PriceFeedSource = "poe2scout" | "poe-ninja" | "exchange-ocr";

export interface FeedPrice {
  /** Stable per-source key (poe2scout ApiId, or a slug of the name). */
  key: string;
  /** In-game item name the price table matches on. */
  name: string;
  /** Base type, when the feed distinguishes it (uniques). */
  baseType?: string;
  /** Value in exalted orbs. */
  value: number;
  /** Listings seen — a liquidity hint recorded in the note. */
  quantity?: number;
  /** Marks unique-item prices so lookups can require the rarity. */
  unique?: boolean;
}

export interface PriceFeedSnapshot {
  source: PriceFeedSource;
  league: string;
  fetchedAt: string;
  prices: FeedPrice[];
}

export const FEED_ID_PREFIX = "feed:";

export function feedEntryId(source: PriceFeedSource, key: string): string {
  return `${FEED_ID_PREFIX}${source}:${key}`;
}

export function isFeedEntry(entry: PriceEntry, source?: PriceFeedSource): boolean {
  return entry.id.startsWith(source ? `${FEED_ID_PREFIX}${source}:` : FEED_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// poe2scout payload normalization
// ---------------------------------------------------------------------------

interface ScoutLeague {
  Value?: unknown;
  IsCurrent?: unknown;
  DivinePrice?: unknown;
}

/** Pick the current softcore trade league from /poe2/Leagues. */
export function currentScoutLeague(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined;
  const leagues = payload as ScoutLeague[];
  const current = leagues.filter(
    (league) =>
      league.IsCurrent === true &&
      typeof league.Value === "string" &&
      !/^HC /i.test(league.Value) &&
      !/hardcore/i.test(league.Value),
  );
  return (current[0]?.Value as string | undefined) ?? undefined;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalize one page of /Currencies/ByCategory. Entries priced at or below
 * zero (or missing a name) are dropped rather than guessed at.
 */
export function normalizeScoutCurrencies(payload: unknown): FeedPrice[] {
  if (typeof payload !== "object" || payload === null) return [];
  const items = (payload as { Items?: unknown }).Items;
  if (!Array.isArray(items)) return [];
  const prices: FeedPrice[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as {
      ApiId?: unknown;
      Text?: unknown;
      CurrentPrice?: unknown;
      CurrentQuantity?: unknown;
    };
    const name = typeof item.Text === "string" ? item.Text.trim() : "";
    const value = typeof item.CurrentPrice === "number" ? item.CurrentPrice : Number.NaN;
    if (!name || !Number.isFinite(value) || value <= 0) continue;
    prices.push({
      key: typeof item.ApiId === "string" && item.ApiId ? item.ApiId : slug(name),
      name,
      value: round(value),
      ...(typeof item.CurrentQuantity === "number" && item.CurrentQuantity > 0
        ? { quantity: Math.floor(item.CurrentQuantity) }
        : {}),
    });
  }
  return prices;
}

/**
 * Normalize /Leagues/{league}/Items: unique items (Name + Type) and
 * currency-style rows (Text only). `minUniqueValue` keeps the table small —
 * a 1-exalted unique adds noise, not signal — but currency rows are always
 * kept: even a 0.17-exalted transmute is a crafting cost the engine needs.
 */
export function normalizeScoutItems(payload: unknown, minUniqueValue = 2): FeedPrice[] {
  if (!Array.isArray(payload)) return [];
  const prices: FeedPrice[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as {
      Name?: unknown;
      Type?: unknown;
      Text?: unknown;
      ApiId?: unknown;
      CurrentPrice?: unknown;
    };
    const value = typeof item.CurrentPrice === "number" ? item.CurrentPrice : Number.NaN;
    if (!Number.isFinite(value) || value <= 0) continue;
    const uniqueName = typeof item.Name === "string" ? item.Name.trim() : "";
    const baseType = typeof item.Type === "string" ? item.Type.trim() : "";
    if (uniqueName) {
      if (value < minUniqueValue) continue;
      prices.push({
        key: slug(`${uniqueName}-${baseType}`),
        name: uniqueName,
        ...(baseType ? { baseType } : {}),
        value: round(value),
        unique: true,
      });
      continue;
    }
    const text = typeof item.Text === "string" ? item.Text.trim() : "";
    if (!text) continue;
    prices.push({
      key: typeof item.ApiId === "string" && item.ApiId ? item.ApiId : slug(text),
      name: text,
      value: round(value),
    });
  }
  return prices;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Merge into the price table
// ---------------------------------------------------------------------------

export interface MergeResult {
  table: PriceTable;
  added: number;
  updated: number;
  removed: number;
}

function feedNote(snapshot: PriceFeedSnapshot, price: FeedPrice): string {
  const day = snapshot.fetchedAt.slice(0, 10);
  const qty = price.quantity !== undefined ? ` · ${price.quantity} listed` : "";
  return `${snapshot.source} · ${snapshot.league} · ${day}${qty}`;
}

function toEntry(snapshot: PriceFeedSnapshot, price: FeedPrice): PriceEntry {
  return {
    id: feedEntryId(snapshot.source, price.key),
    match: {
      name: price.name,
      ...(price.baseType ? { baseType: price.baseType } : {}),
      ...(price.unique ? { rarity: "Unique" } : {}),
    },
    value: price.value,
    note: feedNote(snapshot, price),
  };
}

/**
 * Replace this snapshot's source-owned entries with the fresh set. Manual
 * entries (and other sources' entries) pass through untouched, keeping the
 * user's own numbers authoritative — a manual entry matching the same item
 * even outranks the feed's at lookup time because lookupPrice prefers the
 * more specific match, and ties keep the higher value.
 */
export function mergeFeedSnapshot(table: PriceTable, snapshot: PriceFeedSnapshot): MergeResult {
  const keep = table.entries.filter((entry) => !isFeedEntry(entry, snapshot.source));
  const previous = new Map(
    table.entries
      .filter((entry) => isFeedEntry(entry, snapshot.source))
      .map((entry) => [entry.id, entry] as const),
  );
  const fresh = dedupeByKey(snapshot.prices).map((price) => toEntry(snapshot, price));
  let added = 0;
  let updated = 0;
  for (const entry of fresh) {
    if (!previous.has(entry.id)) added += 1;
    else if (previous.get(entry.id)!.value !== entry.value) updated += 1;
  }
  const removed = Math.max(0, previous.size - (fresh.length - added));
  return {
    table: { ...table, entries: [...keep, ...fresh] },
    added,
    updated,
    removed,
  };
}

function dedupeByKey(prices: FeedPrice[]): FeedPrice[] {
  const seen = new Map<string, FeedPrice>();
  for (const price of prices) {
    const existing = seen.get(price.key);
    if (!existing || price.value > existing.value) seen.set(price.key, price);
  }
  return [...seen.values()];
}

/** Hours since the newest feed entry of the source, from its note stamp. */
export function feedAgeHours(
  table: PriceTable,
  source: PriceFeedSource,
  now: Date = new Date(),
): number | undefined {
  let newest: number | undefined;
  for (const entry of table.entries) {
    if (!isFeedEntry(entry, source)) continue;
    const match = entry.note?.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (!match) continue;
    const time = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isFinite(time) && (newest === undefined || time > newest)) newest = time;
  }
  if (newest === undefined) return undefined;
  return Math.max(0, (now.getTime() - newest) / 3_600_000);
}
