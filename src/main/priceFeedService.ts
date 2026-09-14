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
import { buildRewardTradeQuery, buildRewardTradeUrl, type RewardIdentity } from "../core/helperReward.js";
import { buildStashTradeQuery, parseStashTradeStats, stashUnsupportedReason, stashQuoteFresh, summarizeStashListings, STASH_MARKET_MODEL, type StashTradeStat, type StashCurrencyRates } from "../core/stashMarket.js";
import type { StashMarketQuote } from "../core/stashValuation.js";
import { parseNinjaExchange } from "../core/priceHelper.js";

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
const HELPER_TRADE_TIMEOUT_MS = 15_000;
const HELPER_TRADE_MAX_BYTES = 2 * 1024 * 1024;

interface TradeResponseReader<T> {
  read: (response: Response, signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  canRun?: () => boolean;
}

/** Consume the body under the request deadline; never expose an API error body. */
async function helperTradeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status === 429) throw new Error("trade2 rate limit hit — try again after the restriction lifts.");
  if (!response.ok) throw new Error(`trade2 lookup → HTTP ${response.status}`);
  if (response.redirected) throw new Error("trade2 redirects are not allowed.");
  const declared = Number(headerOf(response, "content-length"));
  if (declared > HELPER_TRADE_MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("trade2 response exceeds the 2 MB limit.");
  }
  if (!response.body) throw new Error("trade2 returned no response body.");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("trade2 lookup timed out.");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("trade2 lookup timed out.");
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > HELPER_TRADE_MAX_BYTES) {
        cancel();
        throw new Error("trade2 response exceeds the 2 MB limit.");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error("trade2 returned invalid JSON."); }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export interface HelperRewardFetchResult {
  /** Main-process only: the helper validates and strips account data before IPC. */
  payload?: unknown;
  fetchedAt?: string;
  tradeUrl?: string;
  error?: string;
}

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
  /** Standalone tools may reuse authentication/settings without scheduling background refreshes. */
  disableAutoRefresh?: boolean;
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
  private readonly stashQuotes = new Map<string, StashMarketQuote>();
  private stashStats?: { at: number; entries: StashTradeStat[] };
  private readonly stashRates = new Map<string, StashCurrencyRates>();
  private readonly stashRateAttempts = new Map<string, number>();
  private stashAccessFailure?: string;
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

  /** Only rate headers are retained: never URLs, query bodies, accounts or cookies. */
  private saveRateDiagnostics(policy: string, response: Response): void {
    try {
      const file = path.join(this.options.configDir, "trade-response-diagnostics.json");
      const previous: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      const headers = Object.fromEntries([...response.headers].filter(([key]) => /^x-rate-limit-[a-z-]+$/.test(key) || key === "retry-after")
        .map(([key, value]) => [key, value.slice(0, 2000)]));
      const entry = { at: this.now().toISOString(), status: response.status, policy, headers };
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(file, JSON.stringify([...(Array.isArray(previous) ? previous.slice(-19) : []), entry]));
    } catch { /* Diagnostics must never affect the request or expose extra data. */ }
  }

  /** When trade2 has us in a penalty window: the time it lifts, else undefined. */
  rateLimitedUntilIso(): string | undefined {
    const until = Math.max(this.rateLimitedUntil, this.pacer.restrictedUntil());
    return until > Date.now() ? new Date(until).toISOString() : undefined;
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
    if (typeof partial.league === "string" && partial.league.trim() && partial.league.trim() !== this.config.league) this.resolvedLeague = undefined;
    if (typeof partial.poesessid === "string" && partial.poesessid !== this.config.poesessid) this.stashAccessFailure = undefined;
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
    if (!this.config.autoRefreshDaily || this.options.disableAutoRefresh) return;
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

  private tradeRequest(url: string, init: RequestInit): Promise<Response>;
  private tradeRequest<T>(url: string, init: RequestInit, reader: TradeResponseReader<T>): Promise<T>;
  private async tradeRequest<T>(url: string, init: RequestInit, reader?: TradeResponseReader<T>): Promise<Response | T> {
    // Serialize all trade2 traffic; the pacer spaces it from the server's
    // own rate-limit rules so no window ever fills.
    const policy = policyForUrl(url);
    const run = this.tradeChain.then(async () => {
      if (reader?.canRun && !reader.canRun()) throw new Error("Reward lookup cancelled.");
      if (reader && this.helperTradeRestricted()) throw new Error("trade2 rate limit is active — try again after the restriction lifts.");
      const gap = this.options.tradeSpacingMs ?? TRADE_MIN_GAP_MS;
      while (true) {
        this.pacer.merge(this.loadPacing());
        if (reader && this.helperTradeRestricted()) throw new Error("trade2 rate limit is active — try again after the restriction lifts.");
        const wait = Math.max(this.pacer.delayFor(policy), this.lastTradeRequestAt + gap - Date.now(),
          this.options.tradeSpacingMs === undefined ? this.pacer.spacingDelayFor(policy) : 0);
        if (wait <= 0) break;
        const until = Date.now() + wait;
        while (Date.now() < until) {
          if (reader?.canRun && !reader.canRun()) throw new Error("Reward lookup cancelled.");
          await new Promise(resolve => setTimeout(resolve, Math.min(reader?.canRun ? 100 : 1000, until - Date.now())));
        }
      }
      if (reader?.canRun && !reader.canRun()) throw new Error("Reward lookup cancelled.");
      if (reader && this.helperTradeRestricted()) throw new Error("trade2 rate limit is active — try again after the restriction lifts.");
      this.lastTradeRequestAt = Date.now();
      this.pacer.record(policy);
      this.savePacing();
      const controller = new AbortController();
      let timeoutReject: ((reason: Error) => void) | undefined;
      const timeout = new Promise<never>((_, reject) => { timeoutReject = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        timeoutReject?.(new Error("trade2 lookup timed out."));
      }, reader?.timeoutMs ?? FETCH_TIMEOUT_MS);
      try {
        const response = await Promise.race([this.fetchImpl(url, {
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
        }), timeout]);
        const retryAfter = headerOf(response, "retry-after");
        const retrySeconds = Number(retryAfter);
        const retryDate = Date.parse(retryAfter ?? "");
        const helperRetryAfter = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retryAfter
          : Number.isFinite(retryDate) ? String(Math.max(1, Math.ceil((retryDate - Date.now()) / 1000))) : "60";
        this.pacer.merge(this.loadPacing());
        const scopes = new Set(["ip", ...(headerOf(response, "x-rate-limit-rules") ?? "").split(",").map(scope => scope.trim().toLowerCase()).filter(scope => /^[a-z][a-z-]{0,30}$/.test(scope))]);
        for (const scope of scopes) this.pacer.observe(scope === "ip" ? policy : `${policy}:${scope}`, {
          rules: headerOf(response, `x-rate-limit-${scope}`),
          state: headerOf(response, `x-rate-limit-${scope}-state`),
          ...(response.status === 429 ? { retryAfter: reader ? helperRetryAfter : retryAfter } : {}),
        });
        const restricted = this.pacer.restrictedUntil();
        if (restricted > this.rateLimitedUntil) this.rateLimitedUntil = restricted;
        this.savePacing();
        this.saveRateDiagnostics(policy, response);
        return reader ? await Promise.race([reader.read(response, controller.signal), timeout]) : response;
      } finally {
        clearTimeout(timer);
      }
    });
    this.tradeChain = run.catch(() => undefined);
    return run;
  }

  private helperTradeRestricted(): boolean {
    return Math.max(this.rateLimitedUntil, this.pacer.restrictedUntil()) > Date.now();
  }

  /** One explicit league, strict per-item comparables, fresh observed rates; no fallback economy. */
  async fetchStashQuote(itemText: string, league: string, canRun?: () => boolean): Promise<StashMarketQuote> {
    const empty = (state: StashMarketQuote["state"], reason: string): StashMarketQuote => ({
      state, league, provider: "pathofexile-trade2", fetchedAt: this.now().toISOString(), currency: "chaos",
      sampleSize: 0, candidateCount: 0, confidence: 0, reasons: [reason],
      ...(state === "unavailable" && this.rateLimitedUntilIso() ? { retryAfter: this.rateLimitedUntilIso() } : {}),
    });
    if (typeof league !== "string" || league === "auto" || !/^[\p{L}\p{N}][\p{L}\p{N} '()-]{0,79}$/u.test(league)) return empty("unavailable", "Choose an explicit league for stash valuation.");
    if (!looksLikePoeItemText(itemText) || itemText.length > 30_000) return empty("unsupported", "The copied item text could not be parsed.");
    const active = () => canRun?.() !== false;
    if (!active()) return empty("unavailable", "Market lookup cancelled.");
    const parsed = parseItemText(itemText);
    const unsupported = stashUnsupportedReason(parsed);
    if (unsupported) return empty("unsupported", unsupported);
    // Only advanced unique parsing changed: preserve valid rare/magic cache work.
    const model = /^unique$/i.test(parsed.rarity) && /^\s*\{\s*Unique Modifier\b/im.test(itemText)
      ? `${STASH_MARKET_MODEL}:advanced-unique-1` : STASH_MARKET_MODEL;
    const key = JSON.stringify([league, model, itemText]);
    const file = path.join(this.options.configDir, "stash-market-quotes.json");
    if (!this.stashQuotes.size) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, StashMarketQuote>;
        for (const [savedKey, quote] of Object.entries(saved)) {
          if (quote && quote.currency === "chaos" && quote.provider === "pathofexile-trade2" && Array.isArray(quote.reasons) && typeof quote.league === "string" &&
            (quote.state === "priced" || quote.state === "no-comparables") && stashQuoteFresh(quote, this.now().getTime())) this.stashQuotes.set(savedKey, quote);
        }
      } catch { /* Cold cache. */ }
    }
    const cached = this.stashQuotes.get(key);
    if (cached && cached.league === league && stashQuoteFresh(cached, this.now().getTime())) return { ...cached, reasons: [...cached.reasons], cached: true };
    if (this.stashAccessFailure) return empty("unavailable", this.stashAccessFailure);
    if (this.helperTradeRestricted()) return empty("unavailable", "trade2 rate limit is active; retry after its restriction lifts.");
    const reader = { read: (response: Response, signal: AbortSignal) => {
      if (response.status === 401 || response.status === 403) this.stashAccessFailure = `trade2 access denied (HTTP ${response.status}); further stash requests are paused for this session. Update trade authentication or restart the app before retrying.`;
      return helperTradeJson(response, signal);
    }, timeoutMs: HELPER_TRADE_TIMEOUT_MS, canRun: active };
    const init = { redirect: "error", credentials: "omit" } as const;
    try {
      let rates = this.stashRates.get(league);
      const rateAge = rates ? this.now().getTime() - Date.parse(rates.fetchedAt) : Infinity;
      if (rateAge < 0 || rateAge >= 15 * 60_000) {
        rates = undefined;
        // Credential-free public economy request. Failure leaves native-chaos matching available.
        if (this.now().getTime() - (this.stashRateAttempts.get(league) ?? -Infinity) >= 5 * 60_000) try {
          this.stashRateAttempts.set(league, this.now().getTime());
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), HELPER_TRADE_TIMEOUT_MS);
          try {
            if (!active()) throw new Error("Market lookup cancelled.");
            const response = await this.fetchImpl(`https://poe.ninja/poe2/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`, {
              signal: controller.signal, redirect: "error", credentials: "omit", headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            });
            const prices = parseNinjaExchange(await helperTradeJson(response, controller.signal));
            const chaosPerCurrency: Record<string, number> = { chaos: 1 };
            for (const [currency, name] of [["exalted", "Exalted Orb"], ["divine", "Divine Orb"]] as const) {
              const matches = prices.filter(price => price.name === name);
              if (matches.length === 1 && typeof matches[0]!.chaos === "number" && Number.isFinite(matches[0]!.chaos) && matches[0]!.chaos! > 0) chaosPerCurrency[currency] = matches[0]!.chaos!;
            }
            if (Object.keys(chaosPerCurrency).length > 1) {
              rates = { league, fetchedAt: this.now().toISOString(), chaosPerCurrency };
              this.stashRates.set(league, rates);
            }
          } finally { clearTimeout(timer); }
        } catch { /* No inferred or stale exchange rate is substituted. */ }
      }
      if (parsed.mods.length && (!this.stashStats || this.now().getTime() - this.stashStats.at >= 24 * 60 * 60_000)) {
        const payload = await this.tradeRequest(`${TRADE_BASE}/data/stats`, { ...init, method: "GET" }, reader);
        const entries = parseStashTradeStats(payload);
        if (!entries.length) throw new Error("Current trade stat catalog is unavailable.");
        this.stashStats = { at: this.now().getTime(), entries };
      }
      const query = buildStashTradeQuery(parsed, this.stashStats?.entries ?? [], Boolean(rates));
      const tradeUrl = `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(query.body))}`;
      const payload = await this.tradeRequest(`${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`, { ...init, method: "POST", body: JSON.stringify(query.body) }, reader);
      const search = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (typeof search.id !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(search.id) || !Array.isArray(search.result)) throw new Error("trade2 returned an invalid search result.");
      const ids = [...new Set(search.result.slice(0, 10))];
      if (ids.some(id => typeof id !== "string" || !/^[a-fA-F0-9]{64}$/.test(id))) throw new Error("trade2 returned an invalid listing ID.");
      const listings = ids.length ? await this.tradeRequest(`${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}&realm=poe2`, { ...init, method: "GET" }, reader) : { result: [] };
      if (!active()) return empty("unavailable", "Market lookup cancelled.");
      const quote = summarizeStashListings(parsed, listings, { league, fetchedAt: this.now().toISOString(), query, tradeUrl, rates });
      this.stashQuotes.set(key, quote);
      try {
        const fresh = [...this.stashQuotes].filter(([, value]) => stashQuoteFresh(value, this.now().getTime())).slice(-2000);
        mkdirSync(this.options.configDir, { recursive: true });
        writeFileSync(file, JSON.stringify(Object.fromEntries(fresh)));
      } catch { /* In-memory quote remains valid when disk storage is unavailable. */ }
      return quote;
    } catch (error) {
      return empty("unavailable", error instanceof Error ? error.message.slice(0, 200) : "trade2 lookup failed.");
    }
  }

  /** A bounded, paced search/fetch for an already identified reward. Never retries a 429. */
  async fetchHelperReward(identity: RewardIdentity, league: string, canRun?: () => boolean): Promise<HelperRewardFetchResult> {
    if (typeof league !== "string" || league.length > 80 || !/^[\p{L}\p{N}]/u.test(league) || /[^\p{L}\p{N} '()-]/u.test(league)) {
      return { error: "Invalid reward league." };
    }
    const query = buildRewardTradeQuery(identity);
    const tradeUrl = buildRewardTradeUrl(identity, league);
    if (!query || !tradeUrl) return { error: "The reward could not be identified exactly." };
    if (this.helperTradeRestricted()) return { tradeUrl, error: "trade2 rate limit is active — try again after the restriction lifts." };
    const read = { read: helperTradeJson, timeoutMs: HELPER_TRADE_TIMEOUT_MS, canRun };
    const init = { redirect: "error", credentials: "omit" } as const;
    try {
      const payload = await this.tradeRequest(
        `${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`,
        { ...init, method: "POST", body: JSON.stringify(query) }, read,
      );
      const search = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (typeof search.id !== "string" || !search.id.length || search.id.length > 2048 || /[^A-Za-z0-9_-]/.test(search.id) || !Array.isArray(search.result)) {
        throw new Error("trade2 returned an invalid search result.");
      }
      const ids = search.result.slice(0, 10);
      if (ids.some(id => typeof id !== "string" || id.length !== 64 || /[^a-fA-F0-9]/.test(id))) {
        throw new Error("trade2 returned an invalid listing ID.");
      }
      if (!ids.length) return { payload: { result: [] }, fetchedAt: this.now().toISOString(), tradeUrl };
      const result = await this.tradeRequest(
        `${TRADE_BASE}/fetch/${[...new Set(ids)].join(",")}?query=${encodeURIComponent(search.id)}&realm=poe2`,
        { ...init, method: "GET" }, read,
      );
      return { payload: result, fetchedAt: this.now().toISOString(), tradeUrl };
    } catch (error) {
      return { tradeUrl, error: error instanceof Error ? error.message.slice(0, 200) : "trade2 lookup failed." };
    }
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

    let league: string;
    try {
      league = this.config.league === "auto" ? this.resolvedLeague ?? await this.resolveLeague() : this.config.league;
      this.resolvedLeague = league;
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    const cacheKey = JSON.stringify([league, query.body]);
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
        `${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}&realm=poe2`,
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
