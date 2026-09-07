/**
 * Price history and trends: turns poe2scout's daily price logs into per-item
 * momentum, volatility and liquidity readings, then into two decisions —
 * "hold or sell this currency stack" and "what is worth farming".
 *
 * Data shape (verified live 2026-09-07 against api.poe2scout.com):
 *   GET /poe2/Leagues/{league}/Currencies/ByCategory?category=X&page=N
 *     → { CurrentPage, Pages, Total, Items: [{ ApiId, Text, CategoryApiId,
 *          PriceLogs: [{ Price, Time, Quantity } | null], CurrentPrice,
 *          CurrentQuantity }] }
 *   - One bar per day, stamped 00:00Z, newest first, ~7 bars per item.
 *   - Sparse items carry `null` bars — skipped, never guessed at.
 *   - /Leagues/{league}/Items carries NO PriceLogs (checked: 0 of 1288 rows),
 *     so history has to come from the paged category endpoint.
 *
 * Everything here is pure: no I/O, no clocks (callers pass `now`).
 */

import { lookupPrice, type PriceTable } from "./priceTable.js";

export interface TrendPoint {
  /** ISO timestamp of the bar (poe2scout stamps the day at 00:00Z). */
  time: string;
  /** Price in exalted orbs. */
  price: number;
  /** Units traded / listings seen that day (poe2scout `Quantity`). */
  quantity: number;
}

export interface TrendSeries {
  /** Same key rule as the price feed, so `feed:poe2scout:<key>` rows line up. */
  key: string;
  name: string;
  unique?: boolean;
  baseType?: string;
  category?: string;
  /** Live price at fetch time (poe2scout CurrentPrice); newest bar otherwise. */
  current?: number;
  /** Oldest → newest, one entry per timestamp. */
  points: TrendPoint[];
}

export type TrendDirection = "rising" | "falling" | "stable";
export type Liquidity = "deep" | "thin";

export interface Trend {
  current: number;
  /** Percent change from the price ~1 day ago; undefined without a reference bar. */
  change1d?: number;
  change3d?: number;
  change7d?: number;
  /** Coefficient of variation (stddev / mean) of the last 7 days' bars. */
  volatility7d?: number;
  /** Sum of Quantity over the last 7 days' bars. */
  volume7d: number;
  /** Bars inside the 7-day window. */
  sampleSize: number;
  trend: TrendDirection;
  liquidity: Liquidity;
}

export interface TrendOptions {
  /** ±percent over 3 days that counts as rising/falling. */
  trendThresholdPercent?: number;
  /** volume7d at or above this reads as a deep market. */
  deepVolume7d?: number;
  /** How far (hours) a reference bar may sit from the target time. */
  toleranceHours?: number;
}

export const DEFAULT_TREND_OPTIONS: Required<TrendOptions> = {
  trendThresholdPercent: 8,
  // Daily Quantity runs from single digits (shards, mirrors) to millions
  // (divine, chaos); ~300 a day over a week separates "always a buyer"
  // from "wait for one".
  deepVolume7d: 2_000,
  // Daily bars: a target 12h past a bar is normal; 36h leaves slack for
  // sparse series without accepting a week-old bar as "yesterday".
  toleranceHours: 36,
};

const DAY_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// poe2scout normalization
// ---------------------------------------------------------------------------

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeLogs(raw: unknown): TrendPoint[] {
  if (!Array.isArray(raw)) return [];
  const byTime = new Map<string, TrendPoint>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue; // null bars
    const log = entry as { Price?: unknown; Time?: unknown; Quantity?: unknown };
    const price = finitePositive(log.Price);
    const time = typeof log.Time === "string" ? Date.parse(log.Time) : Number.NaN;
    if (price === undefined || !Number.isFinite(time)) continue;
    const quantity =
      typeof log.Quantity === "number" && Number.isFinite(log.Quantity) && log.Quantity > 0
        ? Math.floor(log.Quantity)
        : 0;
    byTime.set(new Date(time).toISOString(), {
      time: new Date(time).toISOString(),
      price,
      quantity,
    });
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/**
 * Normalize poe2scout items carrying PriceLogs — one ByCategory page
 * (`{ Items }`) or an already-concatenated array of items. Items without a
 * usable name or without a single valid bar are dropped.
 */
export function normalizeScoutPriceLogs(payload: unknown): TrendSeries[] {
  const items = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { Items?: unknown }).Items)
      ? ((payload as { Items: unknown[] }).Items)
      : [];
  const series: TrendSeries[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as {
      ApiId?: unknown;
      Text?: unknown;
      Name?: unknown;
      Type?: unknown;
      CategoryApiId?: unknown;
      PriceLogs?: unknown;
      CurrentPrice?: unknown;
    };
    const points = normalizeLogs(item.PriceLogs);
    if (points.length === 0) continue;
    const uniqueName = typeof item.Name === "string" ? item.Name.trim() : "";
    const baseType = typeof item.Type === "string" ? item.Type.trim() : "";
    const text = typeof item.Text === "string" ? item.Text.trim() : "";
    const category = typeof item.CategoryApiId === "string" ? item.CategoryApiId : undefined;
    const current = finitePositive(item.CurrentPrice);
    if (uniqueName) {
      series.push({
        key: slug(`${uniqueName}-${baseType}`),
        name: uniqueName,
        unique: true,
        ...(baseType ? { baseType } : {}),
        ...(category ? { category } : {}),
        ...(current !== undefined ? { current } : {}),
        points,
      });
      continue;
    }
    if (!text) continue;
    series.push({
      key: typeof item.ApiId === "string" && item.ApiId ? item.ApiId : slug(text),
      name: text,
      ...(category ? { category } : {}),
      ...(current !== undefined ? { current } : {}),
      points,
    });
  }
  return series;
}

// ---------------------------------------------------------------------------
// Trend maths
// ---------------------------------------------------------------------------

function toMs(now: Date | string | number): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.parse(now);
}

/**
 * The price in force at `targetMs`: the latest bar at or before it, else the
 * first bar after it — either only when within `toleranceMs`. Daily bars
 * are stamped at the start of the day they describe, so "3 days ago at
 * noon" resolves to that day's bar rather than the nearer next-day bar.
 */
function referencePrice(points: TrendPoint[], targetMs: number, toleranceMs: number): number | undefined {
  let before: TrendPoint | undefined;
  let after: TrendPoint | undefined;
  for (const point of points) {
    const time = Date.parse(point.time);
    if (time <= targetMs) before = point; // points are sorted ascending
    else if (!after) after = point;
  }
  if (before && targetMs - Date.parse(before.time) <= toleranceMs) return before.price;
  if (after && Date.parse(after.time) - targetMs <= toleranceMs) return after.price;
  return undefined;
}

function percentChange(current: number, reference: number | undefined): number | undefined {
  if (reference === undefined || reference <= 0) return undefined;
  return Math.round(((current - reference) / reference) * 1000) / 10;
}

function coefficientOfVariation(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return undefined;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.round((Math.sqrt(variance) / mean) * 1000) / 1000;
}

export function computeTrend(
  series: TrendSeries,
  now: Date | string | number = Date.now(),
  options: TrendOptions = {},
): Trend {
  const opts = { ...DEFAULT_TREND_OPTIONS, ...options };
  const nowMs = toMs(now);
  const toleranceMs = opts.toleranceHours * 3_600_000;
  const points = series.points;
  const newest = points[points.length - 1];
  const current = series.current ?? newest?.price ?? 0;
  const change1d = percentChange(current, referencePrice(points, nowMs - DAY_MS, toleranceMs));
  const change3d = percentChange(current, referencePrice(points, nowMs - 3 * DAY_MS, toleranceMs));
  const change7d = percentChange(current, referencePrice(points, nowMs - 7 * DAY_MS, toleranceMs));
  const window = points.filter((point) => {
    const time = Date.parse(point.time);
    return time >= nowMs - 7 * DAY_MS && time <= nowMs + toleranceMs;
  });
  const volume7d = window.reduce((sum, point) => sum + point.quantity, 0);
  const volatility7d = coefficientOfVariation(window.map((point) => point.price));
  const basis = change3d ?? change7d ?? change1d;
  const trend: TrendDirection =
    basis === undefined
      ? "stable"
      : basis >= opts.trendThresholdPercent
        ? "rising"
        : basis <= -opts.trendThresholdPercent
          ? "falling"
          : "stable";
  const liquidity: Liquidity = volume7d >= opts.deepVolume7d && window.length >= 3 ? "deep" : "thin";
  return {
    current,
    ...(change1d !== undefined ? { change1d } : {}),
    ...(change3d !== undefined ? { change3d } : {}),
    ...(change7d !== undefined ? { change7d } : {}),
    ...(volatility7d !== undefined ? { volatility7d } : {}),
    volume7d,
    sampleSize: window.length,
    trend,
    liquidity,
  };
}

export interface TrendReport extends Trend {
  key: string;
  name: string;
  unique?: boolean;
  baseType?: string;
  category?: string;
}

/** computeTrend over a whole snapshot, keeping the identity fields. */
export function summarizeTrends(
  series: TrendSeries[],
  now: Date | string | number = Date.now(),
  options: TrendOptions = {},
): TrendReport[] {
  return series.map((entry) => ({
    key: entry.key,
    name: entry.name,
    ...(entry.unique ? { unique: true } : {}),
    ...(entry.baseType ? { baseType: entry.baseType } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...computeTrend(entry, now, options),
  }));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type StackVerdict = "hold" | "sell" | "neutral";

export interface StackAdvice {
  verdict: StackVerdict;
  reason: string;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined) return "n/a";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

/**
 * Hold a rising stack, sell a falling one, otherwise neutral. The reason
 * names the horizon the trend was read from and warns on a thin market,
 * where a big stack moves the price against you.
 */
export function stackAdvice(trend: Trend, options: TrendOptions = {}): StackAdvice {
  const threshold = options.trendThresholdPercent ?? DEFAULT_TREND_OPTIONS.trendThresholdPercent;
  const horizon =
    trend.change3d !== undefined
      ? { change: trend.change3d, label: "3 d" }
      : trend.change7d !== undefined
        ? { change: trend.change7d, label: "7 d" }
        : trend.change1d !== undefined
          ? { change: trend.change1d, label: "1 d" }
          : undefined;
  if (!horizon) return { verdict: "neutral", reason: "neutral: no price history yet" };
  const thin = trend.liquidity === "thin" ? " · thin market, move it in small lots" : "";
  const move = `${formatPercent(horizon.change)} over ${horizon.label}`;
  if (horizon.change >= threshold) {
    return { verdict: "hold", reason: `hold: ${move} and rising${thin}` };
  }
  if (horizon.change <= -threshold) {
    return { verdict: "sell", reason: `sell: ${move}${thin}` };
  }
  return { verdict: "neutral", reason: `neutral: ${move}, stable${thin}` };
}

export interface FarmCandidate {
  key: string;
  name: string;
  category?: string;
  /** 0–100, relative to the best candidate. */
  score: number;
  /** Price used for the score (price table when it knows the item, else feed). */
  price: number;
  volume7d: number;
  trend: TrendDirection;
  why: string;
}

export interface FarmRankingOptions {
  priceTable?: PriceTable;
  limit?: number;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatPrice(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * What is worth farming: market throughput (price × 7-day volume) scaled to
 * the top candidate. The price table wins over the feed when it knows the
 * item, so a user-set number keeps steering the ranking.
 */
export function farmRanking(trends: TrendReport[], options: FarmRankingOptions = {}): FarmCandidate[] {
  const limit = Math.max(1, options.limit ?? 10);
  const scored = trends
    .filter((report) => report.volume7d > 0 && report.current > 0)
    .map((report) => {
      const hit = options.priceTable
        ? lookupPrice(options.priceTable, {
            name: report.name,
            ...(report.baseType ? { baseType: report.baseType } : {}),
            ...(report.unique ? { rarity: "Unique" } : {}),
          })
        : undefined;
      const price = hit && hit.entry.match.name !== undefined && hit.value > 0 ? hit.value : report.current;
      return { report, price, raw: price * report.volume7d };
    })
    .sort((a, b) => b.raw - a.raw)
    .slice(0, limit);
  const top = scored[0]?.raw ?? 0;
  return scored.map(({ report, price, raw }) => {
    const momentum =
      report.trend === "rising"
        ? `, price rising ${formatPercent(report.change3d ?? report.change7d)}`
        : report.trend === "falling"
          ? `, price falling ${formatPercent(report.change3d ?? report.change7d)}`
          : "";
    return {
      key: report.key,
      name: report.name,
      ...(report.category ? { category: report.category } : {}),
      score: top > 0 ? Math.round((raw / top) * 1000) / 10 : 0,
      price,
      volume7d: report.volume7d,
      trend: report.trend,
      why: `${formatPrice(price)} ex × ${formatCount(report.volume7d)} traded over 7 d${momentum}${
        report.liquidity === "thin" ? " · thin market" : ""
      }`,
    };
  });
}
