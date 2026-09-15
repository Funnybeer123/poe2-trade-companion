/**
 * Market trends service: pulls poe2scout's daily price logs for the
 * currency-style categories, caches them on disk for 12 hours, and serves
 * trend readings computed against the current clock.
 *
 * Etiquette:
 *   - Identified User-Agent, every request ≥ 500 ms after the previous one,
 *     20 s timeout, perPage=100 so a category is normally ONE request
 *     (verified 2026-09-07: currency has 38 rows, essences 82).
 *   - Nothing fetches until asked. `cachedOnly` never touches the network,
 *     so decorating a table with arrows costs no requests.
 *   - The league comes from the price feed's own config file in the same
 *     directory (price-feed.json). "auto" is REFUSED while poe2scout lists
 *     more than one current softcore league — guessing would price the
 *     wrong economy — the user picks one in the feed settings.
 *
 * Reads only; priceFeedService.ts owns that config file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeScoutPriceLogs,
  summarizeTrends,
  type TrendReport,
  type TrendSeries,
} from "../core/priceTrends.js";

const SCOUT_BASE = "https://api.poe2scout.com/poe2";
const USER_AGENT = "poe2-trade-companion/0.1 (local desktop tool)";
const FETCH_TIMEOUT_MS = 20_000;
const REQUEST_GAP_MS = 500;
const CACHE_TTL_MS = 12 * 3_600_000;
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const PER_PAGE = 100;
const MAX_PAGES_PER_CATEGORY = 20;

/**
 * CategoryApiId values seen on /Items (2026-09-07) that ByCategory serves
 * with price logs. No category listing endpoint exists (/CurrencyCategories
 * and /ItemCategories both 404); an unknown name just returns Pages: 0.
 */
export const DEFAULT_TREND_CATEGORIES = [
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
];

export interface MarketTrendsCache {
  fetchedAt: string;
  league: string;
  categories: string[];
  series: TrendSeries[];
}

export interface MarketTrendsQuery {
  /** Fetch now (subject to a 5-minute courtesy interval). */
  refresh?: boolean;
  /** Serve only what is on disk; never fetch. */
  cachedOnly?: boolean;
}

export interface MarketTrendsResult {
  ok: boolean;
  league?: string;
  fetchedAt?: string;
  /** Cache older than the TTL (still served; a refresh is due). */
  stale: boolean;
  refreshing: boolean;
  source: "cache" | "network" | "none";
  categories: string[];
  trends: TrendReport[];
  error?: string;
}

export interface MarketTrendsServiceOptions {
  /** Directory holding price-feed.json (read) and price-trends.json (written). */
  configDir: string;
  now?: () => Date;
  /** Test seam: swap out global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: spacing between poe2scout requests. */
  requestGapMs?: number;
  categories?: string[];
  ttlMs?: number;
}

interface ScoutLeague {
  Value?: unknown;
  IsCurrent?: unknown;
}

/** Every current non-hardcore league poe2scout lists, in its order. */
export function currentSoftcoreLeagues(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return (payload as ScoutLeague[])
    .filter(
      (league) =>
        league.IsCurrent === true &&
        typeof league.Value === "string" &&
        !/^HC /i.test(league.Value) &&
        !/hardcore/i.test(league.Value),
    )
    .map((league) => league.Value as string);
}

/**
 * The league to fetch: the configured name, or — for "auto" — the single
 * current softcore league. Two of them (league overlap, as on 2026-09-07
 * with "Forbidden Rites" and "Runes of Aldur") is a refusal, not a guess.
 */
export function resolveTrendLeague(configured: string, leaguesPayload: unknown): string {
  if (configured !== "auto") return configured;
  const current = currentSoftcoreLeagues(leaguesPayload);
  if (current.length === 0) throw new Error("poe2scout returned no current softcore league");
  if (current.length > 1) {
    throw new Error(
      `poe2scout lists ${current.length} current softcore leagues (${current.join(", ")}) — ` +
        "set the league explicitly in the price feed settings (Tools → Settings) to pick one",
    );
  }
  return current[0]!;
}

function isCache(value: unknown): value is MarketTrendsCache {
  if (typeof value !== "object" || value === null) return false;
  const cache = value as Partial<MarketTrendsCache>;
  return (
    typeof cache.fetchedAt === "string" &&
    typeof cache.league === "string" &&
    Array.isArray(cache.categories) &&
    Array.isArray(cache.series)
  );
}

export class MarketTrendsService {
  private cache: MarketTrendsCache | undefined;
  private refreshing = false;
  private inflight: Promise<void> | undefined;
  private lastError: string | undefined;
  private lastAttemptAt = 0;
  private lastRequestAt = 0;
  private lastSource: MarketTrendsResult["source"] = "none";

  constructor(private readonly options: MarketTrendsServiceOptions) {
    this.cache = this.loadCache();
    if (this.cache) this.lastSource = "cache";
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get categories(): string[] {
    return this.options.categories ?? DEFAULT_TREND_CATEGORIES;
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? CACHE_TTL_MS;
  }

  private cacheFile(): string {
    return path.join(this.options.configDir, "price-trends.json");
  }

  private loadCache(): MarketTrendsCache | undefined {
    try {
      const file = this.cacheFile();
      if (!existsSync(file)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isCache(parsed) ? parsed : undefined;
    } catch {
      return undefined; // a corrupt cache is just a cold cache
    }
  }

  private saveCache(cache: MarketTrendsCache): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(this.cacheFile(), JSON.stringify(cache));
    } catch {
      // Best effort; the in-memory cache still serves this session.
    }
  }

  /** The price feed's configured league ("auto" when unset or unreadable). */
  configuredLeague(): string {
    try {
      const file = path.join(this.options.configDir, "price-feed.json");
      if (!existsSync(file)) return "auto";
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { league?: unknown };
      return typeof parsed.league === "string" && parsed.league.trim() ? parsed.league.trim() : "auto";
    } catch {
      return "auto";
    }
  }

  private async pacedGetJson(url: string): Promise<unknown> {
    const gap = this.options.requestGapMs ?? REQUEST_GAP_MS;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchSeries(league: string): Promise<TrendSeries[]> {
    const series: TrendSeries[] = [];
    for (const category of this.categories) {
      for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page += 1) {
        const url =
          `${SCOUT_BASE}/Leagues/${encodeURIComponent(league)}/Currencies/ByCategory` +
          `?category=${encodeURIComponent(category)}&page=${page}&perPage=${PER_PAGE}`;
        const payload = await this.pacedGetJson(url);
        series.push(...normalizeScoutPriceLogs(payload));
        const pages = (payload as { Pages?: unknown } | null)?.Pages;
        if (typeof pages !== "number" || page >= pages) break;
      }
    }
    return series;
  }

  private async fetchIntoCache(configured: string): Promise<void> {
    this.refreshing = true;
    this.lastAttemptAt = this.now().getTime();
    this.lastError = undefined;
    try {
      const league = resolveTrendLeague(
        configured,
        configured === "auto" ? await this.pacedGetJson(`${SCOUT_BASE}/Leagues`) : undefined,
      );
      const series = await this.fetchSeries(league);
      if (series.length === 0) {
        throw new Error("poe2scout returned no price history — cache left untouched");
      }
      this.cache = {
        fetchedAt: this.now().toISOString(),
        league,
        categories: [...this.categories],
        series,
      };
      this.saveCache(this.cache);
      this.lastSource = "network";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshing = false;
    }
  }

  private cacheMatches(configured: string): boolean {
    if (!this.cache) return false;
    return configured === "auto" || this.cache.league.toLowerCase() === configured.toLowerCase();
  }

  private result(usable: boolean, withSeries = false): MarketTrendsResult & { series?: TrendSeries[] } {
    const now = this.now();
    const cache = usable ? this.cache : undefined;
    const age = cache ? now.getTime() - Date.parse(cache.fetchedAt) : Number.POSITIVE_INFINITY;
    return {
      // Copied per call: the cache is this service's, never the caller's.
      ...(withSeries
        ? { series: (cache ? cache.series : []).map((entry) => ({ ...entry, points: [...entry.points] })) }
        : {}),
      ok: cache !== undefined,
      ...(cache ? { league: cache.league, fetchedAt: cache.fetchedAt } : {}),
      stale: cache ? !(age < this.ttlMs) : true,
      refreshing: this.refreshing,
      source: cache ? this.lastSource : "none",
      categories: cache ? cache.categories : [...this.categories],
      trends: cache ? summarizeTrends(cache.series, now) : [],
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Trends for the configured league. Default: the cache when fresh, else a
   * fetch. `refresh` fetches now (once per 5 minutes unless the last attempt
   * failed); `cachedOnly` never fetches. A stale cache is still served,
   * flagged, when the fetch fails.
   */
  async getTrends(query: MarketTrendsQuery = {}): Promise<MarketTrendsResult> {
    return this.load(query, false);
  }

  /**
   * Exactly getTrends (same refresh / TTL / cachedOnly / league rules, the
   * same requests and no others), plus the per-item daily series the cache
   * already holds: `points` oldest → newest, for drawing history rather
   * than reading one arrow. Empty when nothing usable is cached.
   */
  async series(query: MarketTrendsQuery = {}): Promise<MarketTrendsResult & { series: TrendSeries[] }> {
    return this.load(query, true) as Promise<MarketTrendsResult & { series: TrendSeries[] }>;
  }

  private async load(query: MarketTrendsQuery, withSeries: false): Promise<MarketTrendsResult>;
  private async load(
    query: MarketTrendsQuery,
    withSeries: true,
  ): Promise<MarketTrendsResult & { series: TrendSeries[] }>;
  private async load(
    query: MarketTrendsQuery,
    withSeries: boolean,
  ): Promise<MarketTrendsResult & { series?: TrendSeries[] }> {
    const configured = this.configuredLeague();
    const usable = this.cacheMatches(configured);
    if (query.cachedOnly) return this.result(usable, withSeries);
    if (this.inflight) {
      await this.inflight;
      return this.result(this.cacheMatches(configured), withSeries);
    }
    const age = usable ? this.now().getTime() - Date.parse(this.cache!.fetchedAt) : Number.POSITIVE_INFINITY;
    const fresh = age < this.ttlMs;
    const sinceAttempt = this.now().getTime() - this.lastAttemptAt;
    const wantFetch = query.refresh
      ? sinceAttempt >= REFRESH_MIN_INTERVAL_MS || this.lastError !== undefined || !usable
      : !fresh;
    if (wantFetch) {
      this.inflight = this.fetchIntoCache(configured).finally(() => {
        this.inflight = undefined;
      });
      await this.inflight;
    }
    return this.result(this.cacheMatches(configured), withSeries);
  }
}
