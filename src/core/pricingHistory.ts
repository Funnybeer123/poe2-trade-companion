/**
 * Pricing history (package "pricing-history"): the pure half of the Pricing
 * tool — row building, filtering, sorting, display units, SVG geometry and
 * the locally accumulated price timeline.
 *
 * WHY a local accumulation: poe2scout's `PriceLogs` carry ~7 daily bars per
 * item and nothing older. The Market trends service already caches those
 * bars for 12 h; merging every refresh into one file per league makes the
 * timeline grow day by day instead of being permanently seven days long.
 * The merge is keyed on the bar's ISO time, so re-merging the same cache
 * adds nothing and a revised same-day bar replaces the one we stored.
 *
 * Everything here is pure: no I/O, no clock of its own (callers pass `now`),
 * no DOM. Prices are poe2scout's daily medians — estimates, never guaranteed
 * sale prices.
 */

import { FALLBACK_DIVINE_RATE } from "./inventoryLedger.js";
import { FEED_ID_PREFIX, isFeedEntry } from "./priceFeed.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import { computeTrend, type Trend, type TrendPoint, type TrendSeries } from "./priceTrends.js";

export { FALLBACK_DIVINE_RATE };

export const PRICING_HISTORY_VERSION = 1 as const;
/** Price-table ids the poe2scout feed writes: `feed:poe2scout:<series key>`. */
export const FEED_KEY_PREFIX = `${FEED_ID_PREFIX}poe2scout:`;
/** Under this many units traded over 7 days the row is "low stock". */
export const LOW_STOCK_VOLUME_7D = 10;
/** Fewer bars than this in the 7-day window is also "low stock". */
export const LOW_STOCK_MIN_BARS = 2;
/** Per key: over a year of daily bars. Oldest bars are dropped past it. */
export const MAX_HISTORY_POINTS = 400;
/** A series beyond this cap is not added to a history file. */
export const MAX_HISTORY_KEYS = 5_000;
/** Keys never shrink below this many bars when the byte budget bites. */
export const MIN_HISTORY_POINTS = 7;
/**
 * Soft byte budget per league file (compliance review §9). 400 points ×
 * 5,000 keys would be ~40 MB; the oldest bars of the fattest keys go first.
 */
export const MAX_HISTORY_BYTES = 4_000_000;
export const MAX_FAVORITES = 200;
/** Sparkline sample cap — what crosses IPC per row. */
export const SPARK_POINTS = 14;

export type PricingSortKey = "name" | "price" | "change1d" | "change3d" | "change7d" | "volume7d";
export type PricingDisplayCurrency = "auto" | "exalted" | "divine";

export interface PricingSort {
  key: PricingSortKey;
  direction: "asc" | "desc";
}

export const PRICING_SORT_KEYS: readonly PricingSortKey[] = [
  "name",
  "price",
  "change1d",
  "change3d",
  "change7d",
  "volume7d",
];

export const DEFAULT_PRICING_SORT: PricingSort = { key: "change3d", direction: "desc" };

export const ALL_CATEGORY = "all";
export const FAVORITES_CATEGORY = "favorites";
/** Feed rows with no series at all: uniques and thin currencies. */
export const UNIQUES_CATEGORY = "uniques";
export const FEED_ONLY_CATEGORY = "feed";

/**
 * Category ids the trends service fetches (duplicated from
 * src/main/marketTrendsService.ts DEFAULT_TREND_CATEGORIES so core never
 * imports main), plus the two synthetic ones for rows without history.
 */
export const PRICING_CATEGORY_ORDER: readonly string[] = [
  "currency",
  "fragments",
  "essences",
  "breach",
  "ritual",
  "delirium",
  "expedition",
  "ultimatum",
  "abyss",
  "runes",
  "vaal",
  "uncutgems",
  UNIQUES_CATEGORY,
  FEED_ONLY_CATEGORY,
];

export const PRICING_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  currency: "Currency",
  fragments: "Fragments",
  essences: "Essences",
  breach: "Breach",
  ritual: "Ritual",
  delirium: "Delirium",
  expedition: "Expedition",
  ultimatum: "Ultimatum",
  abyss: "Abyss",
  runes: "Runes",
  vaal: "Vaal",
  uncutgems: "Uncut gems",
  [UNIQUES_CATEGORY]: "Uniques (no history)",
  [FEED_ONLY_CATEGORY]: "Other feed items (no history)",
};

/** Table hit, else a humanized id ("soulcores" → "Soulcores"). */
export function categoryLabel(id: string): string {
  const known = PRICING_CATEGORY_LABELS[id];
  if (known) return known;
  const text = id.replace(/[-_]+/g, " ").trim();
  if (!text) return "Other";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface PricingRow extends Partial<Trend> {
  /** Series key (== the feed key) — the stable row id. */
  key: string;
  name: string;
  baseType?: string;
  unique?: boolean;
  category: string;
  /** Price in exalted orbs. */
  current: number;
  /** False for feed-only rows: no bars, no changes, no sparkline. */
  hasHistory: boolean;
  lowStock: boolean;
  /** ≤ SPARK_POINTS prices, oldest → newest. */
  spark: number[];
  favorite: boolean;
}

export interface PricingCategory {
  id: string;
  label: string;
  count: number;
}

export interface BuildRowsInput {
  series: readonly TrendSeries[];
  /** Adds feed-only rows and the Divine fallback rate. */
  priceTable?: PriceTable;
  favorites: readonly string[];
  now: Date | string | number;
}

export interface BuildRowsResult {
  rows: PricingRow[];
  divineRate: number;
  divineRateSource: DivineRateSource;
  categories: PricingCategory[];
}

export type DivineRateSource = "feed" | "price-table" | "fallback";

export interface DivineRateInfo {
  rate: number;
  source: DivineRateSource;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `"feed:poe2scout:divine"` → `"divine"`; anything else → undefined. */
export function feedKeyOf(entryId: string): string | undefined {
  if (!entryId.startsWith(FEED_KEY_PREFIX)) return undefined;
  const key = entryId.slice(FEED_KEY_PREFIX.length).trim();
  return key || undefined;
}

/**
 * The exalted value of one Divine Orb: poe2scout's own divine series first
 * (it is the same economy the bars come from), then the user's price table,
 * then the repo-wide fallback.
 */
export function divineRateInfo(
  series: readonly TrendSeries[],
  priceTable?: PriceTable,
): DivineRateInfo {
  const feed = series.find((entry) => entry.key === "divine");
  const fromFeed = finitePositive(feed?.current) ?? finitePositive(feed?.points.at(-1)?.price);
  if (fromFeed !== undefined) return { rate: fromFeed, source: "feed" };
  if (priceTable) {
    // Look the row up directly instead of through divineRateOf(), which folds
    // "no row" and "a row that happens to hold the fallback number" into the
    // same value — the provenance we show the user must say which it was.
    const fromTable = finitePositive(lookupPrice(priceTable, { name: "Divine Orb" })?.value);
    if (fromTable !== undefined) return { rate: fromTable, source: "price-table" };
  }
  return { rate: FALLBACK_DIVINE_RATE, source: "fallback" };
}

export function divineRate(series: readonly TrendSeries[], priceTable?: PriceTable): number {
  return divineRateInfo(series, priceTable).rate;
}

export function isLowStock(trend: Pick<Trend, "volume7d" | "sampleSize">): boolean {
  return trend.volume7d < LOW_STOCK_VOLUME_7D || trend.sampleSize < LOW_STOCK_MIN_BARS;
}

/** ≤ max prices, always keeping the first and last bar. */
export function sampleSpark(points: readonly TrendPoint[], max = SPARK_POINTS): number[] {
  if (points.length === 0) return [];
  if (points.length <= max) return points.map((point) => point.price);
  const last = points.length - 1;
  const out: number[] = [];
  for (let index = 0; index < max; index += 1) {
    out.push(points[Math.round((index * last) / (max - 1))]!.price);
  }
  return out;
}

/**
 * One row per series (with history) plus one per poe2scout feed entry the
 * trends cache has no series for — so a global search finds every item the
 * app knows a price for, history or not.
 */
export function buildPricingRows(input: BuildRowsInput): BuildRowsResult {
  const favorites = new Set(input.favorites);
  const rate = divineRateInfo(input.series, input.priceTable);
  const rows: PricingRow[] = [];
  const seen = new Set<string>();

  for (const entry of input.series) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const trend = computeTrend(entry, input.now);
    rows.push({
      ...trend,
      key: entry.key,
      name: entry.name,
      ...(entry.baseType ? { baseType: entry.baseType } : {}),
      ...(entry.unique ? { unique: true } : {}),
      category: entry.category ?? (entry.unique ? UNIQUES_CATEGORY : FEED_ONLY_CATEGORY),
      current: trend.current,
      hasHistory: true,
      lowStock: isLowStock(trend),
      spark: sampleSpark(entry.points),
      favorite: favorites.has(entry.key),
    });
  }

  for (const entry of input.priceTable?.entries ?? []) {
    if (!isFeedEntry(entry, "poe2scout")) continue;
    const key = feedKeyOf(entry.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const unique = entry.match.rarity?.toLowerCase() === "unique";
    rows.push({
      key,
      name: entry.match.name ?? entry.match.baseType ?? key,
      ...(entry.match.baseType ? { baseType: entry.match.baseType } : {}),
      ...(unique ? { unique: true } : {}),
      category: unique ? UNIQUES_CATEGORY : FEED_ONLY_CATEGORY,
      current: entry.value,
      hasHistory: false,
      lowStock: false,
      spark: [],
      volume7d: 0,
      sampleSize: 0,
      favorite: favorites.has(key),
    });
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  const ordered: PricingCategory[] = [];
  for (const id of PRICING_CATEGORY_ORDER) {
    const count = counts.get(id);
    if (count) {
      ordered.push({ id, label: categoryLabel(id), count });
      counts.delete(id);
    }
  }
  for (const id of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    ordered.push({ id, label: categoryLabel(id), count: counts.get(id)! });
  }

  return { rows, divineRate: rate.rate, divineRateSource: rate.source, categories: ordered };
}

// ---------------------------------------------------------------------------
// Display units
// ---------------------------------------------------------------------------

export interface DisplayPrice {
  amount: number;
  unit: "ex" | "div";
  text: string;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Locale-free grouping so the same number reads the same in every test. */
export function formatPriceNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole = "0", fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction ? fraction.replace(/0+$/, "") : "";
  const sign = value < 0 ? "-" : "";
  return trimmed ? `${sign}${grouped}.${trimmed}` : `${sign}${grouped}`;
}

/**
 * `auto` shows anything worth a Divine Orb or more in divine and everything
 * else in exalted; the user can pin either unit. Both are estimates.
 */
export function displayPrice(
  exalted: number,
  rate: number,
  mode: PricingDisplayCurrency,
): DisplayPrice {
  const safeRate = finitePositive(rate) ?? FALLBACK_DIVINE_RATE;
  const value = Number.isFinite(exalted) ? exalted : 0;
  const asDivine = mode === "divine" || (mode === "auto" && value >= safeRate);
  if (!asDivine) {
    const amount = round(value, 2);
    return { amount, unit: "ex", text: `${formatPriceNumber(amount, 2)} ex` };
  }
  const divine = value / safeRate;
  if (divine > 0 && divine < 0.005) return { amount: round(divine, 4), unit: "div", text: "<0.01 div" };
  const decimals = divine >= 1 ? 2 : 4;
  const amount = round(divine, decimals);
  return { amount, unit: "div", text: `${formatPriceNumber(amount, decimals)} div` };
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

export interface RowFilter {
  /** ALL_CATEGORY | FAVORITES_CATEGORY | a category id. */
  category: string;
  search: string;
  hideLowStock: boolean;
}

export interface FilterResult {
  rows: PricingRow[];
  hiddenLowStock: number;
}

/** Every whitespace-separated token must appear in the name or base type. */
export function matchesSearch(row: Pick<PricingRow, "name" | "baseType">, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${row.name} ${row.baseType ?? ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function filterRows(rows: readonly PricingRow[], filter: RowFilter): FilterResult {
  const out: PricingRow[] = [];
  let hiddenLowStock = 0;
  for (const row of rows) {
    if (filter.category === FAVORITES_CATEGORY) {
      if (!row.favorite) continue;
    } else if (filter.category !== ALL_CATEGORY && row.category !== filter.category) {
      continue;
    }
    if (!matchesSearch(row, filter.search)) continue;
    // Feed-only rows have no volume to judge, so they are never "low stock".
    if (filter.hideLowStock && row.hasHistory && row.lowStock) {
      hiddenLowStock += 1;
      continue;
    }
    out.push(row);
  }
  return { rows: out, hiddenLowStock };
}

function readingOf(row: PricingRow, key: PricingSortKey): number | undefined {
  switch (key) {
    case "price":
      return row.current;
    case "change1d":
      return row.change1d;
    case "change3d":
      return row.change3d;
    case "change7d":
      return row.change7d;
    case "volume7d":
      return row.volume7d;
    default:
      return undefined;
  }
}

/** Rows without the sorted reading always sink, in both directions. */
export function sortRows(rows: readonly PricingRow[], sort: PricingSort): PricingRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((left, right) => {
    if (sort.key === "name") return left.name.localeCompare(right.name) * direction;
    const a = readingOf(left, sort.key);
    const b = readingOf(right, sort.key);
    if (a === undefined && b === undefined) return left.name.localeCompare(right.name);
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (a !== b) return (a - b) * direction;
    return left.name.localeCompare(right.name);
  });
  return copy;
}

export function normalizeSort(raw: unknown): PricingSort {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PricingSort>;
  const key = PRICING_SORT_KEYS.includes(source.key as PricingSortKey)
    ? (source.key as PricingSortKey)
    : DEFAULT_PRICING_SORT.key;
  const direction = source.direction === "asc" ? "asc" : "desc";
  return { key, direction };
}

// ---------------------------------------------------------------------------
// SVG geometry (no DOM)
// ---------------------------------------------------------------------------

export interface SparkGeometry {
  path: string;
  min: number;
  max: number;
  last?: { x: number; y: number };
}

function coordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

export function sparklinePath(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): SparkGeometry {
  if (values.length === 0) return { path: "", min: 0, max: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const innerWidth = Math.max(1, width - 2 * pad);
  const innerHeight = Math.max(1, height - 2 * pad);
  const points = values.map((value, index) => {
    const x =
      values.length === 1 ? pad + innerWidth / 2 : pad + (index * innerWidth) / (values.length - 1);
    const y = max === min ? pad + innerHeight / 2 : pad + ((max - value) / (max - min)) * innerHeight;
    return { x: coordinate(x), y: coordinate(y) };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  return { path, min, max, last: points.at(-1)! };
}

export interface TimelineBar {
  x: number;
  y: number;
  width: number;
  height: number;
  time: string;
  quantity: number;
  price: number;
  priceText: string;
}

export interface TimelineGeometry {
  pricePath: string;
  bars: TimelineBar[];
  /** One per bar; only every ⌈n/8⌉th carries a label. */
  ticks: Array<{ x: number; label: string }>;
  priceTicks: Array<{ y: number; label: string }>;
  min: number;
  max: number;
  unit: "ex" | "div";
}

const PLOT_INSETS = { left: 48, right: 16, top: 12, bottom: 28 } as const;

/** `2026-09-12T00:00:00.000Z` → `09-12`; anything unparsable stays verbatim. */
export function barLabel(time: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(5, 10) : time;
}

export function timelineGeometry(
  points: readonly TrendPoint[],
  size: { width: number; height: number },
  rate: number,
  mode: PricingDisplayCurrency,
): TimelineGeometry {
  const empty: TimelineGeometry = {
    pricePath: "",
    bars: [],
    ticks: [],
    priceTicks: [],
    min: 0,
    max: 0,
    unit: "ex",
  };
  if (points.length === 0) return empty;

  const left = PLOT_INSETS.left;
  const top = PLOT_INSETS.top;
  const plotWidth = Math.max(1, size.width - PLOT_INSETS.left - PLOT_INSETS.right);
  const plotHeight = Math.max(1, size.height - PLOT_INSETS.top - PLOT_INSETS.bottom);
  const bottom = top + plotHeight;

  // One unit for the whole window, chosen from the most expensive bar: a
  // series that crosses one divine must not be plotted half in exalted and
  // half in divine (that reads as a 99 % crash that never happened).
  const safeRate = finitePositive(rate) ?? FALLBACK_DIVINE_RATE;
  const unit = displayPrice(Math.max(...points.map((point) => point.price)), rate, mode).unit;
  const pinned: PricingDisplayCurrency = unit === "div" ? "divine" : "exalted";
  const displayed = points.map((point) => displayPrice(point.price, rate, pinned));
  // Plot the unrounded value — displayPrice rounds to 4 decimals, which would
  // flatten a cheap item's curve to a handful of steps in pinned Divine mode.
  const values = points.map((point) => {
    const exalted = Number.isFinite(point.price) ? point.price : 0;
    return unit === "div" ? exalted / safeRate : exalted;
  });
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xOf = (index: number): number =>
    points.length === 1 ? left + plotWidth / 2 : left + (index * plotWidth) / (points.length - 1);
  const yOf = (value: number): number =>
    max === min ? top + plotHeight / 2 : top + ((max - value) / (max - min)) * plotHeight;

  const pricePath = values
    .map((value, index) => `${index === 0 ? "M" : "L"} ${coordinate(xOf(index))} ${coordinate(yOf(value))}`)
    .join(" ");

  const maxQuantity = Math.max(1, ...points.map((point) => point.quantity));
  const barWidth = Math.max(2, (plotWidth / points.length) * 0.6);
  const bars: TimelineBar[] = points.map((point, index) => {
    const height = (point.quantity / maxQuantity) * plotHeight * 0.35;
    return {
      x: coordinate(xOf(index) - barWidth / 2),
      y: coordinate(bottom - height),
      width: coordinate(barWidth),
      height: coordinate(height),
      time: point.time,
      quantity: point.quantity,
      price: point.price,
      priceText: displayed[index]!.text,
    };
  });

  const step = Math.max(1, Math.ceil(points.length / 8));
  const ticks = points.map((point, index) => ({
    x: coordinate(xOf(index)),
    label: index % step === 0 || index === points.length - 1 ? barLabel(point.time) : "",
  }));

  const mid = (min + max) / 2;
  const decimals = unit === "div" && max < 1 ? 4 : 2;
  const priceTicks = [max, mid, min].map((value) => ({
    y: coordinate(yOf(value)),
    label: `${formatPriceNumber(value, decimals)} ${unit}`,
  }));

  return { pricePath, bars, ticks, priceTicks, min, max, unit };
}

// ---------------------------------------------------------------------------
// Local accumulation
// ---------------------------------------------------------------------------

export interface StoredHistorySeries {
  name: string;
  unique?: boolean;
  baseType?: string;
  category?: string;
  points: TrendPoint[];
}

export interface StoredHistory {
  version: typeof PRICING_HISTORY_VERSION;
  league: string;
  /** First merge into this file (ISO). */
  since: string;
  /** Last merge (ISO). */
  updatedAt: string;
  /** The trends cache stamp last merged — the idempotence guard. */
  sourceFetchedAt?: string;
  series: Record<string, StoredHistorySeries>;
}

/**
 * Series maps carry keys that came off the network or off disk, so they are
 * null-prototype: `series["__proto__"] = …` on a plain object literal sets the
 * object's PROTOTYPE instead of an own key (poisoning every later read), and
 * `series["toString"]` would answer with a function.
 */
export function seriesMap(
  from?: Readonly<Record<string, StoredHistorySeries>>,
): Record<string, StoredHistorySeries> {
  const map = Object.create(null) as Record<string, StoredHistorySeries>;
  return from ? Object.assign(map, from) : map;
}

export function emptyStoredHistory(league: string, now: string): StoredHistory {
  return {
    version: PRICING_HISTORY_VERSION,
    league,
    since: now,
    updatedAt: now,
    series: seriesMap(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Same rules as priceTrends' own log normalization: finite price > 0, parsable time, quantity ≥ 0. */
export function sanitizeTrendPoints(raw: unknown): TrendPoint[] {
  if (!Array.isArray(raw)) return [];
  const byTime = new Map<string, TrendPoint>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const price = finitePositive(entry.price);
    const time = isoOrUndefined(entry.time);
    if (price === undefined || time === undefined) continue;
    const quantity =
      typeof entry.quantity === "number" && Number.isFinite(entry.quantity) && entry.quantity > 0
        ? Math.floor(entry.quantity)
        : 0;
    byTime.set(time, { time, price, quantity });
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function sanitizeStoredSeries(raw: unknown): StoredHistorySeries | undefined {
  if (!isRecord(raw)) return undefined;
  const points = sanitizeTrendPoints(raw.points);
  if (points.length === 0) return undefined;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 160) : "";
  if (!name) return undefined;
  const baseType = typeof raw.baseType === "string" && raw.baseType.trim() ? raw.baseType.trim().slice(0, 160) : undefined;
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim().slice(0, 60) : undefined;
  return {
    name,
    ...(raw.unique === true ? { unique: true } : {}),
    ...(baseType ? { baseType } : {}),
    ...(category ? { category } : {}),
    points: points.slice(-MAX_HISTORY_POINTS),
  };
}

/**
 * Junk, a different league, or a different version all read as "no history
 * yet" — a history file is a convenience, never a source of truth.
 */
export function parseStoredHistory(
  text: string | undefined,
  league: string,
  now: string,
): StoredHistory {
  if (!text) return emptyStoredHistory(league, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyStoredHistory(league, now);
  }
  if (!isRecord(parsed)) return emptyStoredHistory(league, now);
  if (parsed.version !== PRICING_HISTORY_VERSION) return emptyStoredHistory(league, now);
  if (typeof parsed.league !== "string" || parsed.league.toLowerCase() !== league.toLowerCase()) {
    return emptyStoredHistory(league, now);
  }
  const series = seriesMap();
  if (isRecord(parsed.series)) {
    let keys = 0;
    for (const [key, value] of Object.entries(parsed.series)) {
      // Only the cap ends the loop: an empty (or otherwise unusable) key must
      // never discard the keys that come after it — that would silently throw
      // away the accumulated bars on the next write.
      if (keys >= MAX_HISTORY_KEYS) break;
      if (!key) continue;
      const entry = sanitizeStoredSeries(value);
      if (!entry) continue;
      series[key] = entry;
      keys += 1;
    }
  }
  const sourceFetchedAt = isoOrUndefined(parsed.sourceFetchedAt);
  return {
    version: PRICING_HISTORY_VERSION,
    league: parsed.league,
    since: isoOrUndefined(parsed.since) ?? now,
    updatedAt: isoOrUndefined(parsed.updatedAt) ?? now,
    ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
    series,
  };
}

export function serializeStoredHistory(history: StoredHistory): string {
  return JSON.stringify(history);
}

export function historyBarCount(history: StoredHistory): number {
  let total = 0;
  for (const entry of Object.values(history.series)) total += entry.points.length;
  return total;
}

export interface MergeHistoryResult {
  history: StoredHistory;
  addedBars: number;
  changed: boolean;
}

/**
 * Merge one trends snapshot into the stored timeline. Bars are keyed by
 * their ISO time, so re-merging the same snapshot adds nothing; poe2scout
 * revises the current day's bar during the day, so a same-time bar with a
 * different price replaces the stored one (a change, not an addition).
 */
export function mergeHistory(
  history: StoredHistory,
  series: readonly TrendSeries[],
  fetchedAt: string,
  now: string,
): MergeHistoryResult {
  const next: StoredHistory = { ...history, series: seriesMap(history.series) };
  let addedBars = 0;
  let replaced = 0;
  let keys = Object.keys(next.series).length;

  for (const entry of series) {
    const existing = next.series[entry.key];
    if (!existing && keys >= MAX_HISTORY_KEYS) continue;
    const points = existing ? [...existing.points] : [];
    const byTime = new Map(points.map((point, index) => [point.time, index] as const));
    for (const point of entry.points) {
      const at = byTime.get(point.time);
      if (at === undefined) {
        byTime.set(point.time, points.length);
        points.push({ time: point.time, price: point.price, quantity: point.quantity });
        addedBars += 1;
      } else if (points[at]!.price !== point.price || points[at]!.quantity !== point.quantity) {
        points[at] = { time: point.time, price: point.price, quantity: point.quantity };
        replaced += 1;
      }
    }
    points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const merged: StoredHistorySeries = {
      name: entry.name,
      ...(entry.unique ? { unique: true } : {}),
      ...(entry.baseType ? { baseType: entry.baseType } : {}),
      ...(entry.category ? { category: entry.category } : {}),
      points: points.length > MAX_HISTORY_POINTS ? points.slice(-MAX_HISTORY_POINTS) : points,
    };
    if (!existing) keys += 1;
    next.series[entry.key] = merged;
  }

  const stampChanged = next.sourceFetchedAt !== fetchedAt;
  next.sourceFetchedAt = fetchedAt;
  if (addedBars > 0 || replaced > 0) next.updatedAt = now;
  if (!history.since) next.since = now;
  return { history: next, addedBars, changed: addedBars > 0 || replaced > 0 || stampChanged };
}

export interface TrimHistoryResult {
  history: StoredHistory;
  droppedBars: number;
}

/**
 * Keep a league file inside its byte budget by dropping the OLDEST bars of
 * the fattest keys first — the recent shape of a price is what the tool
 * draws, and no key is cut below MIN_HISTORY_POINTS.
 *
 * The floor makes this a SOFT cap: MAX_HISTORY_KEYS keys all sitting at
 * MIN_HISTORY_POINTS bars are ~2.6 MB serialized, so today the floor cannot
 * push a file past MAX_HISTORY_BYTES — raise the floor or the key cap and
 * that stops holding, which is why the loop also breaks instead of spinning.
 */
export function trimHistoryToBudget(
  history: StoredHistory,
  maxBytes = MAX_HISTORY_BYTES,
): TrimHistoryResult {
  const size = serializeStoredHistory(history).length;
  if (size <= maxBytes) return { history, droppedBars: 0 };
  let total = historyBarCount(history);
  if (total === 0) return { history, droppedBars: 0 };
  const target = Math.max(1, Math.floor(total * (maxBytes / size) * 0.95));
  const next: StoredHistory = { ...history, series: seriesMap(history.series) };
  for (const [key, entry] of Object.entries(next.series)) {
    next.series[key] = { ...entry, points: [...entry.points] };
  }
  let droppedBars = 0;
  while (total > target) {
    const fattest = Object.values(next.series)
      .filter((entry) => entry.points.length > MIN_HISTORY_POINTS)
      .sort((a, b) => b.points.length - a.points.length);
    if (fattest.length === 0) break;
    for (const entry of fattest) {
      entry.points.shift();
      total -= 1;
      droppedBars += 1;
      if (total <= target) break;
    }
  }
  return { history: next, droppedBars };
}
