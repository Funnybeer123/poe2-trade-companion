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
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import type { PriceTable } from "../core/priceTable.js";

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
}

export interface CompsResult {
  ok: boolean;
  summary?: CompsSummary;
  error?: string;
  cached?: boolean;
  league?: string;
  /** Which search stage produced the summary (stat-filtered beats base-type). */
  basis?: CompsQuery["basis"];
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
    this.syncResolvedLeague();
    this.pacer = new TradePacer(this.loadPacing());
    this.loadCompsCache();
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

  // ---- stats catalogue + learned tiers (lazy: nothing loads until a lookup) --

  private statCatalogue: StatCatalogue | undefined;
  private statsFailedAt = 0;
  private statWarningLogged = false;
  private learnedTiersStore: LearnedTiers | undefined;

  private statsFile(): string {
    return path.join(this.options.configDir, TRADE_STATS_FILE);
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
    if (this.statCatalogue) return this.statCatalogue;
    let stale: StatCatalogue | undefined;
    try {
      const file = this.statsFile();
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown; payload?: unknown };
        const catalogue = this.catalogueFrom(parsed.payload);
        if (catalogue && typeof parsed.at === "number" && Date.now() - parsed.at < STATS_CACHE_MS) {
          this.statCatalogue = catalogue;
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
      try {
        mkdirSync(this.options.configDir, { recursive: true });
        writeFileSync(this.statsFile(), JSON.stringify({ at: Date.now(), payload }));
      } catch {
        // Best effort; the in-memory catalogue serves this process.
      }
      this.statCatalogue = catalogue;
      return catalogue;
    } catch {
      this.statsFailedAt = Date.now();
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

    const ourMods = parsed.mods.filter((mod) => !mod.implicit).map((mod) => mod.text);
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
      entry !== undefined && Date.now() - entry.at < compsTtl(entry.basis);

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
      const league = await this.resolveLeague();
      this.resolvedLeague = league;
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
    const parsed = parseItemText(itemText);
    const query = buildCompsQuery(parsed);
    if (!query) return undefined;
    const cached = this.compsCache.get(JSON.stringify(query.body));
    if (!cached || Date.now() - cached.at >= compsTtl(cached.basis)) return undefined;
    const ourMods = parsed.mods.filter((mod) => !mod.implicit).map((mod) => mod.text);
    return summarizeComps(ourMods, cached.listings, query.basis, {
      priceTable: this.options.getPriceTable(),
      itemClass: parsed.itemClass,
    });
  }
}
