/**
 * Market data service: pulls live prices into the price table (poe2scout)
 * and fetches trade2 comps for one item on demand.
 *
 * Etiquette encoded here:
 *   - poe2scout: two GETs per refresh (Leagues + Items), identified
 *     User-Agent, never more than once per REFRESH_MIN_INTERVAL_MS.
 *   - trade2: serialized queue with ≥ 2s spacing, one search + one fetch per
 *     comp lookup, 10-minute per-item cache, 429 backs off and surfaces.
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
  type CompsSummary,
} from "../core/tradeComps.js";
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import type { PriceTable } from "../core/priceTable.js";

const SCOUT_BASE = "https://api.poe2scout.com/poe2";
const TRADE_BASE = "https://www.pathofexile.com/api/trade2";
const USER_AGENT = "poe2-trade-companion/0.1 (local desktop tool)";
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const TRADE_SPACING_MS = 2_000;
const COMPS_CACHE_MS = 10 * 60_000;
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
  private readonly compsCache = new Map<string, { at: number; result: CompsResult }>();

  constructor(private readonly options: PriceFeedServiceOptions) {
    this.config = this.loadConfig();
    this.armDailyTimer();
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
    // Serialize all trade2 traffic and space it out.
    const run = this.tradeChain.then(async () => {
      const spacing = this.options.tradeSpacingMs ?? TRADE_SPACING_MS;
      const wait = this.lastTradeRequestAt + spacing - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastTradeRequestAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        return await this.fetchImpl(url, {
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
      } finally {
        clearTimeout(timer);
      }
    });
    this.tradeChain = run.catch(() => undefined);
    return run;
  }

  async fetchComps(itemText: string): Promise<CompsResult> {
    if (!looksLikePoeItemText(itemText)) {
      return { ok: false, error: "Not recognizable item text." };
    }
    const parsed = parseItemText(itemText);
    const query = buildCompsQuery(parsed);
    if (!query) return { ok: false, error: "The item has no searchable base type." };

    const cacheKey = JSON.stringify(query.body);
    const cached = this.compsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < COMPS_CACHE_MS) {
      return { ...cached.result, cached: true };
    }

    try {
      const league = await this.resolveLeague();
      this.resolvedLeague = league;
      const searchResponse = await this.tradeRequest(
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
      if (!search.id || ids.length === 0) {
        const empty: CompsResult = {
          ok: true,
          league,
          summary: summarizeComps(parsed.mods.map((mod) => mod.text), [], query.basis, {
            priceTable: this.options.getPriceTable(),
          }),
        };
        this.compsCache.set(cacheKey, { at: Date.now(), result: empty });
        return empty;
      }
      const fetchResponse = await this.tradeRequest(
        `${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`,
        { method: "GET" },
      );
      if (fetchResponse.status === 429) {
        return { ok: false, error: "trade2 rate limit hit — wait a minute and try again." };
      }
      if (!fetchResponse.ok) throw new Error(`trade2 fetch → HTTP ${fetchResponse.status}`);
      const listings = parseCompListings(await fetchResponse.json());
      const summary = summarizeComps(
        parsed.mods.filter((mod) => !mod.implicit).map((mod) => mod.text),
        listings,
        query.basis,
        { priceTable: this.options.getPriceTable() },
      );
      const result: CompsResult = { ok: true, summary, league };
      this.compsCache.set(cacheKey, { at: Date.now(), result });
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
