/**
 * Market data service: pulls live prices into the price table (poe2scout)
 * and fetches trade2 comps for one item on demand.
 *
 * Etiquette encoded here:
 *   - poe2scout: two GETs per refresh (Leagues + Items), identified
 *     User-Agent, never more than once per REFRESH_MIN_INTERVAL_MS.
 *   - trade2: serialized queue paced from the server's own X-Rate-Limit
 *     headers (core/tradePacing.ts; the pacing log is shared across
 *     processes via configDir/trade-pacing.json), one search + one fetch per
 *     lookup, raw listings cached on disk per query (6h for base-type
 *     searches, 1h for uniques) and re-scored per item, 429 surfaces and is
 *     remembered.
 *   - The network is opt-in: nothing fetches until the renderer asks or the
 *     user enables the daily auto-refresh.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  currentScoutLeague,
  feedAgeHours,
  isFeedEntry,
  mergeFeedSnapshot,
  normalizeScoutItems,
  type PriceFeedSnapshot,
} from "../core/priceFeed.js";
import {
  buildCompsQuery,
  parseCompListings,
  summarizeComps,
  type CompListing,
  type CompsQuery,
  type CompsSummary,
} from "../core/tradeComps.js";
import {
  FETCH_POLICY,
  SEARCH_POLICY,
  TradePacer,
  policyForUrl,
  type PacerSnapshot,
} from "../core/tradePacing.js";
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import type { PriceTable } from "../core/priceTable.js";

const SCOUT_BASE = "https://api.poe2scout.com/poe2";
const TRADE_BASE = "https://www.pathofexile.com/api/trade2";
const USER_AGENT = "poe2-trade-companion/0.1 (local desktop tool)";
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
/** Courtesy gap between trade2 requests on top of the rate-limit pacing. */
const TRADE_MIN_GAP_MS = 750;
/** Base-type searches return the base's floor listings: slow-moving. */
const COMPS_CACHE_BASE_MS = 6 * 60 * 60_000;
/** Unique-name searches move with the market: an hour. */
const COMPS_CACHE_UNIQUE_MS = 60 * 60_000;

/**
 * One cached trade2 query: the RAW listings, not a summary. The mod
 * similarity pass runs against each item's own mods at read time, so one
 * base-type fetch prices every item of that base (2026-09-03).
 */
interface CachedComps {
  at: number;
  league: string;
  basis: CompsQuery["basis"];
  listings: CompListing[];
}

function compsTtl(basis: CompsQuery["basis"]): number {
  return basis === "unique-name" ? COMPS_CACHE_UNIQUE_MS : COMPS_CACHE_BASE_MS;
}

function isCachedComps(value: unknown): value is CachedComps {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CachedComps>;
  return (
    typeof entry.at === "number" &&
    typeof entry.league === "string" &&
    (entry.basis === "unique-name" || entry.basis === "base-type") &&
    Array.isArray(entry.listings)
  );
}

function headerOf(response: Response, name: string): string | undefined {
  const headers = (response as { headers?: { get?: (key: string) => string | null } }).headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  return headers.get(name) ?? undefined;
}
const FETCH_TIMEOUT_MS = 20_000;

export interface PriceFeedConfig {
  /** League name, or "auto" to use the current softcore trade league. */
  league: string;
  /** Refresh the feed once a day while the app runs. Off by default. */
  autoRefreshDaily: boolean;
  /** Optional pathofexile.com session cookie for trade2 requests. */
  poesessid: string;
}

export interface PriceFeedStatus {
  config: PriceFeedConfig;
  resolvedLeague?: string;
  lastRefreshAt?: string;
  lastError?: string;
  feedEntryCount: number;
  feedAgeHours?: number;
  refreshing: boolean;
}

export interface CompsResult {
  ok: boolean;
  summary?: CompsSummary;
  error?: string;
  cached?: boolean;
  league?: string;
}

interface PriceFeedServiceOptions {
  configDir: string;
  getPriceTable: () => PriceTable;
  savePriceTable: (table: PriceTable) => PriceTable;
  now?: () => Date;
  /** Test seam: swap out global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: spacing between trade2 requests (default 2s). */
  tradeSpacingMs?: number;
  /** Test seam: fixed 429 backoff instead of the server's Retry-After. */
  rateLimitBackoffMs?: number;
}

const DEFAULT_CONFIG: PriceFeedConfig = {
  league: "auto",
  autoRefreshDaily: false,
  poesessid: "",
};

export class PriceFeedService {
  private config: PriceFeedConfig;
  private resolvedLeague: string | undefined;
  private lastRefreshAt: string | undefined;
  private lastError: string | undefined;
  private refreshing = false;
  private dailyTimer: ReturnType<typeof setInterval> | undefined;
  private lastTradeRequestAt = 0;
  private tradeChain: Promise<unknown> = Promise.resolve();
  private readonly compsCache = new Map<string, CachedComps>();
  private readonly pacer: TradePacer;
  /** trade2 penalty window (epoch ms); persisted with the comps cache. */
  private rateLimitedUntil = 0;

  constructor(private readonly options: PriceFeedServiceOptions) {
    this.config = this.loadConfig();
    this.pacer = new TradePacer(this.loadPacing());
    this.loadCompsCache();
    this.armDailyTimer();
  }

  /**
   * How many trade2 lookups (one search + one fetch each) could go out right
   * now without waiting, and when a restriction lifts if one is in force.
   */
  tradeBudget(): { lookups: number; restrictedUntilIso?: string } {
    const now = Date.now();
    const lookups = Math.min(
      this.pacer.available(SEARCH_POLICY, now),
      this.pacer.available(FETCH_POLICY, now),
    );
    const until = this.rateLimitedUntilIso();
    return { lookups: Math.max(0, lookups), ...(until ? { restrictedUntilIso: until } : {}) };
  }

  private pacingFile(): string {
    return path.join(this.options.configDir, "trade-pacing.json");
  }

  private loadPacing(): PacerSnapshot | undefined {
    try {
      const file = this.pacingFile();
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as PacerSnapshot;
    } catch {
      return undefined;
    }
  }

  private savePacing(): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(this.pacingFile(), JSON.stringify(this.pacer.toJSON()));
    } catch {
      // Best effort; this process still paces itself.
    }
  }

  /** When trade2 has us in a penalty window: the time it lifts, else undefined. */
  rateLimitedUntilIso(): string | undefined {
    return this.rateLimitedUntil > Date.now() ? new Date(this.rateLimitedUntil).toISOString() : undefined;
  }

  /**
   * The comps cache lives on disk too (configDir/comps-cache.json): the
   * CLI is a fresh process per run, and re-fetching the same bag twice in
   * ten minutes is what trips trade2's rate limit (2026-09-03).
   */
  private compsCacheFile(): string {
    return path.join(this.options.configDir, "comps-cache.json");
  }

  private loadCompsCache(): void {
    try {
      const file = this.compsCacheFile();
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
        _rateLimitedUntil?: unknown;
      };
      const now = Date.now();
      if (typeof parsed._rateLimitedUntil === "number" && parsed._rateLimitedUntil > now) {
        this.rateLimitedUntil = parsed._rateLimitedUntil;
      }
      delete parsed._rateLimitedUntil;
      for (const [key, entry] of Object.entries(parsed)) {
        if (!isCachedComps(entry)) continue;
        if (now - entry.at < compsTtl(entry.basis)) this.compsCache.set(key, entry);
      }
    } catch {
      // A corrupt cache is just a cold cache.
    }
  }

  private saveCompsCache(): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      const now = Date.now();
      const live: Record<string, CachedComps | number> = {};
      for (const [key, entry] of this.compsCache) {
        if (now - entry.at < compsTtl(entry.basis)) live[key] = entry;
      }
      if (this.rateLimitedUntil > now) live._rateLimitedUntil = this.rateLimitedUntil;
      writeFileSync(this.compsCacheFile(), JSON.stringify(live));
    } catch {
      // Best effort; the in-memory cache still applies for this process.
    }
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private configFile(): string {
    return path.join(this.options.configDir, "price-feed.json");
  }

  private loadConfig(): PriceFeedConfig {
    try {
      const file = this.configFile();
      if (!existsSync(file)) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PriceFeedConfig>;
      return {
        league: typeof parsed.league === "string" && parsed.league.trim() ? parsed.league : "auto",
        autoRefreshDaily: parsed.autoRefreshDaily === true,
        poesessid: typeof parsed.poesessid === "string" ? parsed.poesessid : "",
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private persistConfig(): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(this.configFile(), JSON.stringify(this.config, null, 2));
    } catch {
      // The in-memory config still applies for this session.
    }
  }

  configure(partial: Partial<PriceFeedConfig>): PriceFeedStatus {
    this.config = {
      league:
        typeof partial.league === "string" && partial.league.trim()
          ? partial.league.trim()
          : this.config.league,
      autoRefreshDaily: partial.autoRefreshDaily ?? this.config.autoRefreshDaily,
      poesessid: typeof partial.poesessid === "string" ? partial.poesessid : this.config.poesessid,
    };
    this.persistConfig();
    this.armDailyTimer();
    return this.status();
  }

  status(): PriceFeedStatus {
    const table = this.options.getPriceTable();
    const feedEntries = table.entries.filter((entry) => isFeedEntry(entry, "poe2scout"));
    return {
      config: { ...this.config, poesessid: this.config.poesessid ? "(set)" : "" },
      ...(this.resolvedLeague ? { resolvedLeague: this.resolvedLeague } : {}),
      ...(this.lastRefreshAt ? { lastRefreshAt: this.lastRefreshAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      feedEntryCount: feedEntries.length,
      ...(feedAgeHours(table, "poe2scout", this.now()) !== undefined
        ? { feedAgeHours: Math.round(feedAgeHours(table, "poe2scout", this.now())! * 10) / 10 }
        : {}),
      refreshing: this.refreshing,
    };
  }

  dispose(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = undefined;
  }

  private armDailyTimer(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = undefined;
    if (!this.config.autoRefreshDaily) return;
    this.dailyTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, 24 * 3_600_000);
    // A just-enabled toggle also refreshes soon (not instantly, to let the
    // user finish typing settings).
    setTimeout(() => void this.refresh().catch(() => undefined), 5_000);
  }

  private async getJson(url: string): Promise<unknown> {
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

  private async resolveLeague(): Promise<string> {
    if (this.config.league !== "auto") return this.config.league;
    const leagues = await this.getJson(`${SCOUT_BASE}/Leagues`);
    const current = currentScoutLeague(leagues);
    if (!current) throw new Error("poe2scout returned no current softcore league");
    return current;
  }

  /** Pull the full price snapshot and merge it into the price table. */
  async refresh(): Promise<PriceFeedStatus> {
    if (this.refreshing) return this.status();
    const last = this.lastRefreshAt ? Date.parse(this.lastRefreshAt) : 0;
    if (this.now().getTime() - last < REFRESH_MIN_INTERVAL_MS && !this.lastError) {
      return this.status(); // fresh enough — do not hammer the API
    }
    this.refreshing = true;
    this.lastError = undefined;
    try {
      const league = await this.resolveLeague();
      this.resolvedLeague = league;
      const items = await this.getJson(`${SCOUT_BASE}/Leagues/${encodeURIComponent(league)}/Items`);
      const snapshot: PriceFeedSnapshot = {
        source: "poe2scout",
        league,
        fetchedAt: this.now().toISOString(),
        prices: normalizeScoutItems(items),
      };
      if (snapshot.prices.length === 0) {
        throw new Error("poe2scout returned no priced items — table left untouched");
      }
      const merged = mergeFeedSnapshot(this.options.getPriceTable(), snapshot);
      this.options.savePriceTable(merged.table);
      this.lastRefreshAt = snapshot.fetchedAt;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshing = false;
    }
    return this.status();
  }

  // -------------------------------------------------------------------------
  // trade2 comps
  // -------------------------------------------------------------------------

  private async tradeRequest(url: string, init: RequestInit): Promise<Response> {
    // Serialize all trade2 traffic; the pacer spaces it from the server's
    // own rate-limit rules so no window ever fills.
    const policy = policyForUrl(url);
    const run = this.tradeChain.then(async () => {
      const gap = this.options.tradeSpacingMs ?? TRADE_MIN_GAP_MS;
      const wait = Math.max(
        this.pacer.delayFor(policy),
        this.lastTradeRequestAt + gap - Date.now(),
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastTradeRequestAt = Date.now();
      this.pacer.record(policy);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(this.config.poesessid
              ? { Cookie: `POESESSID=${this.config.poesessid}` }
              : {}),
            ...(init.headers ?? {}),
          },
          signal: controller.signal,
        });
        this.pacer.observe(policy, {
          rules: headerOf(response, "x-rate-limit-ip"),
          state: headerOf(response, "x-rate-limit-ip-state"),
          ...(response.status === 429 ? { retryAfter: headerOf(response, "retry-after") } : {}),
        });
        const restricted = this.pacer.restrictedUntil();
        if (restricted > this.rateLimitedUntil) this.rateLimitedUntil = restricted;
        this.savePacing();
        return response;
      } finally {
        clearTimeout(timer);
      }
    });
    this.tradeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * A trade2 request that survives ONE 429: wait the server's Retry-After
   * (capped at 90s; 60s when absent) and try again. The one-key shop flow
   * prices a whole bag in a burst, which is exactly when the limit bites.
   */
  private async tradeRequestWithBackoff(url: string, init: RequestInit): Promise<Response> {
    const first = await this.tradeRequest(url, init);
    if (first.status !== 429) return first;
    const retryAfter = Number(first.headers?.get?.("retry-after"));
    const waitMs =
      this.options.rateLimitBackoffMs ??
      Math.min(300_000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1_000);
    // A short penalty is waited out inline; a long one is remembered (on
    // disk too) and reported — a key press must not stall for minutes, and
    // hitting the API again inside the window only extends it.
    if (waitMs > 30_000 && this.options.rateLimitBackoffMs === undefined) {
      this.rateLimitedUntil = Date.now() + waitMs;
      this.saveCompsCache();
      this.lastError = `trade2 rate limited until ${new Date(this.rateLimitedUntil).toLocaleTimeString()}`;
      return first;
    }
    this.lastError = `trade2 rate limit — backing off ${Math.round(waitMs / 1000)}s`;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const second = await this.tradeRequest(url, init);
    if (second.status === 429) {
      // Still throttled after a retry: assume a longer window, remember it.
      const again = Number(second.headers?.get?.("retry-after"));
      const penaltyMs = Math.min(300_000, (Number.isFinite(again) && again > 0 ? again : 120) * 1_000);
      this.rateLimitedUntil = Date.now() + penaltyMs;
      this.saveCompsCache();
    }
    return second;
  }

  async fetchComps(itemText: string): Promise<CompsResult> {
    if (!looksLikePoeItemText(itemText)) {
      return { ok: false, error: "Not recognizable item text." };
    }
    const parsed = parseItemText(itemText);
    const query = buildCompsQuery(parsed);
    if (!query) return { ok: false, error: "The item has no searchable base type." };

    const cacheKey = JSON.stringify(query.body);
    const ourMods = parsed.mods.filter((mod) => !mod.implicit).map((mod) => mod.text);
    const summarize = (listings: readonly CompListing[]): CompsSummary =>
      summarizeComps(ourMods, listings, query.basis, {
        priceTable: this.options.getPriceTable(),
        itemClass: parsed.itemClass,
      });
    const cached = this.compsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < compsTtl(cached.basis)) {
      return { ok: true, cached: true, league: cached.league, summary: summarize(cached.listings) };
    }
    const until = this.rateLimitedUntilIso();
    if (until) {
      return {
        ok: false,
        error: `trade2 rate limited until ${new Date(until).toLocaleTimeString()} — try again then`,
      };
    }

    try {
      const league = await this.resolveLeague();
      this.resolvedLeague = league;
      const remember = (listings: CompListing[]): CompsResult => {
        this.compsCache.set(cacheKey, { at: Date.now(), league, basis: query.basis, listings });
        this.saveCompsCache();
        return { ok: true, league, summary: summarize(listings) };
      };
      const searchResponse = await this.tradeRequestWithBackoff(
        `${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`,
        { method: "POST", body: JSON.stringify(query.body) },
      );
      if (searchResponse.status === 429) {
        return { ok: false, error: "trade2 rate limit hit — wait a minute and try again." };
      }
      if (!searchResponse.ok) {
        throw new Error(`trade2 search → HTTP ${searchResponse.status}`);
      }
      const search = (await searchResponse.json()) as { id?: string; result?: string[] };
      const ids = Array.isArray(search.result) ? search.result.slice(0, 10) : [];
      if (!search.id || ids.length === 0) return remember([]);
      const fetchResponse = await this.tradeRequestWithBackoff(
        `${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`,
        { method: "GET" },
      );
      if (fetchResponse.status === 429) {
        return { ok: false, error: "trade2 rate limit hit — wait a minute and try again." };
      }
      if (!fetchResponse.ok) throw new Error(`trade2 fetch → HTTP ${fetchResponse.status}`);
      return remember(parseCompListings(await fetchResponse.json()));
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
