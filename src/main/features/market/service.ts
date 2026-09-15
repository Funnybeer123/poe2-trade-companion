/**
 * MarketService — the in-app trade browser's main-process half.
 *
 * It owns the tab sessions, the favourites tree, the live searches and
 * every trade2 request Market makes. Electron-free on purpose: everything
 * it touches (the feed, the live-search service, chat, the clock, the
 * filesystem, the clipboard) is injected, so the whole flow is testable
 * offline.
 *
 * Safety rules this file enforces (compliance review §2):
 *  - one chat line per click, only through ChatCommandService; Market never
 *    starts an input host, never types, never clicks, never buys;
 *  - no trade2 traffic inside a penalty window, and a search needs one
 *    spare search AND one spare fetch; paging keeps `minSpareFetches` back
 *    for Evaluate/Deals/the shop CLI;
 *  - live-search rows are fetched by the foundation under the same budget
 *    guard, and the skipped count is surfaced rather than retried;
 *  - no polling, no auto-refresh, no bulk scan of favourites.
 */
import { lookupPrice, type PriceTable } from "../../../core/priceTable.js";
import type { StatCatalogue } from "../../../core/statIds.js";
import {
  TRADE_CURRENCY_NAMES,
  currencyRateInExalted,
  type ExchangeOffer,
  type TradeListing,
} from "../../../core/tradeListings.js";
import { exchangeUrl, tradeSearchUrl, type TradeStatGroup } from "../../../core/tradeQuery.js";
import { sanitizeChatText } from "../../../core/chatCommands.js";
import {
  draftBody,
  draftFingerprint,
  defaultColour,
  defaultTabLabel,
  emptyExchangeDraft,
  emptySearchDraft,
  sanitizeDraft,
  type MarketDraft,
} from "../../../core/marketQuery.js";
import {
  favoritesTree,
  moveFavorite,
  moveFolder,
  normalizeMarketFavorites,
  parseMarketFavorites,
  removeFavorite,
  removeFolder,
  saveFavorite,
  saveFolder,
  serializeMarketFavorites,
  type MarketFavorite,
  type MarketFavoritesFile,
} from "../../../core/marketFavorites.js";
import {
  MARKET_PAGE_SIZE,
  MAX_LIVE_RESULTS,
  MAX_MARKET_TABS,
  appendPage,
  applyExchange,
  applySearch,
  closeTab,
  collapseAccount,
  isSearchResult,
  markError,
  markSearching,
  nextPageIds,
  normalizePersistedTabs,
  openTab,
  persistedTabs,
  renameTab,
  tabsFromPersisted,
  touchTab,
  updateDraft,
  type MarketTab,
} from "../../../core/marketTabs.js";
import {
  collapseBySeller,
  hideoutCommand,
  offerWhisperText,
  statFiltersFromListing,
  whisperText,
} from "../../../core/marketListing.js";
import { exchangeCurrencyOptions, type ExchangeCurrencyOption } from "../../../core/marketExchange.js";
import { importMarketText, type MarketImportResult } from "../../../core/marketImport.js";
import { priceNote } from "../../../core/tradeListings.js";
import { normalizeStatText } from "../../../core/statIds.js";
import type { MarketSettings } from "../../../core/marketSettings.js";
import type { ChatCommandOutcome, ChatCommandRequest } from "../../../shared/chatCommands.js";
import type { LiveSearchHandle } from "../../../shared/liveSearch.js";
import type {
  MarketActionOutcome,
  MarketBudgetView,
  MarketCurrencyRate,
  MarketFavoriteSaveInput,
  MarketListingActionInput,
  MarketLiveDefinition,
  MarketLiveFile,
  MarketLiveStartInput,
  MarketLiveView,
  MarketOpenTabOptions,
  MarketStateView,
  MarketTabSummary,
  MarketTabView,
  WeightTemplateView,
} from "../../../shared/market.js";
import {
  MARKET_FAVORITES_FILE,
  MARKET_LIVE_FILE,
  MARKET_TABS_FILE,
  marketFilePath,
  readJsonFile,
  realMarketFs,
  writeJsonFile,
  type MarketFs,
} from "./files.js";
import { createStatsSource, type MarketStatsFeed, type StatsSource } from "./statsSource.js";

// ---------------------------------------------------------------------------
// Injected surfaces
// ---------------------------------------------------------------------------

export interface MarketSearchAnswer {
  id: string;
  total: number;
  resultIds: string[];
  league: string;
  url: string;
  cached: boolean;
  complexityError?: string;
}

export interface MarketExchangeAnswer {
  id: string;
  total: number;
  offers: ExchangeOffer[];
  league: string;
  url: string;
}

/** The slice of PriceFeedService Market uses (structural, so tests fake it). */
export interface MarketFeed extends MarketStatsFeed {
  tradeSearch(
    body: Record<string, unknown>,
    opts: { reason: string; league?: string; cacheTtlMs?: number },
  ): Promise<MarketSearchAnswer>;
  tradeFetch(ids: string[], queryId: string, opts: { reason: string }): Promise<TradeListing[]>;
  tradeExchange(body: Record<string, unknown>, opts: { reason: string; league?: string }): Promise<MarketExchangeAnswer>;
  tradeBudget(): MarketBudgetView;
  hasSession(): boolean;
  status(): { resolvedLeague?: string; leagueAmbiguous: boolean; feedAgeHours?: number };
  statCatalogue?(types?: readonly string[]): Promise<StatCatalogue | undefined>;
  fetchStatic?(): Promise<unknown | undefined>;
  tradeSearchById?(
    league: string,
    searchId: string,
    opts: { reason: string },
  ): Promise<MarketSearchAnswer & { query?: unknown }>;
}

export interface MarketLiveSearchLike {
  start(
    input: { searchId: string; league: string; label: string },
    handlers: { onListing(listing: TradeListing): void; onState(handle: LiveSearchHandle): void },
  ): LiveSearchHandle;
  stop(id: string): void;
  list(): LiveSearchHandle[];
  capacity(): { open: number; max: number };
}

export interface MarketChatLike {
  send(request: ChatCommandRequest): Promise<ChatCommandOutcome>;
}

export interface MarketServiceDeps {
  userDataDir: string;
  feed: MarketFeed;
  liveSearch: MarketLiveSearchLike;
  chat: MarketChatLike;
  settings(): MarketSettings;
  priceTable(): PriceTable;
  clipboard: { writeText(text: string): void };
  notify(title: string, body: string): void;
  openExternal(url: string): Promise<void>;
  emit(channel: string, payload: unknown): void;
  /** The curated data files (`src/data/market/*.json`), already parsed. */
  data?: { exchangeCurrencies?: unknown; weightTemplates?: unknown };
  now?: () => Date;
  fs?: MarketFs;
  dryRun?: () => boolean;
  /** An overlay toast for live hits when the overlay service is present. */
  overlayNotice?: (title: string, body: string) => void;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

interface LiveEntry {
  id: string;
  handle: LiveSearchHandle;
  label: string;
  favoriteId?: string;
  tabId?: string;
  sound: boolean;
  notify: boolean;
  results: TradeListing[];
  lastResultAt?: string;
  unread: number;
  startedAt: string;
}

const STAT_SLACK = 0.9;

export class MarketService {
  private tabs: MarketTab[] = [];
  private activeTabId: string | undefined;
  private favorites: MarketFavoritesFile;
  private live: LiveEntry[] = [];
  private readonly stats: StatsSource;
  private readonly fs: MarketFs;
  private readonly issues: string[] = [];
  private lastError: string | undefined;
  private currencies: ExchangeCurrencyOption[] | undefined;
  /** Memo for `currencyRates()`, keyed on the price table it was built from. */
  private ratesCache: { table: PriceTable; size: number; rows: MarketCurrencyRate[] } | undefined;
  private disposed = false;

  constructor(private readonly deps: MarketServiceDeps) {
    this.fs = deps.fs ?? realMarketFs;
    this.stats = createStatsSource(deps.feed);
    // Read through the sanitizer itself, not `parseMarketFavorites`, so a
    // hand-edited file that lost a favourite says so on the settings card
    // instead of quietly coming back shorter.
    const favorites = readJsonFile(this.fs, this.file(MARKET_FAVORITES_FILE), (text) => {
      if (!text) return { value: parseMarketFavorites(undefined), issues: [] as string[] };
      try {
        return normalizeMarketFavorites(JSON.parse(text));
      } catch {
        return {
          value: parseMarketFavorites(undefined),
          issues: ["market-favorites.json was not readable JSON; the list started empty"],
        };
      }
    });
    this.favorites = favorites.value;
    this.issues.push(...favorites.issues);
    const rawTabs = readJsonFile(this.fs, this.file(MARKET_TABS_FILE), (text) => {
      if (!text) return { value: { schemaVersion: 1 as const, tabs: [] }, issues: [] };
      try {
        return normalizePersistedTabs(JSON.parse(text));
      } catch {
        return { value: { schemaVersion: 1 as const, tabs: [] }, issues: ["market-tabs.json was not readable JSON"] };
      }
    });
    this.issues.push(...rawTabs.issues);
    this.tabs = tabsFromPersisted(rawTabs.value, this.nowIso());
    this.activeTabId = rawTabs.value.activeTabId ?? this.tabs[0]?.id;
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private file(name: string): string {
    return marketFilePath(this.deps.userDataDir, name);
  }

  private log(level: "info" | "warn" | "error", message: string, detail?: unknown): void {
    this.deps.log?.(level, message, detail);
  }

  private tabById(id: string): MarketTab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  private favoriteById(id: string): MarketFavorite | undefined {
    return this.favorites.favorites.find((favorite) => favorite.id === id);
  }

  private persistTabs(): void {
    const error = writeJsonFile(
      this.fs,
      this.file(MARKET_TABS_FILE),
      `${JSON.stringify(persistedTabs(this.tabs, this.activeTabId), null, 2)}\n`,
    );
    if (error) this.log("warn", "market-tabs.json could not be written", error);
  }

  private persistFavorites(): void {
    const error = writeJsonFile(this.fs, this.file(MARKET_FAVORITES_FILE), serializeMarketFavorites(this.favorites));
    if (error) this.log("warn", "market-favorites.json could not be written", error);
  }

  private persistLive(): void {
    const file: MarketLiveFile = {
      schemaVersion: 1,
      searches: this.live.map((entry) => ({
        id: entry.id,
        searchId: entry.handle.searchId,
        league: entry.handle.league,
        label: entry.label,
        ...(entry.favoriteId ? { favoriteId: entry.favoriteId } : {}),
        sound: entry.sound,
        notify: entry.notify,
      })),
    };
    const error = writeJsonFile(this.fs, this.file(MARKET_LIVE_FILE), `${JSON.stringify(file, null, 2)}\n`);
    if (error) this.log("warn", "market-live-searches.json could not be written", error);
  }

  private announce(): MarketStateView {
    const view = this.state();
    this.deps.emit("market:state", view);
    return view;
  }

  private announceTab(id: string): MarketTabView | undefined {
    const tab = this.tabById(id);
    if (tab) this.deps.emit("market:tab", tab);
    this.deps.emit("market:state", this.state());
    return tab;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private summarize(tab: MarketTab): MarketTabSummary {
    const searchResult = isSearchResult(tab.result) ? tab.result : undefined;
    const exchangeResult = !searchResult && tab.result ? tab.result : undefined;
    return {
      id: tab.id,
      kind: tab.kind,
      label: tab.label,
      colour: tab.colour,
      ...(tab.favoriteId ? { favoriteId: tab.favoriteId } : {}),
      temporary: tab.temporary,
      dirty: tab.dirty,
      state: tab.state,
      ...(tab.error ? { error: tab.error } : {}),
      ...(searchResult
        ? {
            resultCount: searchResult.listings.length,
            total: searchResult.total,
            remaining: Math.max(0, searchResult.resultIds.length - searchResult.nextOffset),
          }
        : {}),
      ...(exchangeResult && "offers" in exchangeResult
        ? { resultCount: exchangeResult.offers.length, total: exchangeResult.total }
        : {}),
      ...(tab.idOnly ? { idOnly: true } : {}),
      lastUsedAt: tab.lastUsedAt,
    };
  }

  private liveView(entry: LiveEntry): MarketLiveView {
    return {
      id: entry.id,
      handle: entry.handle,
      label: entry.label,
      ...(entry.favoriteId ? { favoriteId: entry.favoriteId } : {}),
      ...(entry.tabId ? { tabId: entry.tabId } : {}),
      sound: entry.sound,
      notify: entry.notify,
      results: entry.results,
      ...(entry.lastResultAt ? { lastResultAt: entry.lastResultAt } : {}),
      unread: entry.unread,
      startedAt: entry.startedAt,
    };
  }

  state(): MarketStateView {
    const status = this.deps.feed.status();
    const budget = this.safeBudget();
    return {
      tabs: this.tabs.map((tab) => this.summarize(tab)),
      ...(this.activeTabId ? { activeTabId: this.activeTabId } : {}),
      favorites: this.favorites,
      live: this.live.map((entry) => this.liveView(entry)),
      liveCapacity: this.deps.liveSearch.capacity(),
      budget,
      ...(status.resolvedLeague ? { league: status.resolvedLeague } : {}),
      leagueAmbiguous: status.leagueAmbiguous === true,
      hasSession: this.deps.feed.hasSession(),
      statsReady: this.stats.ready(),
      settings: this.deps.settings(),
      currencyRates: this.currencyRates(),
      ...(typeof status.feedAgeHours === "number" ? { feedAgeHours: status.feedAgeHours } : {}),
      fileIssues: [...this.issues],
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  tab(id: string): MarketTabView | undefined {
    return this.tabById(id);
  }

  /**
   * The rates behind every "≈ … ex" the rows show, so the renderer can
   * rebuild a minimal price table and use the same F4 helpers main does.
   * `fromTable` false means the crafting engine's documented default, which
   * the UI labels "refresh market prices".
   */
  private currencyRates(): MarketCurrencyRate[] {
    let table: PriceTable;
    try {
      table = this.deps.priceTable();
    } catch {
      return [];
    }
    // `announce()` runs once per live-search listing, and this walks every
    // known currency through the price table: memoise on the table's own
    // identity (the feed hands out a new object when it refreshes).
    if (this.ratesCache && this.ratesCache.table === table && this.ratesCache.size === table.entries.length) {
      return this.ratesCache.rows;
    }
    const rows: MarketCurrencyRate[] = [];
    for (const [id, name] of Object.entries(TRADE_CURRENCY_NAMES)) {
      const exalted = currencyRateInExalted(id, table);
      if (exalted === undefined) continue;
      const hit = lookupPrice(table, { name });
      rows.push({
        id,
        name,
        exalted,
        fromTable: Boolean(hit && hit.entry.match.name !== undefined && hit.value > 0),
      });
    }
    this.ratesCache = { table, size: table.entries.length, rows };
    return rows;
  }

  private safeBudget(): MarketBudgetView {
    try {
      return this.deps.feed.tradeBudget();
    } catch {
      return { lookups: 0, searchesSpare: 0, fetchesSpare: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  openTab(rawDraft: unknown, opts: MarketOpenTabOptions = {}): MarketStateView {
    const draft = sanitizeDraft(rawDraft) ?? emptySearchDraft(this.deps.settings());
    return this.openDraft(draft, opts);
  }

  private openDraft(draft: MarketDraft, opts: MarketOpenTabOptions = {}, idOnly?: { searchId: string; league: string }): MarketStateView {
    const result = openTab(
      this.tabs,
      {
        draft,
        label: opts.label ?? defaultTabLabel(draft),
        colour: opts.colour ?? defaultColour(draft),
        ...(opts.favoriteId ? { favoriteId: opts.favoriteId } : {}),
        ...(opts.temporary !== undefined ? { temporary: opts.temporary } : {}),
        ...(idOnly ? { idOnly } : {}),
      },
      this.nowIso(),
    );
    if (result.refused) {
      this.lastError = `Close a tab first — ${MAX_MARKET_TABS} are kept alive.`;
      return this.announce();
    }
    this.lastError = undefined;
    this.tabs = result.tabs;
    if (opts.select !== false) this.activeTabId = result.tab.id;
    this.persistTabs();
    return this.announce();
  }

  newSearchTab(): MarketStateView {
    return this.openDraft(emptySearchDraft(this.deps.settings()));
  }

  newExchangeTab(): MarketStateView {
    return this.openDraft(emptyExchangeDraft());
  }

  closeTab(id: string): MarketStateView {
    this.tabs = closeTab(this.tabs, id);
    if (this.activeTabId === id) this.activeTabId = this.tabs[this.tabs.length - 1]?.id;
    this.persistTabs();
    return this.announce();
  }

  selectTab(id: string): MarketStateView {
    if (this.tabById(id)) {
      this.activeTabId = id;
      this.tabs = touchTab(this.tabs, id, this.nowIso());
      this.persistTabs();
    }
    return this.announce();
  }

  updateDraft(id: string, rawDraft: unknown): MarketTabView | undefined {
    const tab = this.tabById(id);
    if (!tab) return undefined;
    const draft = sanitizeDraft(rawDraft);
    if (!draft) return tab;
    const favorite = tab.favoriteId ? this.favoriteById(tab.favoriteId) : undefined;
    this.tabs = updateDraft(this.tabs, id, draft, favorite ? draftFingerprint(favorite.draft) : undefined);
    this.persistTabs();
    return this.announceTab(id);
  }

  renameTab(id: string, label: string, colour?: string): MarketStateView {
    this.tabs = renameTab(this.tabs, id, label, colour);
    this.persistTabs();
    return this.announce();
  }

  // -------------------------------------------------------------------------
  // Searching
  // -------------------------------------------------------------------------

  /** Why a trade2 request must not go out right now, or undefined. */
  private refuseNetwork(kind: "search" | "page" | "exchange"): string | undefined {
    const status = this.deps.feed.status();
    if (status.leagueAmbiguous) {
      return "Two current leagues are live — pick one in Tools → Settings → Market data before searching.";
    }
    const budget = this.safeBudget();
    if (budget.restrictedUntilIso) {
      return `trade2 asked us to wait until ${new Date(budget.restrictedUntilIso).toLocaleTimeString()}.`;
    }
    const settings = this.deps.settings();
    if (kind === "search") {
      if (budget.searchesSpare < 1 || budget.fetchesSpare < 1) {
        return "trade2 budget spent — wait for a slot before searching again.";
      }
    } else if (kind === "exchange") {
      if (budget.searchesSpare < 1) return "trade2 budget spent — wait for a search slot.";
    } else if (budget.fetchesSpare < Math.max(1, settings.minSpareFetches)) {
      return `Only ${budget.fetchesSpare} fetch slot(s) spare — Market keeps ${settings.minSpareFetches} back for price checks.`;
    }
    return undefined;
  }

  /**
   * Write the Market defaults into the tab's own draft before a search, so
   * the query on screen IS the query that goes out. Filling them in only at
   * request time made the builder show a blank seller status while the body
   * carried "online" — a quiet disagreement between the two.
   *
   * Not an edit: the tab keeps its dirty flag and its favourite link.
   */
  private adoptDefaults(id: string, tab: MarketTab): MarketDraft {
    const effective = this.applyDefaults(tab.draft);
    if (draftFingerprint(effective) === draftFingerprint(tab.draft)) return tab.draft;
    this.tabs = this.tabs.map((entry) => (entry.id === id ? { ...entry, draft: effective } : entry));
    this.persistTabs();
    return effective;
  }

  /** Fill the blanks a new tab inherits from the Market defaults. */
  private applyDefaults(draft: MarketDraft): MarketDraft {
    if (draft.kind !== "search") return draft;
    const settings = this.deps.settings();
    const query = { ...draft.query };
    if (!query.status) query.status = settings.defaultStatus;
    const trade = { ...(query.trade ?? {}) };
    if (!trade.sale_type && settings.defaultSaleType !== "any") trade.sale_type = settings.defaultSaleType;
    if (trade.price && !trade.price.option && settings.defaultCurrency) {
      trade.price = { ...trade.price, option: settings.defaultCurrency };
    }
    if (Object.keys(trade).length > 0) query.trade = trade;
    return { kind: "search", query };
  }

  async search(id: string): Promise<MarketTabView | undefined> {
    const tab = this.tabById(id);
    if (!tab) return undefined;
    if (tab.kind !== "search") return this.exchange(id);
    if (tab.state === "searching" || tab.state === "fetching") return tab;
    if (tab.idOnly && !this.deps.feed.tradeSearchById) {
      this.tabs = markError(
        this.tabs,
        id,
        "This tab only carries a search id — open it on the trade site, or start a live search from it.",
      );
      return this.announceTab(id);
    }

    const refusal = this.refuseNetwork("search");
    if (refusal) {
      this.tabs = markError(this.tabs, id, refusal);
      return this.announceTab(id);
    }

    const body = tab.idOnly ? undefined : draftBody(this.adoptDefaults(id, tab));
    this.tabs = markSearching(this.tabs, id);
    this.deps.emit("market:tab", this.tabById(id)!);
    const reason = `market search ${tab.label}`;
    try {
      // An id-only tab (a share link from the trade site) has no editable
      // body: re-posting one would search for something else entirely. Ask
      // the site for that saved search instead — one search slot, same as a
      // normal search. The endpoint is UNVERIFIED live, so a failure leaves
      // the tab id-only with the error on screen rather than guessing.
      const answer = tab.idOnly && this.deps.feed.tradeSearchById
        ? await this.deps.feed.tradeSearchById(tab.idOnly.league, tab.idOnly.searchId, { reason })
        : await this.deps.feed.tradeSearch(body ?? draftBody(tab.draft), {
            reason,
            cacheTtlMs: 60_000,
          });
      if (this.disposed) return this.tabById(id);
      if (answer.complexityError) {
        this.tabs = markError(
          this.tabs,
          id,
          `trade2 refused this query as too complex — remove a weighted group, or set a POESESSID in Tools → Settings.`,
        );
        return this.announceTab(id);
      }
      const firstIds = answer.resultIds.slice(0, MARKET_PAGE_SIZE);
      const listings = firstIds.length > 0 ? await this.deps.feed.tradeFetch(firstIds, answer.id, { reason }) : [];
      if (this.disposed) return this.tabById(id);
      this.tabs = applySearch(
        this.tabs,
        id,
        {
          searchId: answer.id,
          league: answer.league,
          url: answer.url || (answer.id ? tradeSearchUrl(answer.league, answer.id) : ""),
          total: answer.total,
          resultIds: answer.resultIds,
          fetchedAt: this.nowIso(),
          cached: answer.cached,
        },
        listings,
        this.nowIso(),
        firstIds.length,
      );
      this.persistTabs();
      return this.announceTab(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tabs = markError(this.tabs, id, message);
      return this.announceTab(id);
    }
  }

  async loadMore(id: string): Promise<MarketTabView | undefined> {
    const tab = this.tabById(id);
    if (!tab || !isSearchResult(tab.result)) return tab;
    const ids = nextPageIds(tab);
    if (ids.length === 0) return tab;
    const refusal = this.refuseNetwork("page");
    if (refusal) {
      this.tabs = markError(this.tabs, id, refusal);
      return this.announceTab(id);
    }
    this.tabs = this.tabs.map((entry) => (entry.id === id ? { ...entry, state: "fetching" as const } : entry));
    this.deps.emit("market:tab", this.tabById(id)!);
    try {
      const page = await this.deps.feed.tradeFetch(ids, tab.result.searchId, { reason: `market page ${tab.label}` });
      if (this.disposed) return this.tabById(id);
      // The offset moves by the ids we asked for, not the rows that came
      // back: a sold listing answers with nothing, and re-requesting its id
      // would burn a fetch slot on every click.
      this.tabs = appendPage(this.tabs, id, page, ids.length);
      return this.announceTab(id);
    } catch (error) {
      this.tabs = markError(this.tabs, id, error instanceof Error ? error.message : String(error));
      return this.announceTab(id);
    }
  }

  async exchange(id: string): Promise<MarketTabView | undefined> {
    const tab = this.tabById(id);
    if (!tab) return undefined;
    if (tab.draft.kind !== "exchange") return tab;
    if (tab.state === "searching") return tab;
    const refusal = this.refuseNetwork("exchange");
    if (refusal) {
      this.tabs = markError(this.tabs, id, refusal);
      return this.announceTab(id);
    }
    this.tabs = markSearching(this.tabs, id);
    this.deps.emit("market:tab", this.tabById(id)!);
    try {
      const answer = await this.deps.feed.tradeExchange(draftBody(tab.draft), { reason: `market exchange ${tab.label}` });
      if (this.disposed) return this.tabById(id);
      this.tabs = applyExchange(
        this.tabs,
        id,
        {
          searchId: answer.id,
          league: answer.league,
          url: answer.url || (answer.id ? exchangeUrl(answer.league, answer.id) : ""),
          total: answer.total,
          offers: answer.offers,
          fetchedAt: this.nowIso(),
        },
        this.nowIso(),
      );
      this.persistTabs();
      return this.announceTab(id);
    } catch (error) {
      this.tabs = markError(this.tabs, id, error instanceof Error ? error.message : String(error));
      return this.announceTab(id);
    }
  }

  collapseAccount(id: string, account: string, collapsed: boolean): MarketTabView | undefined {
    this.tabs = collapseAccount(this.tabs, id, account, collapsed);
    return this.announceTab(id);
  }

  // -------------------------------------------------------------------------
  // Favourites
  // -------------------------------------------------------------------------

  favoritesFile(): MarketFavoritesFile {
    return this.favorites;
  }

  /**
   * Save a favourite. A capture of the tab's query happens ONLY when the
   * caller says the gesture came from the tab (`fromTab`, the builder's
   * Save ★ / Update ★). A rename or a recolour from the explorer names an
   * existing favourite instead, and must never overwrite its saved query
   * with whatever tab happens to be open — that would silently destroy a
   * search the user built, with no undo.
   */
  favoriteSave(input: MarketFavoriteSaveInput): MarketStateView {
    const tab = this.tabById(input.tabId);
    const known = input.favoriteId ? this.favoriteById(input.favoriteId) : undefined;
    if (!tab || (known && input.fromTab !== true)) {
      // A rename / recolour / move from the explorer: keep the favourite's
      // own draft and change only its chrome.
      const existing = known;
      if (!existing) return this.announce();
      const saved = saveFavorite(
        this.favorites,
        {
          id: existing.id,
          ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.colour !== undefined ? { colour: input.colour } : {}),
          draft: existing.draft,
        },
        this.nowIso(),
      );
      this.favorites = saved.file;
      this.persistFavorites();
      return this.announce();
    }
    const saved = saveFavorite(
      this.favorites,
      {
        ...(input.favoriteId ? { id: input.favoriteId } : {}),
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
        name: input.name ?? tab.label,
        colour: input.colour ?? tab.colour,
        draft: tab.draft,
      },
      this.nowIso(),
    );
    if (saved.refused) {
      this.lastError = "The favourites list is full — delete one first.";
      return this.announce();
    }
    this.favorites = saved.file;
    this.persistFavorites();
    this.tabs = this.tabs.map((entry) =>
      entry.id === tab.id ? { ...entry, favoriteId: saved.favorite.id, dirty: false, temporary: false } : entry,
    );
    this.persistTabs();
    this.lastError = undefined;
    return this.announce();
  }

  favoriteRemove(id: string): MarketStateView {
    this.favorites = removeFavorite(this.favorites, id);
    this.persistFavorites();
    this.tabs = this.tabs.map((tab) => {
      if (tab.favoriteId !== id) return tab;
      const next = { ...tab };
      delete next.favoriteId;
      return next;
    });
    return this.announce();
  }

  favoriteMove(input: { id: string; folderId: string | null; index: number }): MarketStateView {
    this.favorites = moveFavorite(this.favorites, input);
    this.persistFavorites();
    return this.announce();
  }

  favoriteOpen(id: string, opts: { temporary?: boolean } = {}): MarketStateView {
    const favorite = this.favoriteById(id);
    if (!favorite) return this.announce();
    return this.openDraft(favorite.draft, {
      label: favorite.name,
      colour: favorite.colour,
      favoriteId: favorite.id,
      temporary: opts.temporary !== false,
    });
  }

  folderSave(input: { id?: string; name: string; colour?: string; expanded?: boolean }): MarketStateView {
    const saved = saveFolder(this.favorites, input);
    if (saved.refused) {
      this.lastError = "The folder list is full — delete one first.";
      return this.announce();
    }
    this.favorites = saved.file;
    this.persistFavorites();
    this.lastError = undefined;
    return this.announce();
  }

  folderRemove(id: string): MarketStateView {
    this.favorites = removeFolder(this.favorites, id);
    this.persistFavorites();
    return this.announce();
  }

  folderMove(input: { id: string; index: number }): MarketStateView {
    this.favorites = moveFolder(this.favorites, input);
    this.persistFavorites();
    return this.announce();
  }

  tree(): ReturnType<typeof favoritesTree> {
    return favoritesTree(this.favorites);
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  importText(text: string): MarketImportResult {
    return importMarketText(String(text ?? ""));
  }

  /**
   * Open the chosen rows of an import. Index space: the drafts first, then
   * the id-only entries (which become id-only tabs — live search works,
   * the builder does not, until `tradeSearchById` is proven live).
   */
  importOpen(result: unknown, indexes: readonly number[]): MarketStateView {
    const parsed = result as MarketImportResult | undefined;
    const drafts = Array.isArray(parsed?.drafts) ? parsed.drafts : [];
    const idOnly = Array.isArray(parsed?.idOnly) ? parsed.idOnly : [];
    const wanted = new Set((indexes ?? []).map((index) => Math.floor(Number(index))).filter(Number.isFinite));
    let state = this.state();
    drafts.forEach((entry, index) => {
      if (!wanted.has(index)) return;
      const draft = sanitizeDraft(entry.draft);
      if (!draft) return;
      state = this.openDraft(draft, { label: entry.label });
    });
    idOnly.forEach((entry, offset) => {
      const index = drafts.length + offset;
      if (!wanted.has(index)) return;
      const draft = entry.kind === "exchange" ? emptyExchangeDraft() : emptySearchDraft(this.deps.settings());
      state = this.openDraft(
        draft,
        { label: `${entry.searchId} (id only)` },
        { searchId: entry.searchId, league: entry.league },
      );
    });
    return state;
  }

  // -------------------------------------------------------------------------
  // Live search
  // -------------------------------------------------------------------------

  liveStart(input: MarketLiveStartInput): MarketStateView {
    const settings = this.deps.settings();
    if (!this.deps.feed.hasSession()) {
      this.lastError = "Live search needs a POESESSID — add one in Tools → Settings → Market data.";
      return this.announce();
    }
    const capacity = this.deps.liveSearch.capacity();
    if (capacity.open >= capacity.max) {
      this.lastError = `Live search is full (${capacity.open} / ${capacity.max}). Stop one first.`;
      return this.announce();
    }
    const tab = input.tabId ? this.tabById(input.tabId) : undefined;
    const source = tab && isSearchResult(tab.result) ? tab.result : undefined;
    // An id-only tab (a share link) can be watched without ever running a
    // search: the socket needs only the league and the id.
    const searchId = source?.searchId ?? tab?.idOnly?.searchId;
    const league = source?.league ?? tab?.idOnly?.league ?? "";
    if (!searchId) {
      this.lastError = "Search this tab first — a live search follows an existing search id.";
      return this.announce();
    }
    if (this.live.some((entry) => entry.handle.searchId === searchId)) {
      this.lastError = "That search is already live.";
      return this.announce();
    }
    const label = (input.label ?? tab?.label ?? searchId).slice(0, 60);
    const id = `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: LiveEntry = {
      id,
      handle: { id, searchId, league, label, state: "connecting", resultsSeen: 0 },
      label,
      ...(tab?.favoriteId ? { favoriteId: tab.favoriteId } : {}),
      ...(tab ? { tabId: tab.id } : {}),
      sound: input.sound ?? settings.liveSound,
      notify: input.notify ?? settings.liveNotify,
      results: [],
      unread: 0,
      startedAt: this.nowIso(),
    };
    this.live.push(entry);
    try {
      entry.handle = this.deps.liveSearch.start(
        { searchId, league, label },
        {
          onListing: (listing) => this.onLiveListing(entry.id, listing),
          onState: (handle) => this.onLiveState(entry.id, handle),
        },
      );
    } catch (error) {
      this.live = this.live.filter((row) => row.id !== entry.id);
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.announce();
    }
    this.lastError = undefined;
    this.persistLive();
    return this.announce();
  }

  private onLiveListing(liveId: string, listing: TradeListing): void {
    const entry = this.live.find((row) => row.id === liveId);
    if (!entry) return;
    entry.results = [listing, ...entry.results].slice(0, MAX_LIVE_RESULTS);
    entry.unread += 1;
    entry.lastResultAt = this.nowIso();
    this.deps.emit("market:live-listing", {
      liveId,
      listing,
      sound: entry.sound,
      notify: entry.notify,
    });
    if (entry.notify) {
      const name = listing.item.name || listing.item.typeLine;
      const price = listing.price ? `${listing.price.amount} ${listing.price.currency}` : "no price";
      this.deps.notify(`Live search: ${entry.label}`, `${name} — ${price} · ${listing.seller.account}`);
      this.deps.overlayNotice?.(`Live search: ${entry.label}`, `${name} — ${price}`);
    }
    this.pruneLiveSearches();
    this.announce();
  }

  private onLiveState(liveId: string, handle: LiveSearchHandle): void {
    const entry = this.live.find((row) => row.id === liveId);
    if (!entry) return;
    entry.handle = handle;
    this.announce();
  }

  liveStop(id: string): MarketStateView {
    const entry = this.live.find((row) => row.id === id);
    if (entry) {
      try {
        this.deps.liveSearch.stop(entry.handle.id);
      } catch (error) {
        this.log("warn", "live search would not stop", error);
      }
      this.live = this.live.filter((row) => row.id !== id);
      this.persistLive();
    }
    return this.announce();
  }

  liveClear(id?: string): MarketStateView {
    for (const entry of this.live) {
      if (id && entry.id !== id) continue;
      entry.results = [];
      entry.unread = 0;
    }
    return this.announce();
  }

  liveSet(id: string, patch: { sound?: boolean; notify?: boolean; label?: string }): MarketStateView {
    const entry = this.live.find((row) => row.id === id);
    if (entry) {
      if (patch.sound !== undefined) entry.sound = Boolean(patch.sound);
      if (patch.notify !== undefined) entry.notify = Boolean(patch.notify);
      if (typeof patch.label === "string" && patch.label.trim()) entry.label = patch.label.trim().slice(0, 60);
      this.persistLive();
    }
    return this.announce();
  }

  liveSeen(id: string): MarketStateView {
    const entry = this.live.find((row) => row.id === id);
    if (entry) entry.unread = 0;
    return this.announce();
  }

  /**
   * Close live searches that have been open longer than the user's limit:
   * an app left running overnight must not hold twenty sockets and keep
   * spending fetch slots while nobody is watching.
   */
  pruneLiveSearches(): void {
    const hours = this.deps.settings().stopLiveAfterHours;
    if (!hours || hours <= 0) return;
    const cutoff = this.now().getTime() - hours * 3_600_000;
    const expired = this.live.filter((entry) => Date.parse(entry.startedAt) < cutoff);
    if (expired.length === 0) return;
    for (const entry of expired) {
      try {
        this.deps.liveSearch.stop(entry.handle.id);
      } catch {
        // Already gone.
      }
    }
    this.live = this.live.filter((entry) => !expired.includes(entry));
    this.lastError = `${expired.length} live search(es) were stopped after ${hours} h.`;
    this.persistLive();
    // The timer calls this with nobody else about to announce: without this
    // the column keeps listing sockets that are already closed.
    this.announce();
  }

  /**
   * Restart the saved live searches. Off by default: it opens websockets to
   * pathofexile.com with your POESESSID on every app start.
   */
  resumeLiveSearches(): void {
    if (!this.deps.settings().resumeLiveSearches) return;
    if (!this.deps.feed.hasSession()) return;
    const file = readJsonFile(this.fs, this.file(MARKET_LIVE_FILE), (text) => {
      if (!text) return { schemaVersion: 1 as const, searches: [] as MarketLiveDefinition[] };
      try {
        const parsed = JSON.parse(text) as MarketLiveFile;
        return {
          schemaVersion: 1 as const,
          searches: Array.isArray(parsed.searches) ? parsed.searches : [],
        };
      } catch {
        return { schemaVersion: 1 as const, searches: [] as MarketLiveDefinition[] };
      }
    });
    for (const definition of file.searches.slice(0, this.deps.liveSearch.capacity().max)) {
      if (typeof definition?.searchId !== "string" || !definition.searchId) continue;
      const id = definition.id || `live_${definition.searchId}`;
      const entry: LiveEntry = {
        id,
        handle: {
          id,
          searchId: definition.searchId,
          league: definition.league ?? "",
          label: definition.label ?? definition.searchId,
          state: "connecting",
          resultsSeen: 0,
        },
        label: definition.label ?? definition.searchId,
        ...(definition.favoriteId ? { favoriteId: definition.favoriteId } : {}),
        sound: definition.sound !== false,
        notify: definition.notify === true,
        results: [],
        unread: 0,
        startedAt: this.nowIso(),
      };
      this.live.push(entry);
      try {
        entry.handle = this.deps.liveSearch.start(
          { searchId: definition.searchId, league: definition.league ?? "", label: entry.label },
          {
            onListing: (listing) => this.onLiveListing(entry.id, listing),
            onState: (handle) => this.onLiveState(entry.id, handle),
          },
        );
      } catch (error) {
        this.live = this.live.filter((row) => row.id !== entry.id);
        this.log("warn", "a saved live search could not be resumed", error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Row actions — one chat line per click, never a macro
  // -------------------------------------------------------------------------

  private findListing(input: MarketListingActionInput): TradeListing | undefined {
    if (input.liveId) {
      const entry = this.live.find((row) => row.id === input.liveId);
      return entry?.results.find((listing) => listing.id === input.listingId);
    }
    const tab = input.tabId ? this.tabById(input.tabId) : undefined;
    if (tab && isSearchResult(tab.result)) {
      const hit = tab.result.listings.find((listing) => listing.id === input.listingId);
      if (hit) return hit;
    }
    for (const entry of this.tabs) {
      if (!isSearchResult(entry.result)) continue;
      const hit = entry.result.listings.find((listing) => listing.id === input.listingId);
      if (hit) return hit;
    }
    for (const entry of this.live) {
      const hit = entry.results.find((listing) => listing.id === input.listingId);
      if (hit) return hit;
    }
    return undefined;
  }

  private findOffer(input: MarketListingActionInput): ExchangeOffer | undefined {
    const wanted = input.offerId ?? input.listingId;
    for (const tab of this.tabs) {
      const result = tab.result;
      if (!result || isSearchResult(result)) continue;
      const hit = result.offers.find((offer) => offer.id === wanted);
      if (hit) return hit;
    }
    return undefined;
  }

  async listingAction(input: MarketListingActionInput): Promise<MarketActionOutcome> {
    const action = input.action;
    const offer = input.offerId ? this.findOffer(input) : undefined;
    const listing = offer ? undefined : this.findListing(input);
    if (!listing && !offer) {
      return { ok: false, action, error: "That row is no longer loaded — search again." };
    }

    switch (action) {
      case "copy-whisper": {
        const text = offer ? offerWhisperText(offer) : whisperText(listing!);
        if (!text) {
          return {
            ok: false,
            action,
            error: listing?.listingType === "secure" ? "Secure listings are bought on the trade site." : "This row carries no whisper.",
          };
        }
        this.deps.clipboard.writeText(text);
        return { ok: true, action, copied: text };
      }
      case "send-whisper": {
        const text = offer ? offerWhisperText(offer) : whisperText(listing!);
        if (!text) {
          return {
            ok: false,
            action,
            error: listing?.listingType === "secure" ? "Secure listings are bought on the trade site." : "This row carries no whisper.",
          };
        }
        const clean = sanitizeChatText(text);
        if (clean.issues.length > 0) {
          return { ok: false, action, error: clean.error ?? "That whisper cannot be typed into the game." };
        }
        const outcome = await this.deps.chat.send({
          text: clean.text,
          reason: `market whisper ${input.listingId}`,
          source: "market",
          focus: true,
        });
        if (outcome.ok && !outcome.dryRun && listing && this.deps.settings().collapseAfterOffer && input.tabId) {
          this.tabs = collapseAccount(this.tabs, input.tabId, listing.seller.account, true);
          this.announceTab(input.tabId);
        }
        return { ok: outcome.ok, action, chat: outcome, ...(outcome.dryRun ? { dryRun: true } : {}) };
      }
      case "hideout": {
        const seller = offer ? offer.seller : listing!.seller;
        const command = hideoutCommand({ seller });
        if (!command) return { ok: false, action, error: "This seller's character name is not in the listing." };
        const outcome = await this.deps.chat.send({
          text: command,
          reason: `market hideout ${seller.account}`,
          source: "market",
          focus: true,
        });
        return { ok: outcome.ok, action, chat: outcome, ...(outcome.dryRun ? { dryRun: true } : {}) };
      }
      case "copy-price-note": {
        const price = offer ? { amount: offer.want.amount, currency: offer.want.currency } : listing!.price;
        if (!price) return { ok: false, action, error: "That row has no price." };
        const note = priceNote(price);
        this.deps.clipboard.writeText(note);
        return { ok: true, action, copied: note };
      }
      case "copy-stats": {
        if (!listing) return { ok: false, action, error: "Exchange offers carry no item mods." };
        const catalogue = await this.catalogue();
        if (!catalogue) {
          return { ok: false, action, error: "The trade2 stat catalogue is not available yet." };
        }
        const statGroups: TradeStatGroup[] = statFiltersFromListing(listing, catalogue, { slack: STAT_SLACK });
        if (statGroups.length === 0) {
          return { ok: false, action, error: "None of this item's mods matched the stat catalogue." };
        }
        return { ok: true, action, statGroups };
      }
      case "open-site": {
        const tab = input.tabId ? this.tabById(input.tabId) : undefined;
        const url = tab?.result?.url;
        if (!url) return { ok: false, action, error: "This tab has no trade-site URL yet." };
        await this.deps.openExternal(url);
        return { ok: true, action };
      }
      default:
        return { ok: false, action, error: "Unknown action." };
    }
  }

  /** Rows folded by the collapse-after-offer rule, for the renderer. */
  collapsedRows(tabId: string): ReturnType<typeof collapseBySeller> {
    const tab = this.tabById(tabId);
    if (!tab || !isSearchResult(tab.result)) return [];
    return collapseBySeller(tab.result.listings, tab.result.collapsedAccounts);
  }

  // -------------------------------------------------------------------------
  // Catalogues
  // -------------------------------------------------------------------------

  private catalogueCache: StatCatalogue | undefined;

  private async catalogue(): Promise<StatCatalogue | undefined> {
    if (this.catalogueCache) return this.catalogueCache;
    if (!this.deps.feed.statCatalogue) return undefined;
    this.catalogueCache = await this.deps.feed.statCatalogue(["explicit", "implicit", "fractured", "desecrated"]);
    return this.catalogueCache;
  }

  statOptions(): Promise<Awaited<ReturnType<StatsSource["load"]>>> {
    return this.stats.load();
  }

  async currencyOptions(): Promise<ExchangeCurrencyOption[]> {
    if (this.currencies) return this.currencies;
    let payload: unknown;
    if (this.deps.feed.fetchStatic) {
      try {
        payload = await this.deps.feed.fetchStatic();
      } catch (error) {
        this.log("warn", "trade2 static data was not available; using the curated currency list", error);
      }
    }
    const table = this.deps.priceTable();
    const fromStatic = payload === undefined ? [] : exchangeCurrencyOptions(payload, table);
    this.currencies =
      fromStatic.length > 0 ? fromStatic : exchangeCurrencyOptions(this.deps.data?.exchangeCurrencies ?? [], table);
    return this.currencies;
  }

  /**
   * Weighted-sum templates with their filters resolved against the current
   * stats catalogue. An unresolved filter comes back with `id: ""` so the
   * UI can grey it instead of sending a filter the site will refuse.
   */
  async weightTemplates(): Promise<WeightTemplateView[]> {
    const raw = this.deps.data?.weightTemplates;
    if (!Array.isArray(raw)) return [];
    const catalogue = await this.catalogue();
    const views: WeightTemplateView[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const template = entry as {
        id?: unknown;
        label?: unknown;
        type?: unknown;
        min?: unknown;
        filters?: unknown;
      };
      const id = typeof template.id === "string" ? template.id : "";
      if (!id) continue;
      const type = template.type === "weight2" ? "weight2" : "weight";
      const filters = (Array.isArray(template.filters) ? template.filters : []).flatMap((rawFilter) => {
        if (typeof rawFilter !== "object" || rawFilter === null) return [];
        const filter = rawFilter as { text?: unknown; type?: unknown; weight?: unknown };
        if (typeof filter.text !== "string") return [];
        const ids = catalogue?.byText.get(normalizeStatText(filter.text)) ?? [];
        return [
          {
            text: filter.text,
            type: typeof filter.type === "string" ? filter.type : "explicit",
            weight: Number.isFinite(Number(filter.weight)) ? Number(filter.weight) : 1,
            id: ids[0] ?? "",
          },
        ];
      });
      views.push({
        id,
        label: typeof template.label === "string" ? template.label : id,
        type,
        ...(Number.isFinite(Number(template.min)) ? { min: Number(template.min) } : {}),
        filters,
        resolved: filters.length > 0 && filters.every((filter) => filter.id !== ""),
      });
    }
    return views;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    for (const entry of this.live) {
      try {
        this.deps.liveSearch.stop(entry.handle.id);
      } catch {
        // The live-search service closes its own sockets on dispose too.
      }
    }
    this.live = [];
  }
}

export function createMarketService(deps: MarketServiceDeps): MarketService {
  return new MarketService(deps);
}
