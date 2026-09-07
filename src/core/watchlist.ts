/**
 * Deal sniper watchlist: which trade2 searches to re-run on a timer, and
 * which of the listings that come back are cheap enough to be worth a
 * whisper.
 *
 * Everything here is pure. The main-process service (watchlistService.ts)
 * owns the clock, the files, the trade2 budget and the notifications; this
 * module builds the search body for a watch, turns a fetched sample into
 * alerts, decides which watch is due next, and (de)serializes both files.
 *
 * Decision support only: an alert carries the seller's ready-to-paste
 * whisper so the user can copy it. Nothing in the app sends a whisper,
 * buys, or lists.
 *
 * Reference price:
 *   - a unique watch uses the poe2scout feed row for name + base type when
 *     the price table has one (a `feed:*` id) — the market's own number;
 *   - every other watch (and a unique the feed does not list) uses the
 *     MEDIAN of the priced sample. The sample is the cheapest listings the
 *     search found, so the median is a floor-band figure: an alert is a
 *     listing well under even that.
 */

import { isFeedEntry } from "./priceFeed.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import { statIdsForModText, type StatCatalogue } from "./statIds.js";
import { listingPriceInExalted, magicBaseType, type CompListing } from "./tradeComps.js";

export type WatchKind = "unique" | "stat-filtered" | "base-type";

export interface WatchStat {
  /** Mod family (modKnowledge.ts id) the listing must carry. */
  familyId: string;
  /** Minimum roll (trade2 `value.min`); 0 = presence only. */
  min: number;
  /**
   * The exact Ctrl+C mod line the stat came from, when known: it keys the
   * precise catalogue id where the family's other ids would match the
   * wrong mod ("Adds # to # Fire Damage" vs its cold sibling).
   */
  text?: string;
}

export interface WatchQuery {
  /** Unique name (kind "unique"). */
  name?: string;
  baseType?: string;
  /** Ctrl+C "Item Class:" value; used as a trade2 category when no base type is set. */
  itemClass?: string;
  rarity?: string;
  stats?: WatchStat[];
  minItemLevel?: number;
}

export interface Watch {
  id: string;
  label: string;
  enabled: boolean;
  kind: WatchKind;
  query: WatchQuery;
  /** A listing alerts at or under this share of the reference price. */
  thresholdPercent: number;
  /** Listings the sample must price before any alert is trusted. */
  minSample: number;
  intervalMinutes: number;
  lastScanAt?: string;
  lastReferenceExalted?: number;
}

export interface DealAlert {
  /** Deterministic: `${watchId}:${listingId}:${askExalted}` — a re-raise at a lower ask is a new alert. */
  id: string;
  at: string;
  watchId: string;
  listingId: string;
  name: string;
  baseType: string;
  askExalted: number;
  ask: { amount: number; currency: string };
  referenceExalted: number;
  /** Rounded whole percent under the reference. */
  discountPercent: number;
  accountName?: string;
  indexed?: string;
  whisper?: string;
}

export const DEFAULT_THRESHOLD_PERCENT = 60;
export const DEFAULT_MIN_SAMPLE = 4;
export const DEFAULT_INTERVAL_MINUTES = 10;
/** Listings fetched per scan (one fetch call carries up to ten ids). */
export const WATCH_SAMPLE_SIZE = 10;

export const WATCH_KINDS: readonly WatchKind[] = ["unique", "stat-filtered", "base-type"];

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Ctrl+C item classes → trade2 `type_filters.category` options, used only
 * when a watch names a class WITHOUT a base type (a base already implies
 * its class). PoE2 option ids follow the PoE1 scheme; not every entry has
 * been exercised live, so an unknown class simply omits the filter.
 */
const CATEGORY_BY_CLASS: Readonly<Record<string, string>> = {
  rings: "accessory.ring",
  amulets: "accessory.amulet",
  belts: "accessory.belt",
  "body armours": "armour.chest",
  helmets: "armour.helmet",
  gloves: "armour.gloves",
  boots: "armour.boots",
  shields: "armour.shield",
  quivers: "armour.quiver",
  foci: "armour.focus",
  bucklers: "armour.buckler",
  bows: "weapon.bow",
  crossbows: "weapon.crossbow",
  wands: "weapon.wand",
  staves: "weapon.staff",
  quarterstaves: "weapon.warstaff",
  sceptres: "weapon.sceptre",
  "one hand maces": "weapon.onemace",
  "two hand maces": "weapon.twomace",
  spears: "weapon.spear",
  flails: "weapon.flail",
  jewels: "jewel",
};

export function tradeCategoryForClass(itemClass: string | undefined): string | undefined {
  if (!itemClass) return undefined;
  return CATEGORY_BY_CLASS[itemClass.trim().toLowerCase()];
}

/** Item classes a base-type watch can name without a base (for the form's picker). */
export const WATCH_ITEM_CLASSES: readonly string[] = [
  "Rings",
  "Amulets",
  "Belts",
  "Body Armours",
  "Helmets",
  "Gloves",
  "Boots",
  "Shields",
  "Quivers",
  "Foci",
  "Bucklers",
  "Bows",
  "Crossbows",
  "Wands",
  "Staves",
  "Quarterstaves",
  "Sceptres",
  "One Hand Maces",
  "Two Hand Maces",
  "Spears",
  "Flails",
  "Jewels",
];

export function newWatchId(): string {
  return `watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The slice of an item the "Watch this item" button reads. */
export interface WatchableItem {
  name: string;
  baseType: string;
  rarity: string;
  itemClass?: string;
  itemLevel?: number;
}

/** The slice of an appraisal mod a stat watch is built from. */
export interface WatchableMod {
  text: string;
  familyId?: string;
  judgedValue?: number;
  tier?: number;
  /** False for implicit/enchant/rune lines — never seeds a stat filter. */
  affix?: boolean;
  points: number;
}

/** Notable mods first: highest appraisal points, then the strongest roll. */
export function notableModsForWatch(mods: readonly WatchableMod[], limit = 3): WatchStat[] {
  const stats: WatchStat[] = [];
  const seen = new Set<string>();
  const notable = mods
    .filter(
      (mod): mod is WatchableMod & { familyId: string; judgedValue: number } =>
        typeof mod.familyId === "string" &&
        typeof mod.judgedValue === "number" &&
        mod.judgedValue > 0 &&
        mod.tier !== undefined &&
        mod.tier >= 1,
    )
    .sort((a, b) => b.points - a.points || b.judgedValue - a.judgedValue);
  for (const mod of notable) {
    if (stats.length >= limit) break;
    if (seen.has(mod.familyId)) continue;
    seen.add(mod.familyId);
    // One tier of slack, like the comps stat stage: a listing rolled a hair
    // under ours is the same market.
    stats.push({ familyId: mod.familyId, min: Math.floor(mod.judgedValue * 0.85), text: mod.text });
  }
  return stats;
}

/**
 * A watch for the item on screen: a unique watches its name + base; a rare
 * with notable mods watches its base with those mods as stat filters; any
 * other item watches its base (item level 78+ when the item is there).
 */
export function watchForItem(
  item: WatchableItem,
  appraisal: { mods: readonly WatchableMod[] } | undefined,
  id: string = newWatchId(),
): Watch {
  const base = {
    id,
    enabled: true,
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    minSample: DEFAULT_MIN_SAMPLE,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
  const rarity = item.rarity.trim().toLowerCase();
  if (rarity === "unique" && item.name.trim()) {
    const query: WatchQuery = {
      name: item.name.trim(),
      ...(item.baseType.trim() ? { baseType: item.baseType.trim() } : {}),
    };
    return { ...base, kind: "unique", query, label: defaultLabel("unique", query) };
  }
  const baseType =
    rarity === "magic" && item.baseType === item.name ? magicBaseType(item.name) : item.baseType.trim();
  const itemLevel = item.itemLevel ?? 0;
  const common: WatchQuery = {
    ...(baseType ? { baseType } : {}),
    ...(item.itemClass?.trim() ? { itemClass: item.itemClass.trim() } : {}),
    rarity: "nonunique",
    ...(itemLevel >= 78 ? { minItemLevel: 78 } : {}),
  };
  const stats = appraisal ? notableModsForWatch(appraisal.mods.filter((mod) => mod.affix !== false)) : [];
  if (stats.length > 0) {
    const query: WatchQuery = { ...common, stats };
    return { ...base, kind: "stat-filtered", query, label: defaultLabel("stat-filtered", query) };
  }
  return { ...base, kind: "base-type", query: common, label: defaultLabel("base-type", common) };
}

function baseFilters(watch: Watch, category: string | undefined): Record<string, unknown> {
  const typeFilters: Record<string, unknown> = { rarity: { option: "nonunique" } };
  if (category) typeFilters.category = { option: category };
  const filters: Record<string, unknown> = { type_filters: { filters: typeFilters } };
  const minLevel = watch.query.minItemLevel ?? 0;
  if (minLevel > 0) filters.misc_filters = { filters: { ilvl: { min: minLevel } } };
  return filters;
}

/** Stat ids for one watch stat: the exact line's ids, else a small family. */
function statIdsFor(stat: WatchStat, statIds: StatCatalogue): string[] {
  const exact = stat.text ? statIdsForModText(statIds, stat.text) : [];
  if (exact.length > 0) return exact;
  const family = statIds.byFamily.get(stat.familyId) ?? [];
  return family.length > 0 && family.length <= 4 ? family : [];
}

/**
 * The POST body for /api/trade2/search/poe2/{league}, cheapest first and
 * online sellers only. Undefined when the watch cannot be expressed: a
 * unique without a name, a base-type watch with neither base nor class, or
 * a stat watch whose families the catalogue does not resolve (or with no
 * catalogue at all).
 */
export function buildWatchQuery(
  watch: Watch,
  statIds?: StatCatalogue,
): Record<string, unknown> | undefined {
  const status = { option: "online" };
  const sort = { price: "asc" };
  const baseType = watch.query.baseType?.trim();
  if (watch.kind === "unique") {
    const name = watch.query.name?.trim();
    if (!name) return undefined;
    return {
      query: { status, name, ...(baseType ? { type: baseType } : {}) },
      sort,
    };
  }
  const category = baseType ? undefined : tradeCategoryForClass(watch.query.itemClass);
  if (watch.kind === "base-type") {
    if (!baseType && !category) return undefined;
    return {
      query: {
        status,
        ...(baseType ? { type: baseType } : {}),
        filters: baseFilters(watch, category),
      },
      sort,
    };
  }
  // stat-filtered
  if (!statIds) return undefined;
  const andFilters: Array<Record<string, unknown>> = [];
  const countGroups: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const stat of watch.query.stats ?? []) {
    if (seen.has(stat.familyId)) continue;
    const ids = statIdsFor(stat, statIds);
    if (ids.length === 0) continue;
    seen.add(stat.familyId);
    const min = Math.floor(stat.min);
    const filter = (id: string) => (min > 0 ? { id, value: { min } } : { id });
    if (ids.length === 1) andFilters.push(filter(ids[0]!));
    else countGroups.push({ type: "count", value: { min: 1 }, filters: ids.map(filter) });
  }
  if (andFilters.length === 0 && countGroups.length === 0) return undefined;
  if (!baseType && !category) return undefined;
  const stats: Array<Record<string, unknown>> = [];
  if (andFilters.length > 0) stats.push({ type: "and", filters: andFilters });
  stats.push(...countGroups);
  return {
    query: {
      status,
      ...(baseType ? { type: baseType } : {}),
      stats,
      filters: baseFilters(watch, category),
    },
    sort,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluateWatchOptions {
  priceTable: PriceTable;
  /** Override the reference (tests, or a pinned number); otherwise feed → median. */
  referenceExalted?: number;
  /** listingId → lowest ask (exalted) already alerted; see seenAsks(). */
  seen?: ReadonlyMap<string, number>;
  now?: Date;
}

export interface PricedListing {
  listing: CompListing;
  askExalted: number;
}

export interface WatchSummary {
  /** Listings that priced in exalted. */
  sample: number;
  referenceExalted?: number;
  referenceBasis?: "feed" | "median" | "given";
  priced: PricedListing[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The feed's price for a unique watch, when the table carries a feed row for it. */
export function feedReference(watch: Watch, priceTable: PriceTable): number | undefined {
  if (watch.kind !== "unique") return undefined;
  const name = watch.query.name?.trim();
  if (!name) return undefined;
  const hit = lookupPrice(priceTable, {
    name,
    ...(watch.query.baseType ? { baseType: watch.query.baseType } : {}),
    rarity: "Unique",
  });
  if (!hit || !isFeedEntry(hit.entry) || !(hit.value > 0)) return undefined;
  // A feed row keyed on the base as well must be the same base.
  if (
    hit.entry.match.baseType &&
    watch.query.baseType &&
    hit.entry.match.baseType.trim().toLowerCase() !== watch.query.baseType.trim().toLowerCase()
  ) {
    return undefined;
  }
  return hit.value;
}

/** Price the sample and pick the reference — the numbers evaluateWatch alerts against. */
export function summarizeWatch(
  watch: Watch,
  listings: readonly CompListing[],
  options: EvaluateWatchOptions,
): WatchSummary {
  const priced: PricedListing[] = [];
  for (const listing of listings) {
    const askExalted = listingPriceInExalted(listing, options.priceTable);
    if (askExalted === undefined || !(askExalted > 0)) continue;
    priced.push({ listing, askExalted });
  }
  priced.sort((a, b) => a.askExalted - b.askExalted);
  const given =
    typeof options.referenceExalted === "number" && options.referenceExalted > 0
      ? options.referenceExalted
      : undefined;
  const feed = given === undefined ? feedReference(watch, options.priceTable) : undefined;
  const mid = given === undefined && feed === undefined
    ? median(priced.map((entry) => entry.askExalted))
    : undefined;
  const referenceExalted = given ?? feed ?? mid;
  const referenceBasis: WatchSummary["referenceBasis"] =
    given !== undefined ? "given" : feed !== undefined ? "feed" : mid !== undefined ? "median" : undefined;
  return {
    sample: priced.length,
    ...(referenceExalted !== undefined ? { referenceExalted } : {}),
    ...(referenceBasis ? { referenceBasis } : {}),
    priced,
  };
}

export function alertId(watchId: string, listingId: string, askExalted: number): string {
  return `${watchId}:${listingId}:${askExalted}`;
}

/**
 * Alerts for one scan: every priced listing at or under
 * thresholdPercent × reference, once the sample is large enough to trust.
 * A listing already alerted (`seen`) is raised again only when its ask has
 * dropped below the ask it was alerted at.
 */
export function evaluateWatch(
  watch: Watch,
  listings: readonly CompListing[],
  options: EvaluateWatchOptions,
): DealAlert[] {
  const summary = summarizeWatch(watch, listings, options);
  const minSample = Math.max(1, watch.minSample);
  if (summary.sample < minSample || summary.referenceExalted === undefined) return [];
  const reference = summary.referenceExalted;
  const ceiling = (Math.max(1, Math.min(100, watch.thresholdPercent)) / 100) * reference;
  const at = (options.now ?? new Date()).toISOString();
  const alerts: DealAlert[] = [];
  for (const { listing, askExalted } of summary.priced) {
    if (askExalted > ceiling + 1e-9) continue;
    const previous = options.seen?.get(listing.id);
    if (previous !== undefined && askExalted >= previous) continue;
    alerts.push({
      id: alertId(watch.id, listing.id, askExalted),
      at,
      watchId: watch.id,
      listingId: listing.id,
      name: listing.name,
      baseType: listing.baseType,
      askExalted,
      ask: { amount: listing.priceAmount, currency: listing.priceCurrency },
      referenceExalted: reference,
      discountPercent: Math.max(0, Math.round((1 - askExalted / reference) * 100)),
      ...(listing.accountName ? { accountName: listing.accountName } : {}),
      ...(listing.indexed ? { indexed: listing.indexed } : {}),
      ...(listing.whisper ? { whisper: listing.whisper } : {}),
    });
  }
  return alerts;
}

/** listingId → the lowest ask ever alerted for it, from the alert history. */
export function seenAsks(alerts: readonly DealAlert[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const alert of alerts) {
    const previous = seen.get(alert.listingId);
    if (previous === undefined || alert.askExalted < previous) seen.set(alert.listingId, alert.askExalted);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function lastScanMs(watch: Watch): number {
  const parsed = watch.lastScanAt ? Date.parse(watch.lastScanAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function dueAt(watch: Watch): number {
  const last = lastScanMs(watch);
  return last === 0 ? 0 : last + Math.max(1, watch.intervalMinutes) * 60_000;
}

/**
 * The enabled watch to scan next: due (never scanned, or past its interval)
 * and longest since its last scan. Ties keep list order. Undefined when
 * nothing is due.
 */
export function scheduleNextWatch(watches: readonly Watch[], now: Date | number): Watch | undefined {
  const nowMs = typeof now === "number" ? now : now.getTime();
  let best: Watch | undefined;
  for (const watch of watches) {
    if (!watch.enabled) continue;
    if (dueAt(watch) > nowMs) continue;
    if (!best || lastScanMs(watch) < lastScanMs(best)) best = watch;
  }
  return best;
}

/** Milliseconds until some enabled watch is due (0 when one already is); undefined when none is enabled. */
export function nextScanEtaMs(watches: readonly Watch[], now: Date | number): number | undefined {
  const nowMs = typeof now === "number" ? now : now.getTime();
  let eta: number | undefined;
  for (const watch of watches) {
    if (!watch.enabled) continue;
    const wait = Math.max(0, dueAt(watch) - nowMs);
    if (eta === undefined || wait < eta) eta = wait;
  }
  return eta;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface WatchlistFile {
  /** Master switch: the scheduler ticks only while this is on. */
  enabled: boolean;
  /** Raise an OS notification for every new alert. */
  notifications: boolean;
  watches: Watch[];
  /** Alert ids the user dismissed (hidden from the list; the history stays). */
  dismissed: string[];
  /** Epoch ms of scans in the last hour (the 20/hour cap survives a restart). */
  scanLog: number[];
}

export const MAX_WATCHES = 40;
export const MAX_DISMISSED = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(low, Math.min(high, Math.round(num)));
}

function finiteNonNegative(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function sanitizeStats(value: unknown): WatchStat[] {
  if (!Array.isArray(value)) return [];
  const stats: WatchStat[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const familyId = optionalString(raw.familyId, 80);
    if (!familyId) continue;
    const min = finiteNonNegative(raw.min) ?? 0;
    const text = optionalString(raw.text, 200);
    stats.push({ familyId, min: Math.floor(min), ...(text ? { text } : {}) });
    if (stats.length >= 6) break;
  }
  return stats;
}

/**
 * A Watch from untrusted JSON (the file, an IPC payload). Junk fields fall
 * back to defaults; a record without a usable kind returns undefined.
 */
export function sanitizeWatch(input: unknown, fallbackId?: string): Watch | undefined {
  if (!isRecord(input)) return undefined;
  const kind = optionalString(input.kind);
  if (!kind || !WATCH_KINDS.includes(kind as WatchKind)) return undefined;
  const id = optionalString(input.id, 80) ?? fallbackId;
  if (!id) return undefined;
  const rawQuery = isRecord(input.query) ? input.query : {};
  const minItemLevel = finiteNonNegative(rawQuery.minItemLevel);
  const query: WatchQuery = {
    ...(optionalString(rawQuery.name) ? { name: optionalString(rawQuery.name) } : {}),
    ...(optionalString(rawQuery.baseType) ? { baseType: optionalString(rawQuery.baseType) } : {}),
    ...(optionalString(rawQuery.itemClass) ? { itemClass: optionalString(rawQuery.itemClass) } : {}),
    ...(optionalString(rawQuery.rarity) ? { rarity: optionalString(rawQuery.rarity) } : {}),
    ...(minItemLevel !== undefined && minItemLevel > 0
      ? { minItemLevel: Math.min(100, Math.floor(minItemLevel)) }
      : {}),
  };
  const stats = sanitizeStats(rawQuery.stats);
  if (stats.length > 0) query.stats = stats;
  const lastScanAt = optionalString(input.lastScanAt, 40);
  const lastReference = finiteNonNegative(input.lastReferenceExalted);
  return {
    id,
    label: optionalString(input.label) ?? defaultLabel(kind as WatchKind, query),
    enabled: input.enabled !== false,
    kind: kind as WatchKind,
    query,
    thresholdPercent: clampInt(input.thresholdPercent, 1, 100, DEFAULT_THRESHOLD_PERCENT),
    minSample: clampInt(input.minSample, 1, WATCH_SAMPLE_SIZE, DEFAULT_MIN_SAMPLE),
    intervalMinutes: clampInt(input.intervalMinutes, 1, 24 * 60, DEFAULT_INTERVAL_MINUTES),
    ...(lastScanAt && Number.isFinite(Date.parse(lastScanAt)) ? { lastScanAt } : {}),
    ...(lastReference !== undefined && lastReference > 0 ? { lastReferenceExalted: lastReference } : {}),
  };
}

/** "Temporalis (Silk Robe)", "Ruby Ring · ilvl 80+", "Ruby Ring · 2 stats". */
export function defaultLabel(kind: WatchKind, query: WatchQuery): string {
  if (kind === "unique") {
    return query.baseType ? `${query.name ?? "?"} (${query.baseType})` : (query.name ?? "Unique");
  }
  const base = query.baseType ?? query.itemClass ?? "Any base";
  const parts = [base];
  if (kind === "stat-filtered") parts.push(`${query.stats?.length ?? 0} stat${(query.stats?.length ?? 0) === 1 ? "" : "s"}`);
  if (query.minItemLevel) parts.push(`ilvl ${query.minItemLevel}+`);
  return parts.join(" · ");
}

export function emptyWatchlist(): WatchlistFile {
  return { enabled: false, notifications: true, watches: [], dismissed: [], scanLog: [] };
}

/** Sanitize a whole watch list; duplicate ids keep the first, the count is capped. */
export function sanitizeWatches(input: unknown): Watch[] {
  if (!Array.isArray(input)) return [];
  const watches: Watch[] = [];
  const ids = new Set<string>();
  input.forEach((raw, index) => {
    if (watches.length >= MAX_WATCHES) return;
    const watch = sanitizeWatch(raw, `watch-${index + 1}`);
    if (!watch || ids.has(watch.id)) return;
    ids.add(watch.id);
    watches.push(watch);
  });
  return watches;
}

/** The watchlist file from untrusted JSON text; junk is an empty list. */
export function parseWatchlist(text: string | undefined | null): WatchlistFile {
  const base = emptyWatchlist();
  if (!text || !text.trim()) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return base;
  }
  if (!isRecord(parsed)) return base;
  const dismissed = Array.isArray(parsed.dismissed)
    ? parsed.dismissed.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-MAX_DISMISSED)
    : [];
  const scanLog = Array.isArray(parsed.scanLog)
    ? parsed.scanLog.filter((at): at is number => typeof at === "number" && Number.isFinite(at))
    : [];
  return {
    enabled: parsed.enabled === true,
    notifications: parsed.notifications !== false,
    watches: sanitizeWatches(parsed.watches),
    dismissed,
    scanLog,
  };
}

export function serializeWatchlist(file: WatchlistFile): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      enabled: file.enabled,
      notifications: file.notifications,
      watches: file.watches,
      dismissed: file.dismissed.slice(-MAX_DISMISSED),
      scanLog: file.scanLog,
    },
    null,
    2,
  );
}

function sanitizeAlert(input: unknown): DealAlert | undefined {
  if (!isRecord(input)) return undefined;
  const watchId = optionalString(input.watchId, 80);
  const listingId = optionalString(input.listingId, 120);
  const askExalted = finiteNonNegative(input.askExalted);
  const referenceExalted = finiteNonNegative(input.referenceExalted);
  const at = optionalString(input.at, 40);
  if (!watchId || !listingId || askExalted === undefined || referenceExalted === undefined || !at) {
    return undefined;
  }
  const rawAsk = isRecord(input.ask) ? input.ask : {};
  const amount = finiteNonNegative(rawAsk.amount) ?? askExalted;
  const currency = optionalString(rawAsk.currency, 40) ?? "exalted";
  const discount = finiteNonNegative(input.discountPercent);
  const accountName = optionalString(input.accountName, 80);
  const indexed = optionalString(input.indexed, 40);
  const whisper = optionalString(input.whisper, 600);
  return {
    id: optionalString(input.id, 240) ?? alertId(watchId, listingId, askExalted),
    at,
    watchId,
    listingId,
    name: optionalString(input.name, 120) ?? "",
    baseType: optionalString(input.baseType, 120) ?? "",
    askExalted,
    ask: { amount, currency },
    referenceExalted,
    discountPercent:
      discount !== undefined
        ? Math.round(discount)
        : referenceExalted > 0
          ? Math.max(0, Math.round((1 - askExalted / referenceExalted) * 100))
          : 0,
    ...(accountName ? { accountName } : {}),
    ...(indexed ? { indexed } : {}),
    ...(whisper ? { whisper } : {}),
  };
}

/** deal-alerts.jsonl → alerts in file order; unreadable lines are skipped. */
export function parseDealAlerts(text: string | undefined | null): DealAlert[] {
  if (!text) return [];
  const alerts: DealAlert[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const alert = sanitizeAlert(JSON.parse(trimmed));
      if (alert) alerts.push(alert);
    } catch {
      // A torn or foreign line is not an alert.
    }
  }
  return alerts;
}

export function serializeDealAlert(alert: DealAlert): string {
  return JSON.stringify(alert);
}

/** "Deal: Temporalis 120 exalted (−45%)" — the OS notification title. */
export function alertTitle(alert: DealAlert): string {
  const name = alert.name || alert.baseType || "item";
  return `Deal: ${name} ${formatAsk(alert)} (−${alert.discountPercent}%)`;
}

export function alertBody(alert: DealAlert, watch?: Watch): string {
  const parts = [`Reference ${formatExalted(alert.referenceExalted)} ex`];
  if (alert.name && alert.baseType && alert.name !== alert.baseType) parts.push(alert.baseType);
  if (watch) parts.push(`watch "${watch.label}"`);
  parts.push("copy the whisper from Tools → Deals");
  return parts.join(" · ");
}

export function formatAsk(alert: Pick<DealAlert, "ask">): string {
  const amount = Number.isInteger(alert.ask.amount) ? String(alert.ask.amount) : alert.ask.amount.toFixed(2);
  return `${amount} ${alert.ask.currency}`;
}

function formatExalted(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value >= 10 ? 1 : 2);
}
