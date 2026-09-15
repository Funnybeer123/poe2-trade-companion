import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MARKET_SETTINGS, type MarketSettings } from "../src/core/marketSettings.js";
import { emptyPriceTable, type PriceTable } from "../src/core/priceTable.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { parseExchangeResult, parseTradeListings, type TradeListing } from "../src/core/tradeListings.js";
import { isSearchResult } from "../src/core/marketTabs.js";
import type { LiveSearchHandle } from "../src/shared/liveSearch.js";
import type { ChatCommandOutcome, ChatCommandRequest } from "../src/shared/chatCommands.js";
import type { MarketStateView } from "../src/shared/market.js";
import { memoryMarketFs } from "../src/main/features/market/files.js";
import {
  createMarketService,
  type MarketFeed,
  type MarketLiveSearchLike,
  type MarketServiceDeps,
} from "../src/main/features/market/service.js";

const LEAGUE = "Runes of Aldur";
const CLOCK = new Date("2026-09-10T12:00:00.000Z");

const fetched = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "market", "fetch-ruby-ring.json"), "utf8"),
) as unknown;
const exchangePayload = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "market", "exchange-divine-exalted.json"), "utf8"),
) as unknown;
const statsPayload = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8"),
) as unknown;
const curatedCurrencies = JSON.parse(
  readFileSync(path.join(process.cwd(), "src", "data", "market", "exchange-currencies.json"), "utf8"),
) as unknown;
const weightTemplates = JSON.parse(
  readFileSync(path.join(process.cwd(), "src", "data", "market", "weight-templates.json"), "utf8"),
) as unknown;

const ROWS = parseTradeListings(fetched, LEAGUE);
const EXCHANGE = parseExchangeResult(exchangePayload, LEAGUE);

interface Harness {
  service: ReturnType<typeof createMarketService>;
  feed: MarketFeed & {
    tradeSearch: ReturnType<typeof vi.fn>;
    tradeFetch: ReturnType<typeof vi.fn>;
    tradeExchange: ReturnType<typeof vi.fn>;
  };
  live: MarketLiveSearchLike & { handlers: Map<string, { onListing(l: TradeListing): void; onState(h: LiveSearchHandle): void }> };
  chat: { send: ReturnType<typeof vi.fn> };
  clipboard: { writeText: ReturnType<typeof vi.fn> };
  notify: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  fs: ReturnType<typeof memoryMarketFs>;
  settings: MarketSettings;
  budget: { lookups: number; searchesSpare: number; fetchesSpare: number; restrictedUntilIso?: string };
  status: { resolvedLeague?: string; leagueAmbiguous: boolean; feedAgeHours?: number };
  openExternal: ReturnType<typeof vi.fn>;
}

function priceTable(): PriceTable {
  const table = emptyPriceTable();
  table.entries.push({ id: "divine", match: { name: "Divine Orb" }, value: 404.62 });
  return table;
}

function harness(overrides: Partial<MarketServiceDeps> = {}, seed: Record<string, string> = {}): Harness {
  const fs = memoryMarketFs(seed);
  const settings: MarketSettings = { ...DEFAULT_MARKET_SETTINGS };
  const budget = { lookups: 9, searchesSpare: 9, fetchesSpare: 9 } as Harness["budget"];
  const status: Harness["status"] = { resolvedLeague: LEAGUE, leagueAmbiguous: false, feedAgeHours: 2 };
  const handlers = new Map<string, { onListing(l: TradeListing): void; onState(h: LiveSearchHandle): void }>();
  let open = 0;

  const feed = {
    tradeSearch: vi.fn(async () => ({
      id: "SID",
      total: 250,
      resultIds: Array.from({ length: 30 }, (_row, index) => `id-${index}`),
      league: LEAGUE,
      url: `https://www.pathofexile.com/trade2/search/poe2/${LEAGUE}/SID`,
      cached: false,
    })),
    tradeFetch: vi.fn(async (ids: string[]) => ROWS.slice(0, ids.length)),
    tradeExchange: vi.fn(async () => ({ ...EXCHANGE, league: LEAGUE, url: "https://exchange" })),
    tradeBudget: () => budget,
    hasSession: () => true,
    status: () => status,
    statsPayloadCached: vi.fn(() => statsPayload),
    fetchStats: vi.fn(async () => statsPayload),
    statCatalogue: vi.fn(async () => buildStatCatalogue(statsPayload, MOD_FAMILIES, ["explicit", "implicit"])),
  } as unknown as Harness["feed"];

  const live = {
    handlers,
    start: vi.fn((input: { searchId: string; league: string; label: string }, sinks) => {
      open += 1;
      const id = `live-${input.searchId}`;
      handlers.set(id, sinks);
      return { id, searchId: input.searchId, league: input.league, label: input.label, state: "open", resultsSeen: 0 };
    }),
    stop: vi.fn(() => {
      open = Math.max(0, open - 1);
    }),
    list: vi.fn(() => []),
    capacity: vi.fn(() => ({ open, max: 20 })),
  } as unknown as Harness["live"];

  const chat = {
    send: vi.fn(
      async (request: ChatCommandRequest): Promise<ChatCommandOutcome> => ({
        ok: true,
        dryRun: false,
        sent: request.text,
        at: CLOCK.toISOString(),
      }),
    ),
  };
  const clipboard = { writeText: vi.fn() };
  const notify = vi.fn();
  const emit = vi.fn();
  const openExternal = vi.fn(async () => undefined);

  const service = createMarketService({
    userDataDir: "C:/user",
    feed,
    liveSearch: live,
    chat,
    settings: () => settings,
    priceTable,
    clipboard,
    notify,
    openExternal,
    emit,
    data: { exchangeCurrencies: curatedCurrencies, weightTemplates },
    now: () => CLOCK,
    fs,
    ...overrides,
  });

  return { service, feed, live, chat, clipboard, notify, emit, fs, settings, budget, status, openExternal };
}

function searchDraft(type = "Ruby Ring") {
  return { kind: "search" as const, query: { stats: [], type } };
}

async function readyTab(h: Harness): Promise<string> {
  const state = h.service.openTab(searchDraft());
  const id = state.activeTabId!;
  await h.service.search(id);
  return id;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("search", () => {
  it("spends exactly one search and one fetch", async () => {
    const h = harness();
    const id = await readyTab(h);
    expect(h.feed.tradeSearch).toHaveBeenCalledTimes(1);
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(1);
    expect(h.feed.tradeFetch.mock.calls[0]![0]).toHaveLength(10);
    const tab = h.service.tab(id)!;
    expect(tab.state).toBe("ready");
    if (!isSearchResult(tab.result)) throw new Error("expected a search result");
    expect(tab.result.listings).toHaveLength(10);
    expect(tab.result.total).toBe(250);
  });

  it("writes the Market defaults into the tab, so the builder shows what was sent", async () => {
    const h = harness();
    h.settings.defaultStatus = "onlineleague";
    const state = h.service.openTab({ kind: "search", query: { stats: [], type: "Ruby Ring" } });
    const id = state.activeTabId!;
    await h.service.search(id);
    const tab = h.service.tab(id)!;
    if (tab.draft.kind !== "search") throw new Error("expected a search draft");
    expect(tab.draft.query.status).toBe("onlineleague");
    const body = h.feed.tradeSearch.mock.calls[0]![0] as { query: { status?: unknown } };
    expect(body.query.status).toEqual({ option: "onlineleague" });
    // Adopting a default is not a user edit: the tab stays clean.
    expect(h.service.state().tabs[0]!.dirty).toBe(false);
  });

  it("caches the body for a minute", async () => {
    const h = harness();
    await readyTab(h);
    expect(h.feed.tradeSearch.mock.calls[0]![1]).toMatchObject({ cacheTtlMs: 60_000 });
  });

  it("refuses inside a penalty window and spends nothing", async () => {
    const h = harness();
    h.budget.restrictedUntilIso = "2026-09-10T12:10:00.000Z";
    const state = h.service.openTab(searchDraft());
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.state).toBe("error");
    expect(tab?.error).toMatch(/wait until/);
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
  });

  it("refuses while the league is ambiguous", async () => {
    const h = harness();
    h.status.leagueAmbiguous = true;
    const state = h.service.openTab(searchDraft());
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.error).toMatch(/Two current leagues/);
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
  });

  it("refuses without a spare search or fetch slot", async () => {
    const h = harness();
    h.budget.searchesSpare = 0;
    const state = h.service.openTab(searchDraft());
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.error).toMatch(/budget spent/);
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
  });

  it("surfaces a complexity refusal without fetching", async () => {
    const h = harness();
    h.feed.tradeSearch.mockResolvedValueOnce({
      id: "",
      total: 0,
      resultIds: [],
      league: LEAGUE,
      url: "",
      cached: false,
      complexityError: "Query is too complex",
    });
    const state = h.service.openTab(searchDraft());
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.error).toMatch(/too complex/);
    expect(h.feed.tradeFetch).not.toHaveBeenCalled();
  });

  it("reports a feed error verbatim", async () => {
    const h = harness();
    h.feed.tradeSearch.mockRejectedValueOnce(new Error("trade2 search → HTTP 503"));
    const state = h.service.openTab(searchDraft());
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.error).toBe("trade2 search → HTTP 503");
  });
});

describe("paging", () => {
  it("fetches the next ten ids", async () => {
    const h = harness();
    const id = await readyTab(h);
    await h.service.loadMore(id);
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(2);
    expect(h.feed.tradeFetch.mock.calls[1]![0]).toEqual(Array.from({ length: 10 }, (_r, i) => `id-${i + 10}`));
  });

  it("keeps minSpareFetches back for the rest of the app", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.budget.fetchesSpare = 1;
    const tab = await h.service.loadMore(id);
    expect(tab?.error).toMatch(/keeps 2 back/);
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(1);
  });

  it("moves past ids whose listing has sold instead of asking for them again", async () => {
    const h = harness();
    // Eight of the first ten ids answer; two sold between search and fetch.
    h.feed.tradeFetch.mockImplementationOnce(async (ids: string[]) => ROWS.slice(0, Math.max(0, ids.length - 2)));
    const id = await readyTab(h);
    const first = h.service.tab(id)!;
    if (!isSearchResult(first.result)) throw new Error("expected a search result");
    expect(first.result.listings).toHaveLength(8);
    expect(first.result.nextOffset).toBe(10);
    await h.service.loadMore(id);
    expect(h.feed.tradeFetch.mock.calls[1]![0]).toEqual(Array.from({ length: 10 }, (_r, i) => `id-${i + 10}`));
  });

  it("stops offering another page when a whole page of ids is gone", async () => {
    const h = harness();
    h.feed.tradeSearch.mockResolvedValueOnce({
      id: "SID",
      total: 3,
      resultIds: ["a", "b", "c"],
      league: LEAGUE,
      url: "u",
      cached: false,
    });
    h.feed.tradeFetch.mockImplementationOnce(async () => []);
    const id = await readyTab(h);
    await h.service.loadMore(id);
    // Nothing left to ask for: the one fetch the search spent is the only one.
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(1);
    const tab = h.service.tab(id)!;
    if (!isSearchResult(tab.result)) throw new Error("expected a search result");
    expect(tab.result.nextOffset).toBe(3);
    expect(h.service.state().tabs[0]!.remaining).toBe(0);
  });

  it("does nothing once every id is fetched", async () => {
    const h = harness();
    h.feed.tradeSearch.mockResolvedValueOnce({
      id: "SID",
      total: 3,
      resultIds: ["a", "b", "c"],
      league: LEAGUE,
      url: "u",
      cached: false,
    });
    const id = await readyTab(h);
    await h.service.loadMore(id);
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("exchange", () => {
  it("spends one request and stores the offers", async () => {
    const h = harness();
    const state = h.service.openTab({ kind: "exchange", query: { have: ["divine"], want: ["exalted"] } });
    const tab = await h.service.exchange(state.activeTabId!);
    expect(h.feed.tradeExchange).toHaveBeenCalledTimes(1);
    expect(tab?.state).toBe("ready");
    if (isSearchResult(tab?.result)) throw new Error("expected an exchange result");
    expect(tab?.result?.offers).toHaveLength(4);
  });

  it("refuses without a spare search slot", async () => {
    const h = harness();
    h.budget.searchesSpare = 0;
    const state = h.service.openTab({ kind: "exchange", query: { have: ["divine"], want: ["exalted"] } });
    const tab = await h.service.exchange(state.activeTabId!);
    expect(tab?.error).toMatch(/search slot/);
    expect(h.feed.tradeExchange).not.toHaveBeenCalled();
  });
});

describe("favourites and tabs on disk", () => {
  it("persists favourites and reads them back on a new service", () => {
    const h = harness();
    const opened = h.service.openTab(searchDraft());
    h.service.favoriteSave({ tabId: opened.activeTabId!, name: "Rings" });
    const written = h.fs.files.get(path.join("C:/user", "market-favorites.json"));
    expect(written).toContain("Rings");

    const second = harness({}, Object.fromEntries(h.fs.files));
    expect(second.service.favoritesFile().favorites.map((favorite) => favorite.name)).toEqual(["Rings"]);
  });

  it("never writes listings into market-tabs.json", async () => {
    const h = harness();
    await readyTab(h);
    const written = h.fs.files.get(path.join("C:/user", "market-tabs.json")) ?? "";
    expect(written).toContain("Ruby Ring");
    expect(written).not.toContain("SellerOne");
    expect(written).not.toContain("whisper");
  });

  it("rehydrates saved tabs without results", () => {
    const h = harness();
    h.service.openTab(searchDraft("Sapphire Ring"));
    const second = harness({}, Object.fromEntries(h.fs.files));
    const state = second.service.state();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.state).toBe("idle");
    expect(state.tabs[0]!.resultCount).toBeUndefined();
  });

  it("marks a tab clean again after Update favourite", () => {
    const h = harness();
    const opened = h.service.openTab(searchDraft());
    const id = opened.activeTabId!;
    const saved = h.service.favoriteSave({ tabId: id, name: "Rings" });
    const favoriteId = saved.favorites.favorites[0]!.id;
    h.service.updateDraft(id, searchDraft("Sapphire Ring"));
    expect(h.service.state().tabs[0]!.dirty).toBe(true);
    const updated = h.service.favoriteSave({ tabId: id, favoriteId, fromTab: true });
    expect(h.service.state().tabs[0]!.dirty).toBe(false);
    expect(updated.favorites.favorites[0]!.draft).toEqual(searchDraft("Sapphire Ring"));
  });

  it("renames a favourite from the explorer, with no tab in play", () => {
    const h = harness();
    const opened = h.service.openTab(searchDraft());
    const saved = h.service.favoriteSave({ tabId: opened.activeTabId!, name: "Rings" });
    const favorite = saved.favorites.favorites[0]!;
    h.service.closeTab(opened.activeTabId!);
    const renamed = h.service.favoriteSave({ tabId: "", favoriteId: favorite.id, name: "Better name" });
    expect(renamed.favorites.favorites[0]).toMatchObject({ name: "Better name", draft: favorite.draft });
  });

  it("never captures the open tab's query when the explorer renames a favourite", () => {
    const h = harness();
    const first = h.service.openTab(searchDraft("Doom Loop"));
    const saved = h.service.favoriteSave({ tabId: first.activeTabId!, name: "Doom Loop", fromTab: true });
    const favorite = saved.favorites.favorites[0]!;
    // A different tab is open and active when the pencil is clicked.
    const second = h.service.openTab(searchDraft("Ruby Ring"));
    const renamed = h.service.favoriteSave({ tabId: "", favoriteId: favorite.id, name: "Better name" });
    expect(renamed.favorites.favorites[0]).toMatchObject({ name: "Better name", draft: favorite.draft });
    // …and the active tab is not silently re-pointed at that favourite.
    expect(renamed.tabs.find((tab) => tab.id === second.activeTabId)!.favoriteId).toBeUndefined();
  });

  it("ignores a stray tabId on an explorer rename", () => {
    const h = harness();
    const first = h.service.openTab(searchDraft("Doom Loop"));
    const saved = h.service.favoriteSave({ tabId: first.activeTabId!, name: "Doom Loop", fromTab: true });
    const favorite = saved.favorites.favorites[0]!;
    const second = h.service.openTab(searchDraft("Ruby Ring"));
    const renamed = h.service.favoriteSave({
      tabId: second.activeTabId!,
      favoriteId: favorite.id,
      name: "Renamed",
    });
    expect(renamed.favorites.favorites[0]!.draft).toEqual(favorite.draft);
  });

  it("opens a favourite as a temporary tab", () => {
    const h = harness();
    const opened = h.service.openTab(searchDraft());
    const saved = h.service.favoriteSave({ tabId: opened.activeTabId!, name: "Rings" });
    const favoriteId = saved.favorites.favorites[0]!.id;
    h.service.closeTab(opened.activeTabId!);
    const state = h.service.favoriteOpen(favoriteId);
    expect(state.tabs[0]!.temporary).toBe(true);
    expect(state.tabs[0]!.label).toBe("Rings");
  });
});

describe("import", () => {
  it("parses without touching the network and opens the chosen rows", () => {
    const h = harness();
    const result = h.service.importText(
      'https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur?q={"query":{"type":"Ruby Ring"}}',
    );
    expect(result.drafts).toHaveLength(1);
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
    const state = h.service.importOpen(result, [0]);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.label).toBe("Ruby Ring");
  });

  it("opens an id-only entry as its own tab", () => {
    const h = harness();
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    const state = h.service.importOpen(result, [0]);
    expect(state.tabs[0]!.label).toContain("id only");
  });

  it("refuses to search an id-only tab when the feed cannot ask by id", async () => {
    const h = harness();
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    const state = h.service.importOpen(result, [0]);
    const tab = await h.service.search(state.activeTabId!);
    expect(tab?.error).toMatch(/only carries a search id/);
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
  });

  it("asks the site by id when the feed offers it — never a fresh empty search", async () => {
    const h = harness();
    const byId = vi.fn(async () => ({
      id: "AbCdEfGh",
      total: 2,
      resultIds: ["ring-1", "ring-2"],
      league: LEAGUE,
      url: "https://trade",
      cached: false,
    }));
    (h.feed as unknown as { tradeSearchById: unknown }).tradeSearchById = byId;
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    const state = h.service.importOpen(result, [0]);
    const tab = await h.service.search(state.activeTabId!);
    expect(byId).toHaveBeenCalledWith(LEAGUE, "AbCdEfGh", expect.objectContaining({ reason: expect.any(String) }));
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
    expect(tab?.state).toBe("ready");
  });

  it("still refuses a bogus search after a restart", async () => {
    const h = harness();
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    h.service.importOpen(result, [0]);

    const second = harness({}, Object.fromEntries(h.fs.files));
    const state = second.service.state();
    expect(state.tabs[0]!.idOnly).toBe(true);
    const tab = await second.service.search(state.activeTabId!);
    expect(tab?.error).toMatch(/only carries a search id/);
    expect(second.feed.tradeSearch).not.toHaveBeenCalled();
  });

  it("turns an edited share-link tab into a normal search", async () => {
    const h = harness();
    const byId = vi.fn();
    (h.feed as unknown as { tradeSearchById: unknown }).tradeSearchById = byId;
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    const state = h.service.importOpen(result, [0]);
    const id = state.activeTabId!;
    h.service.updateDraft(id, searchDraft("Ruby Ring"));
    expect(h.service.state().tabs[0]!.idOnly).toBeUndefined();
    await h.service.search(id);
    expect(byId).not.toHaveBeenCalled();
    expect(h.feed.tradeSearch).toHaveBeenCalledTimes(1);
  });

  it("watches an id-only tab without spending a search", () => {
    const h = harness();
    const result = h.service.importText("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbCdEfGh");
    const state = h.service.importOpen(result, [0]);
    const live = h.service.liveStart({ tabId: state.activeTabId! });
    expect(live.live).toHaveLength(1);
    expect(live.live[0]!.handle.searchId).toBe("AbCdEfGh");
    expect(h.feed.tradeSearch).not.toHaveBeenCalled();
  });
});

describe("live search", () => {
  it("needs a searched tab", () => {
    const h = harness();
    const opened = h.service.openTab(searchDraft());
    const state = h.service.liveStart({ tabId: opened.activeTabId! });
    expect(state.lastError).toMatch(/Search this tab first/);
    expect(h.live.start).not.toHaveBeenCalled();
  });

  it("needs a session cookie", async () => {
    const h = harness();
    (h.feed as unknown as { hasSession: () => boolean }).hasSession = () => false;
    const id = await readyTab(h);
    const state = h.service.liveStart({ tabId: id });
    expect(state.lastError).toMatch(/POESESSID/);
  });

  it("starts, forwards listings, caps the rows and persists the definition", async () => {
    const h = harness();
    const id = await readyTab(h);
    const state = h.service.liveStart({ tabId: id });
    expect(h.live.start).toHaveBeenCalledTimes(1);
    expect(state.live).toHaveLength(1);
    const liveId = state.live[0]!.id;
    const sinks = h.live.handlers.get(state.live[0]!.handle.id)!;
    for (let index = 0; index < 60; index += 1) {
      sinks.onListing({ ...ROWS[0]!, id: `live-${index}` });
    }
    const after = h.service.state().live[0]!;
    expect(after.results).toHaveLength(50);
    expect(after.results[0]!.id).toBe("live-59");
    expect(after.unread).toBe(60);
    expect(h.emit.mock.calls.some(([channel]) => channel === "market:live-listing")).toBe(true);
    expect(h.fs.files.get(path.join("C:/user", "market-live-searches.json"))).toContain("SID");
    expect(h.service.liveSeen(liveId).live[0]!.unread).toBe(0);
    expect(h.service.liveClear(liveId).live[0]!.results).toEqual([]);
  });

  it("notifies only when the toggle is on", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.service.liveStart({ tabId: id, notify: false });
    const handle = h.service.state().live[0]!.handle.id;
    h.live.handlers.get(handle)!.onListing(ROWS[0]!);
    expect(h.notify).not.toHaveBeenCalled();
    h.service.liveSet(h.service.state().live[0]!.id, { notify: true });
    h.live.handlers.get(handle)!.onListing(ROWS[1]!);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("mirrors the handle state, including a budget skip", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.service.liveStart({ tabId: id });
    const handle = h.service.state().live[0]!.handle;
    h.live.handlers.get(handle.id)!.onState({
      ...handle,
      state: "error",
      error: "trade2 rate limited — live searches stopped",
      skippedResults: 7,
    });
    const view = h.service.state().live[0]!;
    expect(view.handle.state).toBe("error");
    expect(view.handle.skippedResults).toBe(7);
  });

  it("stops one search and every search on dispose", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.service.liveStart({ tabId: id });
    const liveId = h.service.state().live[0]!.id;
    expect(h.service.liveStop(liveId).live).toEqual([]);
    h.service.liveStart({ tabId: id });
    h.service.dispose();
    expect(h.live.stop).toHaveBeenCalledTimes(2);
  });

  it("stops a search that has been open past the limit", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.service.liveStart({ tabId: id });
    const later = new Date(CLOCK.getTime() + 7 * 3_600_000);
    (h.service as unknown as { deps: { now: () => Date } }).deps.now = () => later;
    h.emit.mockClear();
    h.service.pruneLiveSearches();
    expect(h.service.state().live).toEqual([]);
    expect(h.service.state().lastError).toMatch(/stopped after 6 h/);
    // The timer is the only caller: without this the column would keep
    // listing a socket that is already closed.
    const announced = h.emit.mock.calls.find(([channel]) => channel === "market:state");
    expect(announced).toBeDefined();
    expect((announced![1] as MarketStateView).live).toEqual([]);
  });

  it("resumes saved searches only when the setting is on", async () => {
    const h = harness();
    const id = await readyTab(h);
    h.service.liveStart({ tabId: id });
    const files = Object.fromEntries(h.fs.files);

    const off = harness({}, files);
    off.service.resumeLiveSearches();
    expect(off.live.start).not.toHaveBeenCalled();

    const on = harness({}, files);
    on.settings.resumeLiveSearches = true;
    on.service.resumeLiveSearches();
    expect(on.live.start).toHaveBeenCalledTimes(1);
    expect(on.service.state().live).toHaveLength(1);
  });
});

describe("listing actions", () => {
  it("copies a whisper to the clipboard", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "copy-whisper", tabId, listingId: "ring-1" });
    expect(outcome.ok).toBe(true);
    expect(h.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("@OneChar"));
    expect(h.chat.send).not.toHaveBeenCalled();
  });

  it("sends one chat line with the Market source and the focus hand-off", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "send-whisper", tabId, listingId: "ring-1" });
    expect(outcome.ok).toBe(true);
    expect(h.chat.send).toHaveBeenCalledTimes(1);
    expect(h.chat.send.mock.calls[0]![0]).toMatchObject({ source: "market", focus: true });
    expect(h.chat.send.mock.calls[0]![0].reason).toContain("ring-1");
  });

  it("collapses the seller after a real send, but not after a dry run", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    await h.service.listingAction({ action: "send-whisper", tabId, listingId: "ring-1" });
    const collapsed = h.service.tab(tabId)!;
    if (!isSearchResult(collapsed.result)) throw new Error("expected a search result");
    expect(collapsed.result.collapsedAccounts).toEqual(["SellerOne"]);

    const dry = harness();
    dry.chat.send.mockResolvedValue({ ok: true, dryRun: true, sent: "…", at: CLOCK.toISOString() });
    const dryTab = await readyTab(dry);
    const outcome = await dry.service.listingAction({ action: "send-whisper", tabId: dryTab, listingId: "ring-1" });
    expect(outcome.dryRun).toBe(true);
    const tab = dry.service.tab(dryTab)!;
    if (!isSearchResult(tab.result)) throw new Error("expected a search result");
    expect(tab.result.collapsedAccounts).toEqual([]);
  });

  it("never whispers a secure listing", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "send-whisper", tabId, listingId: "ring-5" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/trade site/);
    expect(h.chat.send).not.toHaveBeenCalled();
  });

  it("refuses /hideout when the row names no character", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "hideout", tabId, listingId: "ring-4" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/character name/);
    expect(h.chat.send).not.toHaveBeenCalled();
  });

  it("sends /hideout as its own gesture", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    await h.service.listingAction({ action: "hideout", tabId, listingId: "ring-1" });
    expect(h.chat.send.mock.calls[0]![0].text).toBe("/hideout OneChar");
  });

  it("copies the stash price note", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "copy-price-note", tabId, listingId: "ring-1" });
    expect(outcome.copied).toBe("~price 5 exalted");
  });

  it("turns a listing's mods into filters", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    const outcome = await h.service.listingAction({ action: "copy-stats", tabId, listingId: "ring-1" });
    expect(outcome.ok).toBe(true);
    expect(outcome.statGroups?.[0]?.filters?.[0]).toMatchObject({ id: "explicit.stat_3299347043" });
  });

  it("opens the trade site for the tab's own search", async () => {
    const h = harness();
    const tabId = await readyTab(h);
    await h.service.listingAction({ action: "open-site", tabId, listingId: "ring-1" });
    expect(h.openExternal).toHaveBeenCalledWith(expect.stringContaining("/trade2/search/poe2/"));
  });

  it("says so when the row is gone", async () => {
    const h = harness();
    const outcome = await h.service.listingAction({ action: "copy-whisper", listingId: "nope" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no longer loaded/);
  });
});

describe("catalogues and state", () => {
  it("indexes the stats payload once and reports readiness", async () => {
    const h = harness();
    expect(h.service.state().statsReady).toBe(false);
    const options = await h.service.statOptions();
    expect(options.length).toBeGreaterThan(50);
    expect(await h.service.statOptions()).toBe(options);
    expect(h.service.state().statsReady).toBe(true);
  });

  it("falls back to the curated currency list when the static endpoint is silent", async () => {
    const h = harness();
    const options = await h.service.currencyOptions();
    expect(options.find((option) => option.id === "divine")?.label).toBe("Divine Orb");
  });

  it("prefers the trade2 static payload when the feed offers one", async () => {
    const h = harness();
    (h.feed as unknown as { fetchStatic: () => Promise<unknown> }).fetchStatic = async () => [
      { id: "Currency", label: "Currency", entries: [{ id: "onlyone", text: "Only One" }] },
    ];
    const options = await h.service.currencyOptions();
    expect(options.map((option) => option.id)).toEqual(["onlyone"]);
  });

  it("resolves weighted templates against the catalogue", async () => {
    const h = harness();
    const templates = await h.service.weightTemplates();
    const res = templates.find((template) => template.id === "total-elemental-res");
    expect(res?.resolved).toBe(true);
    expect(res?.filters[0]?.id).toMatch(/^explicit\./);
    // The catalogue subset carries the minion stats since 2026-09-14 (build-demand
    // families), so the bundle resolves; a template whose text is absent stays
    // unresolved — checked by pointing one at a text the subset lacks.
    const minion = templates.find((template) => template.id === "minion-bundle");
    expect(minion?.resolved).toBe(true);
    expect(minion?.filters.every((filter) => /^explicit\./.test(filter.id))).toBe(true);
  });

  it("publishes the rates behind the ≈ figures", () => {
    const state = harness().service.state();
    const divine = state.currencyRates.find((rate) => rate.id === "divine");
    expect(divine).toMatchObject({ exalted: 404.62, fromTable: true });
    expect(state.feedAgeHours).toBe(2);
  });

  it("rebuilds the rate rows only when the price table changes", () => {
    let table = priceTable();
    const h = harness({ priceTable: () => table });
    const first = h.service.state().currencyRates;
    expect(h.service.state().currencyRates).toBe(first);
    table = priceTable();
    expect(h.service.state().currencyRates).not.toBe(first);
  });

  it("never leaks the cookie, only whether one is set", async () => {
    const h = harness();
    const state = h.service.state();
    expect(state.hasSession).toBe(true);
    expect(JSON.stringify(state)).not.toContain("POESESSID");
  });

  it("emits market:state after a tab change", () => {
    const h = harness();
    h.service.openTab(searchDraft());
    expect(h.emit.mock.calls.some(([channel]) => channel === "market:state")).toBe(true);
  });

  it("seeds a new tab from the Market defaults, so the builder shows what will be sent", async () => {
    const h = harness();
    h.settings.defaultStatus = "any";
    h.settings.defaultInstantBuyout = true;
    const state = h.service.newSearchTab();
    const tab = h.service.tab(state.activeTabId!)!;
    if (tab.draft.kind !== "search") throw new Error("expected a search draft");
    expect(tab.draft.query.status).toBe("any");
    expect(tab.draft.query.trade?.sale_type).toBe("priced_with_price");
    expect(tab.draft.query.sort).toEqual({ key: "price", direction: "asc" });
    await h.service.search(state.activeTabId!);
    const body = h.feed.tradeSearch.mock.calls[0]![0] as { query: { status?: unknown } };
    expect(body.query.status).toEqual({ option: "any" });
  });

  it("seeds a new exchange tab with the online default", () => {
    const h = harness();
    const state = h.service.newExchangeTab();
    const tab = h.service.tab(state.activeTabId!)!;
    if (tab.draft.kind !== "exchange") throw new Error("expected an exchange draft");
    expect(tab.draft.query.status).toBe("online");
  });

  it("surfaces favourites the file sanitizer dropped, at startup", () => {
    const junk = JSON.parse(
      readFileSync(path.join(process.cwd(), "fixtures", "market", "favorites-junk.json"), "utf8"),
    ) as unknown;
    const h = harness({}, { [path.join("C:/user", "market-favorites.json")]: JSON.stringify(junk) });
    expect(h.service.state().fileIssues.length).toBeGreaterThan(0);
  });

  it("reports a refused tab past the cap", () => {
    const h = harness();
    for (let index = 0; index < 10; index += 1) {
      const state = h.service.openTab(searchDraft(`Ring ${index}`));
      h.service.updateDraft(state.activeTabId!, searchDraft(`Edited ${index}`));
    }
    const state = h.service.openTab(searchDraft("one too many"));
    expect(state.lastError).toMatch(/Close a tab first/);
    expect(state.tabs).toHaveLength(10);
  });
});
