/**
 * Market (package "market", channels `market:*`) — the in-app trade
 * browser's contract between main and the renderer.
 *
 * Main owns every trade2 request, the live-search sockets and the three
 * `market-*.json` files; the renderer only invokes and renders. The session
 * cookie never crosses this boundary (`hasSession` is a boolean), and
 * results are views of rows already in main's memory — nothing here is
 * persisted to disk.
 *
 * Pure types (plus re-exports of the pure core model): no Electron, no DOM.
 */
import type { FeatureCall } from "./features.js";
import type { ChatCommandOutcome } from "./chatCommands.js";
import type { LiveSearchHandle } from "./liveSearch.js";
import type { ExchangeOffer, TradeListing } from "../core/tradeListings.js";
import type { TradeStatGroup } from "../core/tradeQuery.js";
import type {
  MarketExchangeResult,
  MarketSearchResult,
  MarketTab,
  MarketTabState,
} from "../core/marketTabs.js";
import type { MarketFavoritesFile } from "../core/marketFavorites.js";
import type { MarketDraft } from "../core/marketQuery.js";
import type { ExchangeCurrencyOption } from "../core/marketExchange.js";
import type { MarketImportResult } from "../core/marketImport.js";
import type { MarketStatOption } from "../core/marketStatSearch.js";
import type { MarketSettings } from "../core/marketSettings.js";

export type {
  ExchangeCurrencyOption,
  MarketDraft,
  MarketExchangeResult,
  MarketFavoritesFile,
  MarketImportResult,
  MarketSearchResult,
  MarketSettings,
  MarketStatOption,
  MarketTabState,
};
export type { MarketFavorite, MarketFolder, FavoritesGroup } from "../core/marketFavorites.js";
export type { MarketSortKey } from "../core/marketQuery.js";

/** One tab with its rows — what the active tab's panel renders. */
export type MarketTabView = MarketTab;

/** Every tab, without its rows: the tab strip and the tab cap counter. */
export interface MarketTabSummary {
  id: string;
  kind: "search" | "exchange";
  label: string;
  colour: string;
  favoriteId?: string;
  temporary: boolean;
  dirty: boolean;
  state: MarketTabState;
  error?: string;
  resultCount?: number;
  total?: number;
  /** Rows still unfetched (`resultIds.length - nextOffset`). */
  remaining?: number;
  /** A share-link tab: it carries a search id, not an editable query. */
  idOnly?: boolean;
  lastUsedAt: string;
}

export interface MarketLiveView {
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

/** `market-live-searches.json`: what a live search needs to be restarted. */
export interface MarketLiveDefinition {
  id: string;
  searchId: string;
  league: string;
  label: string;
  favoriteId?: string;
  sound: boolean;
  notify: boolean;
}

export interface MarketLiveFile {
  schemaVersion: 1;
  searches: MarketLiveDefinition[];
}

export interface MarketBudgetView {
  lookups: number;
  searchesSpare: number;
  fetchesSpare: number;
  restrictedUntilIso?: string;
}

/**
 * One currency's rate in exalted, as the price feed knows it. The renderer
 * rebuilds a minimal price table from these so the fractional-price split
 * and its "at N ex/div" tooltip use the same numbers main does — every one
 * an estimate from the feed, never a trade2 quote.
 */
export interface MarketCurrencyRate {
  id: string;
  name: string;
  exalted: number;
  /** A feed or user row, as opposed to the crafting engine's default. */
  fromTable: boolean;
}

export interface MarketStateView {
  tabs: MarketTabSummary[];
  activeTabId?: string;
  favorites: MarketFavoritesFile;
  live: MarketLiveView[];
  liveCapacity: { open: number; max: number };
  budget: MarketBudgetView;
  league?: string;
  leagueAmbiguous: boolean;
  /** A POESESSID is configured (the cookie itself never leaves main). */
  hasSession: boolean;
  /** The trade2 stats catalogue is indexed, so stat autocomplete works. */
  statsReady: boolean;
  settings: MarketSettings;
  /** Rates behind every "≈ … ex" figure the rows show. */
  currencyRates: MarketCurrencyRate[];
  /** How old the poe2scout feed those rates came from is. */
  feedAgeHours?: number;
  /** Sanitizer complaints from the last file read, for the settings card. */
  fileIssues: string[];
  lastError?: string;
}

export interface WeightTemplateFilterView {
  text: string;
  type: string;
  weight: number;
  /** "" when the current catalogue has no id for this text. */
  id: string;
}

export interface WeightTemplateView {
  id: string;
  label: string;
  type: "weight" | "weight2";
  min?: number;
  filters: WeightTemplateFilterView[];
  /** Every filter resolved to a stat id. */
  resolved: boolean;
}

export type MarketListingActionKind =
  | "copy-whisper"
  | "send-whisper"
  | "hideout"
  | "copy-stats"
  | "copy-price-note"
  | "open-site";

export interface MarketListingActionInput {
  action: MarketListingActionKind;
  tabId?: string;
  liveId?: string;
  listingId: string;
  /** An exchange offer id (`<listingId>#<index>` for multi-offer listings). */
  offerId?: string;
}

export interface MarketActionOutcome {
  ok: boolean;
  action: MarketListingActionKind;
  /** Text put on the clipboard, for the confirmation line. */
  copied?: string;
  chat?: ChatCommandOutcome;
  statGroups?: TradeStatGroup[];
  error?: string;
  dryRun?: boolean;
}

export interface MarketOpenTabOptions {
  label?: string;
  colour?: string;
  favoriteId?: string;
  temporary?: boolean;
  select?: boolean;
}

export interface MarketFavoriteSaveInput {
  tabId: string;
  /** Present = update that favourite in place. */
  favoriteId?: string;
  name?: string;
  folderId?: string | null;
  colour?: string;
  /**
   * The gesture came from a tab (the builder's Save ★ / Update ★), so the
   * tab's query is captured. Absent for a rename / recolour / move from the
   * explorer, which must leave the favourite's saved query alone.
   */
  fromTab?: boolean;
}

export interface MarketLiveStartInput {
  tabId?: string;
  favoriteId?: string;
  label?: string;
  sound?: boolean;
  notify?: boolean;
}

export interface MarketContract {
  "market:state": FeatureCall<[], MarketStateView>;
  "market:tab": FeatureCall<[tabId: string], MarketTabView | undefined>;
  "market:open-tab": FeatureCall<[draft: MarketDraft, opts?: MarketOpenTabOptions], MarketStateView>;
  /**
   * A brand-new tab seeded from the Market defaults (status, sale type,
   * instant buyout, sort). The UI's "+ Search" / "+ Exchange" buttons use
   * this instead of posting a literal empty draft, so the builder shows the
   * same query the request will carry.
   */
  "market:new-tab": FeatureCall<[kind: "search" | "exchange"], MarketStateView>;
  "market:close-tab": FeatureCall<[tabId: string], MarketStateView>;
  "market:select-tab": FeatureCall<[tabId: string], MarketStateView>;
  "market:update-draft": FeatureCall<[tabId: string, draft: MarketDraft], MarketTabView | undefined>;
  "market:rename-tab": FeatureCall<[tabId: string, label: string, colour?: string], MarketStateView>;
  /** One search + one fetch (the first ten rows). */
  "market:search": FeatureCall<[tabId: string], MarketTabView | undefined>;
  /** The next ten ids: one fetch. */
  "market:load-more": FeatureCall<[tabId: string], MarketTabView | undefined>;
  /** One exchange request (search policy). */
  "market:exchange": FeatureCall<[tabId: string], MarketTabView | undefined>;
  "market:collapse-account": FeatureCall<
    [tabId: string, account: string, collapsed: boolean],
    MarketTabView | undefined
  >;
  "market:favorites": FeatureCall<[], MarketFavoritesFile>;
  "market:favorite-save": FeatureCall<[input: MarketFavoriteSaveInput], MarketStateView>;
  "market:favorite-remove": FeatureCall<[id: string], MarketStateView>;
  "market:favorite-move": FeatureCall<
    [input: { id: string; folderId: string | null; index: number }],
    MarketStateView
  >;
  /** Opens a temporary tab by default (dashed chip, first to be evicted). */
  "market:favorite-open": FeatureCall<[id: string, opts?: { temporary?: boolean }], MarketStateView>;
  "market:folder-save": FeatureCall<
    [input: { id?: string; name: string; colour?: string; expanded?: boolean }],
    MarketStateView
  >;
  "market:folder-remove": FeatureCall<[id: string], MarketStateView>;
  "market:folder-move": FeatureCall<[input: { id: string; index: number }], MarketStateView>;
  /** Pure: parses pasted text, spends nothing. */
  "market:import": FeatureCall<[text: string], MarketImportResult>;
  "market:import-open": FeatureCall<[result: MarketImportResult, indexes: number[]], MarketStateView>;
  "market:live-start": FeatureCall<[input: MarketLiveStartInput], MarketStateView>;
  "market:live-stop": FeatureCall<[id: string], MarketStateView>;
  /** Clear one search's rows, or every search's when the id is omitted. */
  "market:live-clear": FeatureCall<[id?: string], MarketStateView>;
  "market:live-set": FeatureCall<
    [id: string, patch: { sound?: boolean; notify?: boolean; label?: string }],
    MarketStateView
  >;
  "market:live-seen": FeatureCall<[id: string], MarketStateView>;
  "market:listing-action": FeatureCall<[input: MarketListingActionInput], MarketActionOutcome>;
  /** The stats catalogue, indexed once per session (7-day cached GET). */
  "market:stats": FeatureCall<[], MarketStatOption[]>;
  "market:currencies": FeatureCall<[], ExchangeCurrencyOption[]>;
  "market:weight-templates": FeatureCall<[], WeightTemplateView[]>;
  "market:settings": FeatureCall<[patch?: Partial<MarketSettings>], MarketSettings>;
}

export interface MarketEvents {
  /** Any tab/favourite/live/settings change — summaries only. */
  "market:state": MarketStateView;
  /** One tab's rows changed (search, page, exchange, collapse). */
  "market:tab": MarketTabView;
  /** A live search produced a row; the renderer decides about the chime. */
  "market:live-listing": { liveId: string; listing: TradeListing; sound: boolean; notify: boolean };
}

/** Exchange rows the renderer renders through the same helpers as main. */
export type { ExchangeOffer, TradeListing };
