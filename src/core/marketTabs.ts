/**
 * Market tab sessions — a pure state machine. The service owns the network
 * and the files; everything about "which tabs are alive, what do they hold,
 * which one gets evicted" lives here so it can be tested without a clock,
 * a socket or a disk.
 *
 * Results are held in memory only: `market-tabs.json` stores drafts and
 * labels, never listings (seller names and prices are other players' data).
 */
import type { ExchangeOffer, TradeListing } from "./tradeListings.js";
import { draftFingerprint, sanitizeDraft, isMarketColour, type MarketDraft } from "./marketQuery.js";

/** Ten alive at once, like the site's own result retention. */
export const MAX_MARKET_TABS = 10;
/** trade2 fetches ten ids per GET; a page is one fetch. */
export const MARKET_PAGE_SIZE = 10;
/** Rows a live search keeps per search. */
export const MAX_LIVE_RESULTS = 50;
/** Ids kept from one search — ten pages is already ten fetches. */
export const MAX_SEARCH_RESULT_IDS = 100;

export type MarketTabState = "idle" | "searching" | "fetching" | "ready" | "error";

export interface MarketSearchResult {
  searchId: string;
  league: string;
  url: string;
  total: number;
  resultIds: string[];
  listings: TradeListing[];
  nextOffset: number;
  fetchedAt: string;
  cached: boolean;
  /** Seller accounts whose extra rows are folded into one line. */
  collapsedAccounts: string[];
  /** Filter paths an imported URL carried that this builder cannot edit. */
  unsupported?: string[];
}

export interface MarketExchangeResult {
  searchId: string;
  league: string;
  url: string;
  total: number;
  offers: ExchangeOffer[];
  fetchedAt: string;
}

export type MarketResult = MarketSearchResult | MarketExchangeResult;

export function isSearchResult(result: MarketResult | undefined): result is MarketSearchResult {
  return result !== undefined && Array.isArray((result as MarketSearchResult).listings);
}

export interface MarketTab {
  id: string;
  kind: "search" | "exchange";
  label: string;
  colour: string;
  favoriteId?: string;
  /** Opened from a favourite and not yet edited: first to be evicted. */
  temporary: boolean;
  /** The draft differs from the favourite it came from. */
  dirty: boolean;
  draft: MarketDraft;
  state: MarketTabState;
  error?: string;
  result?: MarketResult;
  /** An id-form import: the search id is known but the query is not editable. */
  idOnly?: { searchId: string; league: string };
  createdAt: string;
  lastUsedAt: string;
}

export interface PersistedMarketTab {
  id: string;
  kind: "search" | "exchange";
  label: string;
  colour: string;
  favoriteId?: string;
  temporary: boolean;
  draft: MarketDraft;
  /**
   * Kept across restarts on purpose: without it a reloaded share-link tab
   * looks like a normal tab with an empty draft, and Search would post a
   * league-wide query the user never asked for.
   */
  idOnly?: { searchId: string; league: string };
}

/** A share-link id is the site's own short token, never a URL or a path. */
const SEARCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** The `idOnly` marker, or undefined when the file holds something else. */
function sanitizeIdOnly(raw: unknown): { searchId: string; league: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as { searchId?: unknown; league?: unknown };
  if (typeof source.searchId !== "string" || !SEARCH_ID_PATTERN.test(source.searchId)) return undefined;
  const league = typeof source.league === "string" ? source.league.slice(0, 60) : "";
  return { searchId: source.searchId, league };
}

export interface MarketTabsPersisted {
  schemaVersion: 1;
  activeTabId?: string;
  tabs: PersistedMarketTab[];
}

export function newTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface OpenTabInput {
  draft: MarketDraft;
  label?: string;
  colour?: string;
  favoriteId?: string;
  temporary?: boolean;
  idOnly?: { searchId: string; league: string };
}

export interface OpenTabResult {
  tabs: MarketTab[];
  tab: MarketTab;
  /** The tab the cap forced closed, if any. */
  closed?: MarketTab;
  refused?: "tab-limit";
}

function copy(tabs: readonly MarketTab[]): MarketTab[] {
  return tabs.map((tab) => ({ ...tab }));
}

function byLeastRecentlyUsed(left: MarketTab, right: MarketTab): number {
  return Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt);
}

/**
 * Open a tab, honouring the ten-alive cap: a temporary, unedited tab goes
 * first, then the least-recently-used clean tab; if every tab is dirty or
 * mid-search the request is refused and the user closes one by hand.
 * Re-opening a favourite that already has a clean tab just selects it.
 */
export function openTab(tabs: readonly MarketTab[], input: OpenTabInput, now: string): OpenTabResult {
  const next = copy(tabs);
  if (input.favoriteId) {
    const existing = next.find((tab) => tab.favoriteId === input.favoriteId && !tab.dirty);
    if (existing) {
      existing.lastUsedAt = now;
      return { tabs: next, tab: existing };
    }
  }

  let closed: MarketTab | undefined;
  if (next.length >= MAX_MARKET_TABS) {
    const candidates = [...next].sort(byLeastRecentlyUsed);
    const victim =
      candidates.find((tab) => tab.temporary && !tab.dirty) ??
      candidates.find((tab) => !tab.dirty && tab.state !== "searching" && tab.state !== "fetching");
    if (!victim) {
      return { tabs: next, tab: next[next.length - 1]!, refused: "tab-limit" };
    }
    closed = { ...victim };
    const at = next.findIndex((tab) => tab.id === victim.id);
    if (at >= 0) next.splice(at, 1);
  }

  const tab: MarketTab = {
    id: newTabId(),
    kind: input.draft.kind,
    label: input.label?.trim() || "New search",
    colour: isMarketColour(input.colour) ? input.colour : "grey",
    ...(input.favoriteId ? { favoriteId: input.favoriteId } : {}),
    temporary: input.temporary === true,
    dirty: false,
    draft: input.draft,
    state: "idle",
    ...(input.idOnly ? { idOnly: input.idOnly } : {}),
    createdAt: now,
    lastUsedAt: now,
  };
  next.push(tab);
  return { tabs: next, tab, ...(closed ? { closed } : {}) };
}

export function closeTab(tabs: readonly MarketTab[], id: string): MarketTab[] {
  return copy(tabs).filter((tab) => tab.id !== id);
}

export function touchTab(tabs: readonly MarketTab[], id: string, now: string): MarketTab[] {
  return copy(tabs).map((tab) => (tab.id === id ? { ...tab, lastUsedAt: now } : tab));
}

/**
 * Editing the draft makes a temporary tab permanent and marks it dirty when
 * it no longer matches the favourite it came from. A sort change against
 * the same favourite still counts as an edit (it changes the body), but it
 * never renames the tab — the label is the user's.
 *
 * An edit also drops the `idOnly` marker: once the user has written a query
 * of their own, Search must send THAT query. Keeping the marker would ask
 * the site for someone else's saved search and show rows that have nothing
 * to do with what the builder displays.
 */
export function updateDraft(
  tabs: readonly MarketTab[],
  id: string,
  draft: MarketDraft,
  favoriteFingerprint?: string,
): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id) return tab;
    const fingerprint = draftFingerprint(draft);
    const next: MarketTab = {
      ...tab,
      draft,
      kind: draft.kind,
      temporary: false,
      dirty: favoriteFingerprint !== undefined ? fingerprint !== favoriteFingerprint : true,
    };
    delete next.idOnly;
    return next;
  });
}

export function renameTab(tabs: readonly MarketTab[], id: string, label: string, colour?: string): MarketTab[] {
  return copy(tabs).map((tab) =>
    tab.id === id
      ? {
          ...tab,
          label: label.trim().slice(0, 60) || tab.label,
          ...(isMarketColour(colour) ? { colour } : {}),
        }
      : tab,
  );
}

export function markSearching(tabs: readonly MarketTab[], id: string): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id) return tab;
    const next: MarketTab = { ...tab, state: "searching" };
    delete next.error;
    return next;
  });
}

export function markError(tabs: readonly MarketTab[], id: string, error: string): MarketTab[] {
  return copy(tabs).map((tab) => (tab.id === id ? { ...tab, state: "error", error } : tab));
}

export type SearchOutcome = Omit<MarketSearchResult, "listings" | "nextOffset" | "collapsedAccounts">;

/**
 * The page offset counts IDS REQUESTED, never rows returned: trade2 answers
 * only for the listings that still exist, so a page of ten ids can come back
 * with eight rows. Advancing by the rows would re-request the two dead ids
 * on every "Load 10 more" — a wasted fetch each click, and a page that never
 * reaches the end of the list.
 */
export function applySearch(
  tabs: readonly MarketTab[],
  id: string,
  outcome: SearchOutcome,
  firstPage: readonly TradeListing[],
  now: string,
  requestedIds: number,
): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id) return tab;
    const resultIds = outcome.resultIds.slice(0, MAX_SEARCH_RESULT_IDS);
    const requested = Math.max(0, Math.floor(requestedIds));
    const result: MarketSearchResult = {
      ...outcome,
      resultIds,
      listings: [...firstPage],
      nextOffset: Math.min(requested, resultIds.length),
      collapsedAccounts: [],
      fetchedAt: now,
    };
    const next: MarketTab = { ...tab, state: "ready", result, lastUsedAt: now };
    delete next.error;
    return next;
  });
}

export function appendPage(
  tabs: readonly MarketTab[],
  id: string,
  page: readonly TradeListing[],
  requestedIds: number,
): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id || !isSearchResult(tab.result)) return tab;
    const listings = [...tab.result.listings, ...page];
    const requested = Math.max(0, Math.floor(requestedIds));
    return {
      ...tab,
      state: "ready",
      result: {
        ...tab.result,
        listings,
        nextOffset: Math.min(tab.result.nextOffset + requested, tab.result.resultIds.length),
      },
    };
  });
}

export function applyExchange(
  tabs: readonly MarketTab[],
  id: string,
  result: MarketExchangeResult,
  now: string,
): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id) return tab;
    const next: MarketTab = { ...tab, state: "ready", result, lastUsedAt: now };
    delete next.error;
    return next;
  });
}

export function collapseAccount(
  tabs: readonly MarketTab[],
  id: string,
  account: string,
  collapsed: boolean,
): MarketTab[] {
  return copy(tabs).map((tab) => {
    if (tab.id !== id || !isSearchResult(tab.result)) return tab;
    const current = new Set(tab.result.collapsedAccounts);
    if (collapsed) current.add(account);
    else current.delete(account);
    return { ...tab, result: { ...tab.result, collapsedAccounts: [...current] } };
  });
}

/** The next ten result ids to fetch, or an empty list when the page is the last. */
export function nextPageIds(tab: MarketTab): string[] {
  if (!isSearchResult(tab.result)) return [];
  return tab.result.resultIds.slice(tab.result.nextOffset, tab.result.nextOffset + MARKET_PAGE_SIZE);
}

export function persistedTabs(tabs: readonly MarketTab[], activeTabId?: string): MarketTabsPersisted {
  return {
    schemaVersion: 1,
    ...(activeTabId ? { activeTabId } : {}),
    tabs: tabs.slice(0, MAX_MARKET_TABS).map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      label: tab.label,
      colour: tab.colour,
      ...(tab.favoriteId ? { favoriteId: tab.favoriteId } : {}),
      temporary: tab.temporary,
      draft: tab.draft,
      ...(tab.idOnly ? { idOnly: { searchId: tab.idOnly.searchId, league: tab.idOnly.league } } : {}),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePersistedTabs(raw: unknown): { value: MarketTabsPersisted; issues: string[] } {
  const issues: string[] = [];
  const source = isRecord(raw) ? raw : {};
  const tabs: PersistedMarketTab[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(source.tabs) ? source.tabs : []) {
    if (!isRecord(entry)) continue;
    if (tabs.length >= MAX_MARKET_TABS) {
      issues.push(`more than ${MAX_MARKET_TABS} tabs; extra dropped`);
      break;
    }
    const draft = sanitizeDraft(entry.draft);
    if (!draft) {
      issues.push("a saved tab had no usable query; dropped");
      continue;
    }
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : newTabId();
    if (seen.has(id)) continue;
    seen.add(id);
    const favoriteId = typeof entry.favoriteId === "string" && entry.favoriteId ? entry.favoriteId : undefined;
    const idOnly = sanitizeIdOnly(entry.idOnly);
    if (entry.idOnly !== undefined && !idOnly) {
      issues.push("a saved tab's share-link id was unreadable; the tab is now a normal search");
    }
    tabs.push({
      id,
      kind: draft.kind,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 60) : "Saved search",
      colour: isMarketColour(entry.colour) ? entry.colour : "grey",
      ...(favoriteId ? { favoriteId } : {}),
      temporary: entry.temporary === true,
      draft,
      ...(idOnly ? { idOnly } : {}),
    });
  }
  const activeTabId =
    typeof source.activeTabId === "string" && tabs.some((tab) => tab.id === source.activeTabId)
      ? source.activeTabId
      : undefined;
  return {
    value: { schemaVersion: 1, ...(activeTabId ? { activeTabId } : {}), tabs },
    issues,
  };
}

/** Rehydrate persisted tabs into live (result-free) tabs. */
export function tabsFromPersisted(persisted: MarketTabsPersisted, now: string): MarketTab[] {
  return persisted.tabs.map((tab) => ({
    ...tab,
    dirty: false,
    state: "idle" as const,
    createdAt: now,
    lastUsedAt: now,
  }));
}
