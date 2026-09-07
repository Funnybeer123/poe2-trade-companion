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

export interface ScoutLeagueCandidate {
  /** League name as the APIs spell it (the trade2 URL segment too). */
  value: string;
  /** Divine Orb rate in exalted, when the feed reports one. */
  divinePrice?: number;
}

/**
 * Every current softcore trade league from /poe2/Leagues, in API order.
 * poe2scout keeps a league "current" past its end while a new one runs
 * (2026-09-07: "Forbidden Rites" AND "Runes of Aldur"), so a caller must
 * not assume one — see currentScoutLeague / AmbiguousLeagueError.
 */
export function currentScoutLeagues(payload: unknown): ScoutLeagueCandidate[] {
  if (!Array.isArray(payload)) return [];
  const candidates: ScoutLeagueCandidate[] = [];
  for (const raw of payload as ScoutLeague[]) {
    if (typeof raw !== "object" || raw === null) continue;
    if (raw.IsCurrent !== true || typeof raw.Value !== "string") continue;
    const value = raw.Value.trim();
    if (!value || /^HC /i.test(value) || /hardcore/i.test(value)) continue;
    const divinePrice =
      typeof raw.DivinePrice === "number" && Number.isFinite(raw.DivinePrice) && raw.DivinePrice > 0
        ? round(raw.DivinePrice)
        : undefined;
    candidates.push({ value, ...(divinePrice !== undefined ? { divinePrice } : {}) });
  }
  return candidates;
}

/**
 * The current softcore trade league when exactly one exists; undefined when
 * there is none OR more than one (an ambiguity the caller must surface, not
 * a coin flip).
 */
export function currentScoutLeague(payload: unknown): string | undefined {
  const candidates = currentScoutLeagues(payload);
  return candidates.length === 1 ? candidates[0]!.value : undefined;
}

function describeCandidate(candidate: ScoutLeagueCandidate): string {
  return candidate.divinePrice !== undefined
    ? `${candidate.value} (divine ≈ ${Math.round(candidate.divinePrice)} ex)`
    : candidate.value;
}

export function formatAmbiguousLeagueMessage(candidates: readonly ScoutLeagueCandidate[]): string {
  return (
    `more than one current league: ${candidates.map(describeCandidate).join(", ")} — ` +
    "pick one in Tools → Settings → Market data or pass --league=NAME"
  );
}

/** Thrown when league "auto" cannot pick between several current leagues. */
export class AmbiguousLeagueError extends Error {
  readonly candidates: ScoutLeagueCandidate[];

  constructor(candidates: readonly ScoutLeagueCandidate[]) {
    super(formatAmbiguousLeagueMessage(candidates));
    this.name = "AmbiguousLeagueError";
    this.candidates = [...candidates];
  }
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

// ---------------------------------------------------------------------------
// Persisted snapshot (configDir/feed-snapshot.json)
// ---------------------------------------------------------------------------

const FEED_SOURCES: readonly PriceFeedSource[] = ["poe2scout", "poe-ninja", "exchange-ocr"];

/**
 * Validate a snapshot read back from disk (unknown JSON). Prices that would
 * not have passed normalization are dropped; a snapshot missing its
 * envelope is rejected outright.
 */
export function parseFeedSnapshot(value: unknown): PriceFeedSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<Record<keyof PriceFeedSnapshot, unknown>>;
  if (!FEED_SOURCES.includes(raw.source as PriceFeedSource)) return undefined;
  if (typeof raw.league !== "string" || !raw.league.trim()) return undefined;
  if (typeof raw.fetchedAt !== "string" || !Number.isFinite(Date.parse(raw.fetchedAt))) {
    return undefined;
  }
  if (!Array.isArray(raw.prices)) return undefined;
  const prices: FeedPrice[] = [];
  for (const entry of raw.prices) {
    if (typeof entry !== "object" || entry === null) continue;
    const price = entry as Partial<FeedPrice>;
    if (typeof price.key !== "string" || !price.key) continue;
    if (typeof price.name !== "string" || !price.name.trim()) continue;
    if (typeof price.value !== "number" || !Number.isFinite(price.value) || price.value <= 0) continue;
    prices.push({
      key: price.key,
      name: price.name.trim(),
      value: price.value,
      ...(typeof price.baseType === "string" && price.baseType.trim()
        ? { baseType: price.baseType.trim() }
        : {}),
      ...(typeof price.quantity === "number" && price.quantity > 0
        ? { quantity: Math.floor(price.quantity) }
        : {}),
      ...(price.unique === true ? { unique: true } : {}),
    });
  }
  return {
    source: raw.source as PriceFeedSource,
    league: raw.league.trim(),
    fetchedAt: raw.fetchedAt,
    prices,
  };
}

export interface ApplySnapshotOptions {
  now?: Date;
  /**
   * The configured league ("auto" or a name). A snapshot for a different
   * pinned league is not applied — its prices are for another economy.
   */
  league?: string;
}

export interface ApplySnapshotResult extends MergeResult {
  /** False when the table already had feed data at least as fresh. */
  applied: boolean;
  /** True when the merge changed at least one entry (worth saving). */
  changed: boolean;
}

/**
 * Merge a persisted snapshot into the table only when it is fresher than
 * what the table already carries from the same source. Lets a process that
 * never refreshes (a CLI, the app on a cold start) price off the newest
 * fetch any process made, without a network round trip.
 */
export function applyFeedSnapshotIfNewer(
  table: PriceTable,
  snapshot: PriceFeedSnapshot,
  options: ApplySnapshotOptions = {},
): ApplySnapshotResult {
  const skip: ApplySnapshotResult = { table, added: 0, updated: 0, removed: 0, applied: false, changed: false };
  if (snapshot.prices.length === 0) return skip;
  if (options.league && options.league !== "auto" && options.league !== snapshot.league) return skip;
  const now = options.now ?? new Date();
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return skip;
  const snapshotAgeHours = Math.max(0, (now.getTime() - fetchedAt) / 3_600_000);
  const tableAgeHours = feedAgeHours(table, snapshot.source, now);
  if (tableAgeHours !== undefined && snapshotAgeHours >= tableAgeHours) return skip;
  const merged = mergeFeedSnapshot(table, snapshot);
  // Same values on a newer day still change the notes' date stamps (what
  // feedAgeHours reads), so a day change counts as a change too.
  const tableDay =
    tableAgeHours === undefined
      ? undefined
      : new Date(now.getTime() - tableAgeHours * 3_600_000).toISOString().slice(0, 10);
  const dayChanged = tableDay !== snapshot.fetchedAt.slice(0, 10);
  return {
    ...merged,
    applied: true,
    changed: dayChanged || merged.added + merged.updated + merged.removed > 0,
  };
}
