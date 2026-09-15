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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AmbiguousLeagueError,
  applyFeedSnapshotIfNewer,
  currentScoutLeagues,
  feedAgeHours,
  isFeedEntry,
  mergeFeedSnapshot,
  normalizeScoutItems,
  parseFeedSnapshot,
  type PriceFeedSnapshot,
  type ScoutLeagueCandidate,
} from "../core/priceFeed.js";
import {
  buildCompsQuery,
  buildStatFilteredQuery,
  parseCompListings,
  summarizeComps,
  type CompListing,
  type CompsQuery,
  type CompsSummary,
} from "../core/tradeComps.js";
import { appraiseItem } from "../core/appraisal.js";
import { MOD_FAMILIES } from "../core/modKnowledge.js";
import { buildStatCatalogue, unresolvedFamilies, type StatCatalogue } from "../core/statIds.js";
import {
  addObservations,
  emptyLearnedTiers,
  learnTiersFromFetch,
  serializeLearnedTiers,
  type LearnedTiers,
} from "../core/tierLearning.js";
import {
  LEARNED_TIERS_FILE,
  TRADE_STATS_FILE,
  loadLearnedTiers,
} from "../adapters/learnedTiersStore.js";
import {
  FETCH_POLICY,
  SEARCH_POLICY,
  TradePacer,
  policyForUrl,
  type PacerSnapshot,
} from "../core/tradePacing.js";
import { isAffixMod, looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import { trainingIdentity } from "../core/priceTraining.js";
import type { PriceTable } from "../core/priceTable.js";
import {
  parseExchangeResult,
  parseTradeListings,
  type ExchangeOffer,
  type TradeListing,
} from "../core/tradeListings.js";
import { exchangeUrl, tradeSearchUrl } from "../core/tradeQuery.js";
import { stableTradeQueryJson } from "../core/tradeQueryImport.js";

const SCOUT_BASE = "https://api.poe2scout.com/poe2";
const TRADE_BASE = "https://www.pathofexile.com/api/trade2";
const USER_AGENT = "poe2-trade-companion/0.1 (local desktop tool)";
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
/** /Leagues barely changes; status() reads this cache, never the network. */
const LEAGUES_CACHE_MS = 10 * 60_000;
/** Courtesy gap between trade2 requests on top of the rate-limit pacing. */
const TRADE_MIN_GAP_MS = 750;
/** Base-type searches return the base's floor listings: slow-moving. */
const COMPS_CACHE_BASE_MS = 6 * 60 * 60_000;
/** Unique-name searches move with the market: an hour. */
const COMPS_CACHE_UNIQUE_MS = 60 * 60_000;
/** Stat-filtered searches are the item's own market: an hour too. */
const COMPS_CACHE_STAT_MS = 60 * 60_000;
/** The stats catalogue is static data (Cache-Control: 4h upstream); a week. */
const STATS_CACHE_MS = 7 * 24 * 60 * 60_000;
/** /data/static is static data too (icons, currency ids): same week-long TTL. */
const STATIC_CACHE_MS = STATS_CACHE_MS;
/** The /data/static payload cache, next to trade-stats.json in configDir. */
const TRADE_STATIC_FILE = "trade-static.json";
/** After a failed catalogue fetch, leave the stat stage off this long. */
const STATS_RETRY_MS = 5 * 60_000;
/** A stat-filtered search must find this many listings to price by itself. */
const STAT_STAGE_MIN_IDS = 3;

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
  return basis === "unique-name"
    ? COMPS_CACHE_UNIQUE_MS
    : basis === "stat-filtered"
      ? COMPS_CACHE_STAT_MS
      : COMPS_CACHE_BASE_MS;
}

function isCachedComps(value: unknown): value is CachedComps {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CachedComps>;
  return (
    typeof entry.at === "number" &&
    typeof entry.league === "string" &&
    (entry.basis === "unique-name" ||
      entry.basis === "base-type" ||
      entry.basis === "stat-filtered") &&
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

export interface TradeBudget {
  /** Lookups (one search + one fetch each) that could go out right now. */
  lookups: number;
  /** Search-policy slots spare right now (0 inside a penalty window). */
  searchesSpare: number;
  /** Fetch-policy slots spare right now (0 inside a penalty window). */
  fetchesSpare: number;
  restrictedUntilIso?: string;
}

/** A trade2 penalty window is in force (or was just earned): no traffic until it lifts. */
export class TradeRateLimitedError extends Error {
  readonly restrictedUntilIso: string | undefined;

  constructor(message: string, restrictedUntilIso?: string) {
    super(message);
    this.name = "TradeRateLimitedError";
    this.restrictedUntilIso = restrictedUntilIso;
  }
}

/** One generic search's answer (tradeSearch). */
export interface TradeSearchResult {
  id: string;
  total: number;
  resultIds: string[];
  league: string;
  url: string;
  cached: boolean;
  /** trade2 refused the query as too complex (HTTP 400): nothing was searched. */
  complexityError?: string;
}

export interface TradeExchangeResult {
  id: string;
  total: number;
  offers: ExchangeOffer[];
  league: string;
  url: string;
}

/** Generic searches are cached by body hash for a short while (60 s default). */
const GENERIC_SEARCH_CACHE_MS = 60_000;
/** The generic search cache never grows past this many bodies. */
const GENERIC_SEARCH_CACHE_MAX = 200;
/** trade2 fetch takes at most ten ids per GET (the site batches the same way). */
const TRADE_FETCH_BATCH = 10;
/** Recent generic trade2 requests kept for diagnostics (reason + kind). */
const TRADE_LOG_MAX = 100;

export interface TradeRequestLogEntry {
  at: string;
  kind: "search" | "fetch" | "exchange";
  reason: string;
  league: string;
  /** Ids fetched (fetch) or the search id (search/exchange). */
  detail?: string;
}

export interface PriceFeedStatus {
  config: PriceFeedConfig;
  /** The league requests use: the pinned one, or the single current league. */
  resolvedLeague?: string;
  /** Current softcore leagues poe2scout listed on the last /Leagues read. */
  leagueCandidates: ScoutLeagueCandidate[];
  /** League is "auto" and more than one candidate exists: pricing is blocked. */
  leagueAmbiguous: boolean;
  lastRefreshAt?: string;
  lastError?: string;
  feedEntryCount: number;
  feedAgeHours?: number;
  refreshing: boolean;
  /** trade2 lookups that could go out right now, and any penalty window. */
  tradeBudget: { lookups: number; restrictedUntilIso?: string };
}

export interface CompsResult {
  ok: boolean;
  summary?: CompsSummary;
  error?: string;
  cached?: boolean;
  league?: string;
  /** Which search stage produced the summary (stat-filtered beats base-type). */
  basis?: CompsQuery["basis"];
  /** Original listing-sample time; cache reads never refresh this timestamp. */
  fetchedAt?: string;
  /** Expiry of the underlying raw listing sample. */
  expiresAt?: string;
}

/** One raw trade2 search + fetch (searchListings): listings, uncached. */
export interface SearchListingsResult {
  ok: boolean;
  listings: CompListing[];
  league?: string;
  error?: string;
  /** The search's own match count (before the fetch cap). */
  total?: number;
}

interface PriceFeedServiceOptions {
  configDir: string;
  /**
   * Where the optional POESESSID lives. Defaults to the per-user app-data
   * folder (%APPDATA%/poe2-trade-companion), NOT configDir: artifacts/ sits in
   * the repo (often cloud-synced), and a session cookie must never land
   * there. The app and every CLI resolve the same default.
   */
  secretDir?: string;
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
  private leagueCandidates: ScoutLeagueCandidate[] = [];
  private leaguesFetchedAt = 0;

  constructor(private readonly options: PriceFeedServiceOptions) {
    this.config = this.loadConfig();
    // A cookie found in the old location (price-feed.json) moves to the
    // secret file on first sight, and the config is rewritten without it.
    if (this.legacyCookieInConfig) this.persistConfig();
    this.syncResolvedLeague();
    this.pacer = new TradePacer(this.loadPacing());
    this.loadCompsCache();
    // A penalty window another process ran into lives in the pacing log;
    // without this a fresh process would not report it and would stall
    // inline on the first request instead.
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.pacer.restrictedUntil());
    this.applyStoredSnapshot();
    this.armDailyTimer();
  }

  /**
   * The last successful fetch, whichever process made it
   * (configDir/feed-snapshot.json): a fresh process merges it into the
   * table when it is newer than the feed data the table carries, so the
   * CLIs and a cold-started app price off the latest numbers without a
   * network round trip.
   */
  private snapshotFile(): string {
    return path.join(this.options.configDir, "feed-snapshot.json");
  }

  private saveSnapshot(snapshot: PriceFeedSnapshot): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(this.snapshotFile(), JSON.stringify(snapshot));
    } catch {
      // Best effort; this process already merged the snapshot.
    }
  }

  private applyStoredSnapshot(): void {
    try {
      const file = this.snapshotFile();
      if (!existsSync(file)) return;
      const snapshot = parseFeedSnapshot(JSON.parse(readFileSync(file, "utf8")));
      if (!snapshot) return;
      const result = applyFeedSnapshotIfNewer(this.options.getPriceTable(), snapshot, {
        now: this.now(),
        league: this.config.league,
      });
      if (result.applied && result.changed) this.options.savePriceTable(result.table);
    } catch {
      // An unreadable snapshot is just a cold table until the next refresh.
    }
  }

  /**
   * How many trade2 lookups (one search + one fetch each) could go out right
   * now without waiting, the spare slots per policy for callers that spend
   * only one kind (a live search fetches, an exchange searches), and when a
   * restriction lifts if one is in force.
   */
  tradeBudget(): TradeBudget {
    // Search, fetch, and the house rules' combined guard (a lookup spends
    // one of each) — see core/tradePacing.ts HOUSE_RULES.
    const now = Date.now();
    const lookups = this.pacer.lookupsAvailable(now);
    const until = this.rateLimitedUntilIso();
    return {
      lookups: Math.max(0, lookups),
      searchesSpare: until ? 0 : this.pacer.available(SEARCH_POLICY, now),
      fetchesSpare: until ? 0 : this.pacer.available(FETCH_POLICY, now),
      ...(until ? { restrictedUntilIso: until } : {}),
    };
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

  /** Set by loadConfig when price-feed.json still carried the cookie. */
  private legacyCookieInConfig = false;

  private secretDir(): string {
    return (
      this.options.secretDir ??
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "poe2-trade-companion",
      )
    );
  }

  /** The POESESSID, alone, outside the repo tree. */
  private secretFile(): string {
    return path.join(this.secretDir(), "price-feed.secret.json");
  }

  private loadSecret(): string {
    try {
      const file = this.secretFile();
      if (!existsSync(file)) return "";
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { poesessid?: unknown };
      return typeof parsed.poesessid === "string" ? parsed.poesessid : "";
    } catch {
      return "";
    }
  }

  private persistSecret(): void {
    const file = this.secretFile();
    if (!this.config.poesessid) {
      if (existsSync(file)) rmSync(file, { force: true });
      return;
    }
    mkdirSync(this.secretDir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ poesessid: this.config.poesessid }, null, 2));
  }

  private configFile(): string {
    return path.join(this.options.configDir, "price-feed.json");
  }

  private loadConfig(): PriceFeedConfig {
    try {
      const file = this.configFile();
      if (!existsSync(file)) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PriceFeedConfig>;
      const legacy = typeof parsed.poesessid === "string" ? parsed.poesessid : "";
      const secret = this.loadSecret();
      this.legacyCookieInConfig = legacy.length > 0;
      return {
        league: typeof parsed.league === "string" && parsed.league.trim() ? parsed.league : "auto",
        autoRefreshDaily: parsed.autoRefreshDaily === true,
        // The secret file wins; a cookie still in the config is migrated.
        poesessid: secret || legacy,
      };
    } catch {
      return { ...DEFAULT_CONFIG, poesessid: this.loadSecret() };
    }
  }

  private persistConfig(): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      const shareable = { league: this.config.league, autoRefreshDaily: this.config.autoRefreshDaily };
      writeFileSync(this.configFile(), JSON.stringify(shareable, null, 2));
      this.persistSecret();
      this.legacyCookieInConfig = false;
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
    this.syncResolvedLeague();
    this.armDailyTimer();
    return this.status();
  }

  /**
   * What the next request will use: a pinned league as-is; "auto" only when
   * the cached candidates leave exactly one choice.
   */
  private syncResolvedLeague(): void {
    if (this.config.league !== "auto") {
      this.resolvedLeague = this.config.league;
      return;
    }
    this.resolvedLeague =
      this.leagueCandidates.length === 1 ? this.leagueCandidates[0]!.value : undefined;
  }

  private leagueAmbiguous(): boolean {
    return this.config.league === "auto" && this.leagueCandidates.length > 1;
  }

  status(): PriceFeedStatus {
    const table = this.options.getPriceTable();
    const feedEntries = table.entries.filter((entry) => isFeedEntry(entry, "poe2scout"));
    return {
      config: { ...this.config, poesessid: this.config.poesessid ? "(set)" : "" },
      ...(this.resolvedLeague ? { resolvedLeague: this.resolvedLeague } : {}),
      leagueCandidates: this.leagueCandidates.map((candidate) => ({ ...candidate })),
      leagueAmbiguous: this.leagueAmbiguous(),
      ...(this.lastRefreshAt ? { lastRefreshAt: this.lastRefreshAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      feedEntryCount: feedEntries.length,
      ...(feedAgeHours(table, "poe2scout", this.now()) !== undefined
        ? { feedAgeHours: Math.round(feedAgeHours(table, "poe2scout", this.now())! * 10) / 10 }
        : {}),
      refreshing: this.refreshing,
      tradeBudget: this.tradeBudget(),
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

  /**
   * The current softcore leagues poe2scout lists, cached for ten minutes.
   * The one network call a league picker needs; refresh/comps go through
   * it too, so the cache is warm whenever pricing has run.
   */
  async leagues(): Promise<ScoutLeagueCandidate[]> {
    const now = this.now().getTime();
    if (this.leaguesFetchedAt > 0 && now - this.leaguesFetchedAt < LEAGUES_CACHE_MS) {
      return this.leagueCandidates.map((candidate) => ({ ...candidate }));
    }
    const payload = await this.getJson(`${SCOUT_BASE}/Leagues`);
    this.leagueCandidates = currentScoutLeagues(payload);
    this.leaguesFetchedAt = now;
    this.syncResolvedLeague();
    return this.leagueCandidates.map((candidate) => ({ ...candidate }));
  }

  private async resolveLeague(): Promise<string> {
    if (this.config.league !== "auto") return this.config.league;
    const candidates = await this.leagues();
    if (candidates.length === 0) throw new Error("poe2scout returned no current softcore league");
    if (candidates.length > 1) throw new AmbiguousLeagueError(candidates);
    return candidates[0]!.value;
  }

  private recordError(error: unknown): string {
    if (error instanceof AmbiguousLeagueError) this.resolvedLeague = undefined;
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * The league a comps cache entry must carry to count as a hit: the pinned
   * one as-is, else the resolved "auto" league (one /Leagues read per ten
   * minutes; refused while ambiguous). Listings from another league are
   * another economy, never a price for this one.
   */
  private async cacheLeague(): Promise<string> {
    if (this.resolvedLeague) return this.resolvedLeague;
    const league = await this.resolveLeague();
    this.resolvedLeague = league;
    return league;
  }

  /** Inside its TTL AND fetched in `league`. */
  private cacheHit(entry: CachedComps | undefined, league: string): entry is CachedComps {
    return (
      entry !== undefined && entry.league === league && Date.now() - entry.at < compsTtl(entry.basis)
    );
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
      this.saveSnapshot(snapshot);
      this.lastRefreshAt = snapshot.fetchedAt;
    } catch (error) {
      this.lastError = this.recordError(error);
    } finally {
      this.refreshing = false;
    }
    return this.status();
  }

  // -------------------------------------------------------------------------
  // trade2 comps
  // -------------------------------------------------------------------------

  private async tradeRequest(url: string, init: RequestInit, sparse = false): Promise<Response> {
    // Serialize all trade2 traffic; the pacer spaces it from the server's
    // own rate-limit rules so no window ever fills.
    const policy = policyForUrl(url);
    const run = this.tradeChain.then(async () => {
      if (sparse) {
        // Recheck INSIDE the shared queue: an earlier request may have spent
        // the last slot or earned a restriction after the button was pressed.
        this.refuseIfRateLimited();
        if (this.pacer.delayFor(policy) > 0) throw new Error("No spare trade2 request right now — nothing was queued for later.");
      }
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
        return response;
      } finally {
        clearTimeout(timer);
        // The hit is on the shared log even when the request timed out or
        // the socket dropped: the server most likely counted it.
        this.savePacing();
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
    // hitting the API again inside the window only extends it. The pacer
    // already took the server's Retry-After in tradeRequest, so a long
    // restriction there means "do not retry" whatever the test seam says.
    const restrictedMs = this.pacer.restrictedUntil() - Date.now();
    if (restrictedMs > 30_000 || (waitMs > 30_000 && this.options.rateLimitBackoffMs === undefined)) {
      // Never shorten what the pacer already took from Retry-After (600 s on
      // 2026-09-07): a window remembered as 300 s knocks on the door early.
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + Math.max(waitMs, restrictedMs));
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
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + penaltyMs);
      this.saveCompsCache();
    }
    return second;
  }

  // ---- stats catalogue + learned tiers (lazy: nothing loads until a lookup) --

  private statCatalogueCache: StatCatalogue | undefined;
  private statsFailedAt = 0;
  private statWarningLogged = false;
  private learnedTiersStore: LearnedTiers | undefined;
  /** The raw /data/stats payload behind `statCatalogueCache`, for re-indexing. */
  private statsPayload: unknown | undefined;
  /** When that payload was fetched (the disk cache's `at`), epoch ms. */
  private statsPayloadAt = 0;
  /** types-key → catalogue, rebuilt whenever `statsPayloadAt` moves. */
  private readonly statCataloguesByTypes = new Map<string, StatCatalogue>();
  private statCataloguesBuiltAt = -1;
  private staticPayload: unknown | undefined;
  private staticPayloadAt = 0;
  private staticFailedAt = 0;

  private statsFile(): string {
    return path.join(this.options.configDir, TRADE_STATS_FILE);
  }

  private staticFile(): string {
    return path.join(this.options.configDir, TRADE_STATIC_FILE);
  }

  /** `{ at, payload }` as both static-data caches are written. */
  private readCachedPayload(file: string): { at: number; payload: unknown } | undefined {
    try {
      if (!existsSync(file)) return undefined;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown; payload?: unknown };
      if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return undefined;
      if (parsed.payload === undefined) return undefined;
      return { at: parsed.at, payload: parsed.payload };
    } catch {
      return undefined; // a corrupt cache is a cold cache
    }
  }

  private writeCachedPayload(file: string, payload: unknown, at: number): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ at, payload }));
    } catch {
      // Best effort; the in-memory copy serves this process.
    }
  }

  private catalogueFrom(payload: unknown): StatCatalogue | undefined {
    const catalogue = buildStatCatalogue(payload, MOD_FAMILIES);
    if (catalogue.entryCount === 0) return undefined;
    if (!this.statWarningLogged) {
      this.statWarningLogged = true;
      const missing = unresolvedFamilies(catalogue.byFamily, MOD_FAMILIES);
      if (missing.length > 0) {
        console.warn(`[price-feed] no trade2 stat id for mod families: ${missing.join(", ")}`);
      }
    }
    return catalogue;
  }

  /**
   * The trade2 stats catalogue as a family/text → id index, from
   * configDir/trade-stats.json (7-day TTL) or one GET of
   * /api/trade2/data/stats — static data outside the search/fetch policies.
   * A stale disk copy beats a failed fetch (ids do not move); a failed fetch
   * with no copy turns the stat stage off for five minutes.
   */
  async fetchStats(): Promise<StatCatalogue | undefined> {
    if (this.statCatalogueCache) return this.statCatalogueCache;
    let stale: StatCatalogue | undefined;
    try {
      const file = this.statsFile();
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown; payload?: unknown };
        const catalogue = this.catalogueFrom(parsed.payload);
        if (parsed.payload !== undefined && typeof parsed.at === "number") {
          // The payload is remembered even when stale: a stale catalogue is
          // what this method serves when the network is down, and
          // statCatalogue(types) re-indexes the same bytes for other types.
          this.rememberStatsPayload(parsed.payload, parsed.at);
        }
        if (catalogue && typeof parsed.at === "number" && Date.now() - parsed.at < STATS_CACHE_MS) {
          this.statCatalogueCache = catalogue;
          return catalogue;
        }
        stale = catalogue;
      }
    } catch {
      // Corrupt cache: refetch.
    }
    if (Date.now() - this.statsFailedAt < STATS_RETRY_MS) return stale;
    try {
      const payload = await this.getJson(`${TRADE_BASE}/data/stats`);
      const catalogue = this.catalogueFrom(payload);
      if (!catalogue) throw new Error("trade2 stats catalogue held no explicit entries");
      const at = Date.now();
      this.writeCachedPayload(this.statsFile(), payload, at);
      this.rememberStatsPayload(payload, at);
      this.statCatalogueCache = catalogue;
      return catalogue;
    } catch {
      this.statsFailedAt = Date.now();
      return stale;
    }
  }

  private rememberStatsPayload(payload: unknown, at: number): void {
    this.statsPayload = payload;
    this.statsPayloadAt = at;
  }

  /**
   * The raw /data/stats payload if one is already at hand: this process's
   * copy, else configDir/trade-stats.json when it is younger than a week.
   * NEVER touches the network and never waits — a caller that only wants to
   * index stat ids offline (Inspect, Evaluate) uses this and falls back to
   * its own "catalogue unavailable" path.
   */
  statsPayloadCached(): unknown | undefined {
    if (this.statsPayload !== undefined && Date.now() - this.statsPayloadAt < STATS_CACHE_MS) {
      return this.statsPayload;
    }
    const cached = this.readCachedPayload(this.statsFile());
    if (!cached || Date.now() - cached.at >= STATS_CACHE_MS) return undefined;
    this.rememberStatsPayload(cached.payload, cached.at);
    return cached.payload;
  }

  /**
   * The stats catalogue indexed over `types` (default: explicit mods only,
   * exactly what fetchStats builds). Same acquisition path as fetchStats —
   * memory, then the disk cache, then one unpaced GET — and the built
   * catalogue is cached per payload timestamp + types, so asking for
   * "implicit" and "explicit" separately costs no extra request.
   * Undefined when no payload can be had, or when it holds no entry of
   * those types.
   */
  async statCatalogue(types?: readonly string[]): Promise<StatCatalogue | undefined> {
    // fetchStats owns the acquisition (and the stale-beats-nothing rule);
    // it leaves the payload on `statsPayload` whichever way it got there.
    await this.fetchStats();
    const payload = this.statsPayload;
    if (payload === undefined) return undefined;
    if (this.statCataloguesBuiltAt !== this.statsPayloadAt) {
      this.statCataloguesByTypes.clear();
      this.statCataloguesBuiltAt = this.statsPayloadAt;
    }
    const key = types ? types.map((type) => type.toLowerCase()).join(",") : "";
    const hit = this.statCataloguesByTypes.get(key);
    if (hit) return hit;
    const catalogue = types
      ? buildStatCatalogue(payload, MOD_FAMILIES, types)
      : buildStatCatalogue(payload, MOD_FAMILIES);
    if (catalogue.entryCount === 0) return undefined;
    this.statCataloguesByTypes.set(key, catalogue);
    return catalogue;
  }

  /**
   * The trade2 static data payload (GET /api/trade2/data/static): currency
   * ids, their names and icons. Static like /data/stats — the same headers,
   * outside the search/fetch pacing policies — cached for a week in
   * configDir/trade-static.json. A stale disk copy beats a failed fetch; a
   * failure with no copy is retried after five minutes.
   */
  async fetchStatic(): Promise<unknown | undefined> {
    if (this.staticPayload !== undefined && Date.now() - this.staticPayloadAt < STATIC_CACHE_MS) {
      return this.staticPayload;
    }
    const cached = this.readCachedPayload(this.staticFile());
    if (cached && Date.now() - cached.at < STATIC_CACHE_MS) {
      this.staticPayload = cached.payload;
      this.staticPayloadAt = cached.at;
      return cached.payload;
    }
    const stale = cached?.payload;
    if (Date.now() - this.staticFailedAt < STATS_RETRY_MS) return stale;
    try {
      const payload = await this.getJson(`${TRADE_BASE}/data/static`);
      if (payload === undefined || payload === null) throw new Error("trade2 static data was empty");
      const at = Date.now();
      this.writeCachedPayload(this.staticFile(), payload, at);
      this.staticPayload = payload;
      this.staticPayloadAt = at;
      return payload;
    } catch {
      this.staticFailedAt = Date.now();
      return stale;
    }
  }

  /** The learned-tier store (configDir/mod-tiers.json), loaded on first use. */
  learnedTiers(): LearnedTiers {
    if (!this.learnedTiersStore) {
      this.learnedTiersStore = loadLearnedTiers(this.options.configDir) ?? emptyLearnedTiers();
    }
    return this.learnedTiersStore;
  }

  /** Fold one fetch payload's tier data into the store and persist it. */
  private learnFromFetch(payload: unknown, itemClass: string | undefined): number {
    const observations = learnTiersFromFetch(payload, itemClass);
    if (observations.length === 0) return 0;
    this.learnedTiersStore = addObservations(this.learnedTiers(), observations);
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(
        path.join(this.options.configDir, LEARNED_TIERS_FILE),
        serializeLearnedTiers(this.learnedTiersStore),
      );
    } catch {
      // Best effort; the in-memory store still serves this process.
    }
    return observations.length;
  }

  /**
   * One search (+ one fetch of up to `limit` (≤ 10) listings when the
   * search finds at least `minIds`). Every fetch teaches the learned-tier
   * store. `total` is the search's own match count.
   */
  private async runCompsQuery(
    league: string,
    query: CompsQuery,
    itemClass: string | undefined,
    minIds: number,
    limit = 10,
  ): Promise<
    { kind: "ok"; listings: CompListing[]; total: number } | { kind: "rate-limited" }
  > {
    const searchResponse = await this.tradeRequestWithBackoff(
      `${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`,
      { method: "POST", body: JSON.stringify(query.body) },
    );
    if (searchResponse.status === 429) return { kind: "rate-limited" };
    if (!searchResponse.ok) throw new Error(`trade2 search → HTTP ${searchResponse.status}`);
    const search = (await searchResponse.json()) as {
      id?: string;
      result?: string[];
      total?: number;
    };
    const cap = Math.max(1, Math.min(10, Math.floor(limit)));
    const ids = Array.isArray(search.result) ? search.result.slice(0, cap) : [];
    const total =
      typeof search.total === "number" && Number.isFinite(search.total)
        ? search.total
        : Array.isArray(search.result)
          ? search.result.length
          : 0;
    if (!search.id || ids.length === 0 || ids.length < minIds) {
      return { kind: "ok", listings: [], total };
    }
    const fetchResponse = await this.tradeRequestWithBackoff(
      `${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`,
      { method: "GET" },
    );
    if (fetchResponse.status === 429) return { kind: "rate-limited" };
    if (!fetchResponse.ok) throw new Error(`trade2 fetch → HTTP ${fetchResponse.status}`);
    const payload = await fetchResponse.json();
    this.learnFromFetch(payload, itemClass);
    return { kind: "ok", listings: parseCompListings(payload), total };
  }

  /**
   * One paced trade2 search for an arbitrary body (the deals watchlist),
   * plus ONE fetch of the first `limit` (≤ 10) ids. Same league
   * resolution, pacing and 429 handling as fetchComps, but nothing here
   * reads or writes the comps cache — a watch is a fresh look at the
   * market every time, and its sample must not be served to a price check.
   * A penalty window is reported, never waited out.
   */
  async searchListings(
    body: Record<string, unknown>,
    options: { limit?: number } = {},
  ): Promise<SearchListingsResult> {
    const until = this.rateLimitedUntilIso();
    if (until) {
      return {
        ok: false,
        listings: [],
        error: `trade2 rate limited until ${new Date(until).toLocaleTimeString()} — try again then`,
      };
    }
    try {
      const league = await this.resolveLeague();
      this.resolvedLeague = league;
      const stage = await this.runCompsQuery(
        league,
        { basis: "base-type", body },
        undefined,
        1,
        options.limit ?? 10,
      );
      if (stage.kind === "rate-limited") {
        return {
          ok: false,
          listings: [],
          league,
          error: "trade2 rate limit hit — wait a minute and try again.",
        };
      }
      return { ok: true, listings: stage.listings, league, total: stage.total };
    } catch (error) {
      return { ok: false, listings: [], error: this.recordError(error) };
    }
  }

  /**
   * Two-stage comps (2026-09-07):
   *   1. stat-filtered — base type + the item's own notable mods as stat
   *      filters. Runs when the item is not unique, has notable mods, and
   *      the catalogue resolves them. Prices by itself when the search
   *      finds ≥ 3 listings (the similarity bar drops to 0: they matched by
   *      construction); a thinner result is cached and falls through.
   *   2. base-type / unique-name — the broad search, similarity-filtered.
   * Each stage caches under its own query body; a fresh base cache is
   * served while a penalty window is in force instead of an error.
   */
  async fetchComps(itemText: string): Promise<CompsResult> {
    if (!looksLikePoeItemText(itemText)) {
      return { ok: false, error: "Not recognizable item text." };
    }
    const parsed = parseItemText(itemText);
    const baseQuery = buildCompsQuery(parsed);
    if (!baseQuery) return { ok: false, error: "The item has no searchable base type." };
    // The league before the cache: a cached sample only prices the league
    // it came from (an ambiguous "auto" refuses here, cache or no cache).
    let league: string;
    try {
      league = await this.cacheLeague();
    } catch (error) {
      return { ok: false, error: this.recordError(error) };
    }

    const ourMods = parsed.mods.filter(isAffixMod).map((mod) => mod.text);
    const learnedTiers = this.learnedTiers();
    let statIds: StatCatalogue | undefined;
    let statQuery: CompsQuery | undefined;
    if (baseQuery.basis === "base-type" && ourMods.length > 0) {
      statIds = await this.fetchStats();
      if (statIds) {
        const appraisal = appraiseItem(itemText, { parsed, learnedTiers, statIds });
        statQuery = buildStatFilteredQuery(parsed, appraisal, statIds);
      }
    }
    // The store is re-read at summary time: the fetch being summarized has
    // just taught it.
    const summarize = (listings: readonly CompListing[], basis: CompsQuery["basis"]): CompsSummary =>
      summarizeComps(ourMods, listings, basis, {
        priceTable: this.options.getPriceTable(),
        itemClass: parsed.itemClass,
        learnedTiers: this.learnedTiers(),
        ...(statIds ? { statIds } : {}),
        ...(basis === "stat-filtered" ? { minSimilarity: 0 } : {}),
      });
    const fromCache = (entry: CachedComps): CompsResult => ({
      ok: true,
      cached: true,
      league: entry.league,
      basis: entry.basis,
      summary: summarize(entry.listings, entry.basis),
    });
    const fresh = (entry: CachedComps | undefined): entry is CachedComps =>
      this.cacheHit(entry, league);

    const statKey = statQuery ? JSON.stringify(statQuery.body) : undefined;
    const statCached = statKey ? this.compsCache.get(statKey) : undefined;
    if (fresh(statCached) && statCached.listings.length >= STAT_STAGE_MIN_IDS) {
      return fromCache(statCached);
    }
    const baseKey = JSON.stringify(baseQuery.body);
    const baseCached = this.compsCache.get(baseKey);
    // Stage 1 still owed? Only when it has not been tried within its TTL.
    const statStagePending = statQuery !== undefined && !fresh(statCached);
    if (!statStagePending && fresh(baseCached)) return fromCache(baseCached);
    const until = this.rateLimitedUntilIso();
    if (until) {
      if (fresh(baseCached)) return fromCache(baseCached);
      return {
        ok: false,
        error: `trade2 rate limited until ${new Date(until).toLocaleTimeString()} — try again then`,
      };
    }

    try {
      const remember = (key: string, basis: CompsQuery["basis"], listings: CompListing[]) => {
        this.compsCache.set(key, { at: Date.now(), league, basis, listings });
        this.saveCompsCache();
      };
      const rateLimited: CompsResult = {
        ok: false,
        error: "trade2 rate limit hit — wait a minute and try again.",
      };
      if (statQuery && statKey && statStagePending) {
        const stage = await this.runCompsQuery(league, statQuery, parsed.itemClass, STAT_STAGE_MIN_IDS);
        if (stage.kind === "rate-limited") return rateLimited;
        remember(statKey, "stat-filtered", stage.listings);
        if (stage.listings.length >= STAT_STAGE_MIN_IDS) {
          return {
            ok: true,
            league,
            basis: "stat-filtered",
            summary: summarize(stage.listings, "stat-filtered"),
          };
        }
      }
      if (fresh(baseCached)) return fromCache(baseCached);
      const stage = await this.runCompsQuery(league, baseQuery, parsed.itemClass, 1);
      if (stage.kind === "rate-limited") return rateLimited;
      remember(baseKey, baseQuery.basis, stage.listings);
      return {
        ok: true,
        league,
        basis: baseQuery.basis,
        summary: summarize(stage.listings, baseQuery.basis),
      };
    } catch (error) {
      return { ok: false, error: this.recordError(error) };
    }
  }

  /**
   * The comps summary for this item from the in-memory/disk cache ONLY —
   * never touches the network and never waits. Price checks use it so a
   * repeat Ctrl+D prices instantly and scan-sourced evaluations stay offline.
   */
  peekComps(itemText: string): CompsSummary | undefined {
    if (!looksLikePoeItemText(itemText)) return undefined;
    // Only a league known offline counts: the pinned one, or "auto" once
    // the candidates were read. Until then nothing in the cache is a price.
    const league = this.resolvedLeague;
    if (!league) return undefined;
    const parsed = parseItemText(itemText);
    const query = buildCompsQuery(parsed);
    if (!query) return undefined;
    const ourMods = parsed.mods.filter(isAffixMod).map((mod) => mod.text);
    const learnedTiers = this.learnedTiers();
    const statIds = this.statCatalogueCache;
    const summarize = (entry: CachedComps): CompsSummary =>
      summarizeComps(ourMods, entry.listings, entry.basis, {
        priceTable: this.options.getPriceTable(),
        itemClass: parsed.itemClass,
        learnedTiers,
        ...(statIds ? { statIds } : {}),
        ...(entry.basis === "stat-filtered" ? { minSimilarity: 0 } : {}),
      });
    // The stat-filtered stage's sample first, as fetchComps serves it — but
    // only with the catalogue already in memory: a peek loads nothing.
    if (statIds && query.basis === "base-type" && ourMods.length > 0) {
      const appraisal = appraiseItem(itemText, { parsed, learnedTiers, statIds });
      const statQuery = buildStatFilteredQuery(parsed, appraisal, statIds);
      const statCached = statQuery ? this.compsCache.get(JSON.stringify(statQuery.body)) : undefined;
      if (this.cacheHit(statCached, league) && statCached.listings.length >= STAT_STAGE_MIN_IDS) {
        return summarize(statCached);
      }
    }
    const cached = this.compsCache.get(JSON.stringify(query.body));
    return this.cacheHit(cached, league) ? summarize(cached) : undefined;
  }

  // Training is deliberately cache-first and request-bounded. Feedback saves
  // receive only peekCompsResult; the explicit market button calls the fetch.
  private readonly trainingCompsInFlight = new Map<string, Promise<CachedComps>>();

  private trainingCompsContext(itemText: string) {
    let identity: ReturnType<typeof trainingIdentity>;
    try { identity = trainingIdentity(itemText); }
    catch { return undefined; }
    // Match the lesson's normalized rolls and canonical magic-jewel base;
    // advanced copy ranges and affix names must never become query values.
    const parsed = { ...identity.parsed, baseType: identity.baseType };
    const baseQuery = buildCompsQuery(parsed);
    if (!baseQuery) return undefined;
    // Cold or expired catalogues stay offline. Opening a training record must
    // never quietly request /data/stats merely to build a better query.
    const statIds = this.statCatalogueCache ?? this.catalogueFrom(this.statsPayloadCached());
    if (statIds) this.statCatalogueCache = statIds;
    const ourMods = parsed.mods.filter(isAffixMod).map((mod) => mod.text);
    const statQuery = statIds && baseQuery.basis === "base-type" && ourMods.length > 0 ?
      buildStatFilteredQuery(parsed, appraiseItem(itemText, {
        parsed, learnedTiers: this.learnedTiers(), statIds,
      }), statIds) : undefined;
    return { parsed, baseQuery, statQuery, statIds, ourMods };
  }

  private trainingCompsResult(
    context: NonNullable<ReturnType<PriceFeedService["trainingCompsContext"]>>,
    entry: CachedComps,
    cached: boolean,
  ): CompsResult {
    return {
      ok: true, cached, league: entry.league, basis: entry.basis,
      fetchedAt: new Date(entry.at).toISOString(),
      expiresAt: new Date(entry.at + compsTtl(entry.basis)).toISOString(),
      summary: summarizeComps(context.ourMods, entry.listings, entry.basis, {
        priceTable: this.options.getPriceTable(), itemClass: context.parsed.itemClass,
        learnedTiers: this.learnedTiers(), ...(context.statIds ? { statIds: context.statIds } : {}),
        ...(entry.basis === "stat-filtered" ? { minSimilarity: 0 } : {}),
      }),
    };
  }

  /** Offline raw-cache read with age/provenance, re-scored for this item's modifiers. */
  peekCompsResult(itemText: string): CompsResult | undefined {
    const league = this.resolvedLeague;
    if (!league) return undefined;
    const context = this.trainingCompsContext(itemText);
    if (!context) return undefined;
    const queries = context.statQuery ? [context.statQuery, context.baseQuery] : [context.baseQuery];
    for (const query of queries) {
      const entry = this.compsCache.get(JSON.stringify(query.body));
      if (this.cacheHit(entry, league) && Number.isFinite(entry.at) && entry.at <= Date.now()) {
        // Thin/empty samples are meaningful cache hits too; they must not cause
        // an automatic second search just because the first sample was small.
        return this.trainingCompsResult(context, entry, true);
      }
    }
    return undefined;
  }

  /**
   * Explicit training-button lookup: warm cache first, otherwise ONE search
   * and at most ONE fetch of ten listings. No cold metadata requests, query
   * widening, 429 retry, or request deferred until a pacing window opens.
   */
  async fetchTrainingComps(itemText: string): Promise<CompsResult> {
    const hit = this.peekCompsResult(itemText);
    if (hit) return hit;
    const league = this.resolvedLeague;
    if (!league) return { ok: false, error: "Pin a league in Market data before checking training examples; nothing was sent." };
    const context = this.trainingCompsContext(itemText);
    if (!context) return { ok: false, error: "Not recognizable searchable item text." };
    const query = context.statQuery ?? context.baseQuery;
    const cacheKey = JSON.stringify(query.body);
    const requestKey = `${league}\u0000${cacheKey}`;
    let pending = this.trainingCompsInFlight.get(requestKey);
    const joined = pending !== undefined;
    if (!pending) {
      const budget = this.tradeBudget();
      if (budget.restrictedUntilIso) return {
        ok: false, error: `trade2 rate limited until ${new Date(budget.restrictedUntilIso).toLocaleTimeString()} — nothing was sent.`,
      };
      if (budget.lookups < 1) return { ok: false, error: "No spare trade2 lookup right now — nothing was queued for later." };
      pending = this.fetchTrainingSample(league, query, context.parsed.itemClass);
      this.trainingCompsInFlight.set(requestKey, pending);
    }
    try {
      const sample = await pending;
      // A concurrent request may represent another roll of the same base;
      // share raw listings, never the first caller's similarity verdict.
      return this.trainingCompsResult(context, sample, joined);
    } catch (error) {
      return { ok: false, error: this.recordError(error) };
    } finally {
      if (this.trainingCompsInFlight.get(requestKey) === pending) this.trainingCompsInFlight.delete(requestKey);
    }
  }

  private async fetchTrainingSample(league: string, query: CompsQuery, itemClass: string): Promise<CachedComps> {
    const request = async (url: string, init: RequestInit): Promise<Response> => {
      const response = await this.tradeRequest(url, init, true);
      if (response.status === 429) {
        const seconds = Number(headerOf(response, "retry-after"));
        const penalty = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
        this.pacer.observe(policyForUrl(url), { retryAfter: String(penalty) });
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.pacer.restrictedUntil());
        this.savePacing();
        this.saveCompsCache();
        throw new TradeRateLimitedError("trade2 rate limit hit — this training check was not retried.", this.rateLimitedUntilIso());
      }
      if (!response.ok) throw new Error(`trade2 training check → HTTP ${response.status}`);
      return response;
    };
    const searchResponse = await request(`${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`, {
      method: "POST", body: JSON.stringify(query.body),
    });
    const search = await searchResponse.json() as { id?: unknown; result?: unknown };
    if (typeof search.id !== "string" || !search.id || !Array.isArray(search.result)) {
      throw new Error("trade2 training search returned an invalid result");
    }
    const ids = [...new Set(search.result.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 10);
    this.logTradeRequest({ kind: "search", reason: "price-training:explicit-check", league, detail: search.id });
    let listings: CompListing[] = [];
    if (ids.length) {
      const response = await request(`${TRADE_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(search.id)}`, { method: "GET" });
      const payload = await response.json();
      this.learnFromFetch(payload, itemClass);
      listings = parseCompListings(payload);
      this.logTradeRequest({ kind: "fetch", reason: "price-training:explicit-check", league, detail: ids.join(",") });
    }
    const entry: CachedComps = { at: Date.now(), league, basis: query.basis, listings };
    this.compsCache.set(JSON.stringify(query.body), entry);
    this.saveCompsCache();
    return entry;
  }

  // -------------------------------------------------------------------------
  // Generic trade2 plumbing (Market, Evaluate, live search) — same pacer,
  // same cookie, same league resolution and 429 memory as the comps above.
  // Errors are thrown (AmbiguousLeagueError, TradeRateLimitedError, Error):
  // the callers are feature modules that surface them per request.
  // -------------------------------------------------------------------------

  private readonly genericSearchCache = new Map<
    string,
    { at: number; ttl: number; result: TradeSearchResult }
  >();
  private readonly tradeRequestLog: TradeRequestLogEntry[] = [];

  /** Whether a POESESSID is configured (live search and secure-listing whispers need one). */
  hasSession(): boolean {
    return this.config.poesessid.length > 0;
  }

  /**
   * The headers a non-fetch trade2 connection (the live-search websocket)
   * must carry: the app's User-Agent and, when configured, the session
   * cookie. Main-process only — never send this to a renderer.
   */
  tradeHeaders(): Record<string, string> {
    return {
      "User-Agent": USER_AGENT,
      ...(this.config.poesessid ? { Cookie: `POESESSID=${this.config.poesessid}` } : {}),
    };
  }

  /** The most recent generic trade2 requests, newest last (diagnostics). */
  tradeRequestHistory(): TradeRequestLogEntry[] {
    return this.tradeRequestLog.map((entry) => ({ ...entry }));
  }

  private logTradeRequest(entry: Omit<TradeRequestLogEntry, "at">): void {
    this.tradeRequestLog.push({ at: this.now().toISOString(), ...entry });
    if (this.tradeRequestLog.length > TRADE_LOG_MAX) this.tradeRequestLog.splice(0, this.tradeRequestLog.length - TRADE_LOG_MAX);
  }

  /** The league for a generic request: the caller's, else the resolved one. */
  private async leagueFor(league: string | undefined): Promise<string> {
    const pinned = typeof league === "string" ? league.trim() : "";
    if (pinned) return pinned;
    try {
      return await this.cacheLeague();
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  private refuseIfRateLimited(): void {
    const until = this.rateLimitedUntilIso();
    if (until) {
      throw new TradeRateLimitedError(
        `trade2 rate limited until ${new Date(until).toLocaleTimeString()} — try again then`,
        until,
      );
    }
  }

  private rateLimitHit(): TradeRateLimitedError {
    return new TradeRateLimitedError(
      "trade2 rate limit hit — wait a minute and try again.",
      this.rateLimitedUntilIso(),
    );
  }

  /** The `{ error: { message } }` envelope trade2 puts on 4xx answers, when present. */
  private async errorMessageOf(response: Response): Promise<string | undefined> {
    try {
      const payload = (await response.json()) as { error?: { message?: unknown } };
      const message = payload?.error?.message;
      return typeof message === "string" && message.trim() ? message.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private pruneGenericSearchCache(now: number): void {
    for (const [key, entry] of this.genericSearchCache) {
      if (now - entry.at >= entry.ttl) this.genericSearchCache.delete(key);
    }
    while (this.genericSearchCache.size > GENERIC_SEARCH_CACHE_MAX) {
      const oldest = this.genericSearchCache.keys().next().value;
      if (oldest === undefined) break;
      this.genericSearchCache.delete(oldest);
    }
  }

  /**
   * One paced POST of an arbitrary search body. The answer (ids, total) is
   * cached by league + canonical body for `cacheTtlMs` (60 s by default —
   * a UI that re-renders must not re-search) and served from that cache
   * even inside a penalty window. A "too complex" refusal is reported on
   * the result rather than thrown: the query needs editing, not a retry.
   */
  async tradeSearch(
    body: Record<string, unknown>,
    opts: { reason: string; league?: string; cacheTtlMs?: number },
  ): Promise<TradeSearchResult> {
    const league = await this.leagueFor(opts.league);
    let canonical: string;
    try {
      canonical = stableTradeQueryJson(body);
    } catch (error) {
      throw new Error(`trade2 search body rejected: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const key = `${league}\u0000${canonical}`;
    const now = Date.now();
    this.pruneGenericSearchCache(now);
    const ttl = Math.max(0, opts.cacheTtlMs ?? GENERIC_SEARCH_CACHE_MS);
    const hit = this.genericSearchCache.get(key);
    if (hit) {
      // A caller that can live with older ids (a watch, a favourite) keeps
      // the entry alive for its own TTL; a shorter one never cuts it.
      hit.ttl = Math.max(hit.ttl, ttl);
      return { ...hit.result, resultIds: [...hit.result.resultIds], cached: true };
    }
    this.refuseIfRateLimited();
    const response = await this.tradeRequestWithBackoff(
      `${TRADE_BASE}/search/poe2/${encodeURIComponent(league)}`,
      { method: "POST", body: canonical },
    );
    if (response.status === 429) throw this.rateLimitHit();
    if (!response.ok) {
      const message = await this.errorMessageOf(response);
      if (response.status === 400 && message && /complex/i.test(message)) {
        this.logTradeRequest({ kind: "search", reason: opts.reason, league, detail: "too complex" });
        return { id: "", total: 0, resultIds: [], league, url: "", cached: false, complexityError: message };
      }
      throw new Error(`trade2 search → HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    const payload = (await response.json()) as { id?: unknown; result?: unknown; total?: unknown };
    const id = typeof payload.id === "string" ? payload.id : "";
    const resultIds = Array.isArray(payload.result)
      ? payload.result.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total)
        ? Math.max(0, Math.floor(payload.total))
        : resultIds.length;
    if (!id) throw new Error("trade2 search returned no search id");
    const result: TradeSearchResult = {
      id,
      total,
      resultIds,
      league,
      url: tradeSearchUrl(league, id),
      cached: false,
    };
    if (ttl > 0) {
      this.genericSearchCache.set(key, { at: Date.now(), ttl, result: { ...result, resultIds: [...resultIds] } });
    }
    this.logTradeRequest({ kind: "search", reason: opts.reason, league, detail: id });
    return result;
  }

  /**
   * Re-open an existing search by its id: GET
   * /api/trade2/search/poe2/{league}/{id}, which answers like a fresh
   * search (`{ id, result, total }`) and — the reason to call it — carries
   * the `query` the id stands for, so a pasted trade2 URL can be turned
   * back into an editable query. Search-policy paced, never cached (the id
   * is the cache), a penalty window refuses it offline.
   *
   * UNVERIFIED (2026-09-14): this endpoint has not been exercised against
   * the live site yet. Callers must treat a thrown error or a missing
   * `query` as "id-only" and keep their own fallback until the first live
   * check passes.
   */
  async tradeSearchById(
    league: string,
    searchId: string,
    opts: { reason: string },
  ): Promise<TradeSearchResult & { query?: unknown }> {
    const id = typeof searchId === "string" ? searchId.trim() : "";
    if (!id) throw new Error("trade2 search id is required");
    const resolved = await this.leagueFor(league);
    this.refuseIfRateLimited();
    const response = await this.tradeRequestWithBackoff(
      `${TRADE_BASE}/search/poe2/${encodeURIComponent(resolved)}/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
    if (response.status === 429) throw this.rateLimitHit();
    if (!response.ok) {
      const message = await this.errorMessageOf(response);
      throw new Error(`trade2 search → HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    const payload = (await response.json()) as {
      id?: unknown;
      result?: unknown;
      total?: unknown;
      query?: unknown;
    };
    // Tolerant on purpose: the shape is unconfirmed, and an id that comes
    // back without a result list is still a usable search id.
    const answeredId = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : id;
    const resultIds = Array.isArray(payload.result)
      ? payload.result.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total)
        ? Math.max(0, Math.floor(payload.total))
        : resultIds.length;
    this.logTradeRequest({ kind: "search", reason: opts.reason, league: resolved, detail: answeredId });
    return {
      id: answeredId,
      total,
      resultIds,
      league: resolved,
      url: tradeSearchUrl(resolved, answeredId),
      cached: false,
      ...(payload.query !== undefined ? { query: payload.query } : {}),
    };
  }

  /**
   * Fetch listings for `ids` in order, at most ten per GET (as the site
   * does), each GET paced. Every fetch also teaches the learned-tier store.
   * Nothing is cached here: callers hold the rows they asked for.
   */
  async tradeFetch(
    ids: string[],
    queryId: string,
    opts: { reason: string; keepRaw?: boolean },
  ): Promise<TradeListing[]> {
    const wanted: string[] = [];
    for (const id of ids) {
      const trimmed = typeof id === "string" ? id.trim() : "";
      if (trimmed && !wanted.includes(trimmed)) wanted.push(trimmed);
    }
    if (wanted.length === 0) return [];
    if (!queryId || !queryId.trim()) throw new Error("trade2 fetch needs the search id");
    const league = this.resolvedLeague ?? (this.config.league !== "auto" ? this.config.league : "");
    const listings: TradeListing[] = [];
    for (let start = 0; start < wanted.length; start += TRADE_FETCH_BATCH) {
      const batch = wanted.slice(start, start + TRADE_FETCH_BATCH);
      this.refuseIfRateLimited();
      const response = await this.tradeRequestWithBackoff(
        `${TRADE_BASE}/fetch/${batch.join(",")}?query=${encodeURIComponent(queryId.trim())}`,
        { method: "GET" },
      );
      if (response.status === 429) throw this.rateLimitHit();
      if (!response.ok) {
        const message = await this.errorMessageOf(response);
        throw new Error(`trade2 fetch → HTTP ${response.status}${message ? `: ${message}` : ""}`);
      }
      const payload = await response.json();
      this.learnFromFetch(payload, undefined);
      listings.push(
        ...parseTradeListings(payload, league, {
          priceTable: this.options.getPriceTable(),
          ...(opts.keepRaw ? { keepRaw: true } : {}),
        }),
      );
      this.logTradeRequest({ kind: "fetch", reason: opts.reason, league, detail: batch.join(",") });
    }
    return listings;
  }

  /**
   * One paced POST to the bulk exchange (search policy: the API counts it
   * with searches). Uncached — exchange stock moves by the minute.
   */
  async tradeExchange(
    body: Record<string, unknown>,
    opts: { reason: string; league?: string },
  ): Promise<TradeExchangeResult> {
    const league = await this.leagueFor(opts.league);
    this.refuseIfRateLimited();
    const response = await this.tradeRequestWithBackoff(
      `${TRADE_BASE}/exchange/poe2/${encodeURIComponent(league)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (response.status === 429) throw this.rateLimitHit();
    if (!response.ok) {
      const message = await this.errorMessageOf(response);
      throw new Error(`trade2 exchange → HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    const parsed = parseExchangeResult(await response.json(), league);
    this.logTradeRequest({ kind: "exchange", reason: opts.reason, league, detail: parsed.id });
    return { ...parsed, league, url: parsed.id ? exchangeUrl(league, parsed.id) : "" };
  }
}
