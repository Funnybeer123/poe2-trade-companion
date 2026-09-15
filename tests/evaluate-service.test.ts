import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { TrendSeries } from "../src/core/priceTrends.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { emptyLearnedTiers, type LearnedTiers } from "../src/core/tierLearning.js";
import { parseTradeListings, type TradeListing } from "../src/core/tradeListings.js";
import { parseExchangeResult } from "../src/core/tradeListings.js";
import type { TierVerdict } from "../src/core/valueTiers.js";
import { DEFAULT_EVALUATE_SETTINGS, type EvaluateSession, type EvaluateSettings } from "../src/shared/evaluate.js";
import type { ChatCopyOutcome } from "../src/shared/chatCommands.js";
import {
  EvaluateService,
  type EvaluateItemIntelligence,
  type EvaluateMarketTrends,
  type EvaluatePriceFeed,
  type EvaluateWatchlist,
} from "../src/main/features/evaluate/service.js";

const STATS = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
) as unknown;

const CATALOGUE = buildStatCatalogue(STATS, MOD_FAMILIES, ["explicit", "pseudo"]);

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8");
}

function json(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8")) as unknown;
}

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [{ id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 400 }],
};

const LISTINGS: TradeListing[] = parseTradeListings(json("fetch-rare-ring.json"), "Runes of Aldur", {
  priceTable: TABLE,
});

const SERIES: TrendSeries[] = [
  {
    key: "feed:poe2scout:divine",
    name: "Divine Orb",
    current: 410,
    points: [
      { time: "2026-09-05T00:00:00Z", price: 395, quantity: 120 },
      { time: "2026-09-06T00:00:00Z", price: 402, quantity: 130 },
      { time: "2026-09-07T00:00:00Z", price: 410, quantity: 140 },
    ],
  },
];

const NOW = new Date("2026-09-07T12:00:00Z");

function harness(overrides: { settings?: Partial<EvaluateSettings> } = {}) {
  const budget = {
    lookups: 5,
    searchesSpare: 5,
    fetchesSpare: 5,
    restrictedUntilIso: undefined as string | undefined,
  };
  const status = {
    resolvedLeague: "Runes of Aldur",
    leagueAmbiguous: false,
  };
  const tradeSearch = vi.fn(async (_body: Record<string, unknown>, _opts: { reason: string }) => ({
    id: "search-1",
    total: 42,
    resultIds: Array.from({ length: 14 }, (_, index) => `id-${index}`),
    league: "Runes of Aldur",
    url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-1",
    cached: false,
  }));
  const tradeFetch = vi.fn(async (ids: string[]) => LISTINGS.slice(0, Math.min(ids.length, LISTINGS.length)));
  const tradeExchange = vi.fn(async (_body: Record<string, unknown>, _opts: { reason: string }) => {
    const parsed = parseExchangeResult(json("exchange-divine.json"), "Runes of Aldur");
    return {
      id: parsed.id,
      total: parsed.total,
      offers: parsed.offers,
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/exchange/poe2/Runes%20of%20Aldur/ex-eval-1",
    };
  });
  const fetchStatic = vi.fn(async () => ({
    result: [{ id: "Currency", entries: [{ id: "vault-key", text: "Vault Key" }] }],
  }));
  const statCatalogue = vi.fn(async () => CATALOGUE);
  const statsPayloadCached = vi.fn<() => unknown>(() => undefined);
  let learned: LearnedTiers = emptyLearnedTiers();
  const priceFeed = {
    tradeSearch,
    tradeFetch,
    tradeExchange,
    fetchStatic,
    tradeBudget: () => ({ ...budget }),
    hasSession: () => false,
    statCatalogue,
    statsPayloadCached,
    learnedTiers: () => learned,
    status: () => ({ ...status }),
  } as unknown as EvaluatePriceFeed;

  let verdict: TierVerdict = { tier: "sell", source: "heuristic", reasons: [], matchedRules: [] };
  const itemIntelligence = {
    getPriceTable: () => TABLE,
    evaluateTier: vi.fn(() => verdict),
  } as unknown as EvaluateItemIntelligence;

  const marketTrends = {
    series: vi.fn(async () => ({
      ok: true,
      league: "Runes of Aldur",
      fetchedAt: "2026-09-07T11:00:00Z",
      stale: false,
      refreshing: false,
      source: "cache" as const,
      categories: [],
      trends: [],
      series: SERIES,
    })),
  } as unknown as EvaluateMarketTrends;

  const save = vi.fn((payload: unknown) => payload);
  const watchlist = {
    overview: () => ({ watches: [] }),
    save,
  } as unknown as EvaluateWatchlist;

  const clipboard = { readText: vi.fn(() => ""), writeText: vi.fn() };
  const openExternal = vi.fn(async () => undefined);
  const capture = vi.fn<() => Promise<ChatCopyOutcome>>(async () => ({
    ok: true,
    dryRun: false,
    at: NOW.toISOString(),
    text: fixture("rare-ring-resists.txt"),
  }));
  const sessions: EvaluateSession[] = [];
  let clock = NOW.getTime();

  const service = new EvaluateService({
    priceFeed,
    itemIntelligence,
    marketTrends,
    watchlist,
    settings: () => ({ ...DEFAULT_EVALUATE_SETTINGS, ...overrides.settings }),
    clipboard,
    openExternal,
    capture,
    onSession: (session) => sessions.push(session),
    now: () => new Date(clock),
  });

  return {
    service,
    budget,
    status,
    tradeSearch,
    tradeFetch,
    tradeExchange,
    fetchStatic,
    statCatalogue,
    statsPayloadCached,
    clipboard,
    openExternal,
    capture,
    save,
    sessions,
    setVerdict: (next: TierVerdict) => { verdict = next; },
    setLearnedTiers: (store: LearnedTiers) => {
      learned = store;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function isSession(value: unknown): value is EvaluateSession {
  return typeof (value as EvaluateSession).id === "string";
}

function trainedVerdict(amount = 1, status: "matched" | "stale" | "conflict" = "matched"): TierVerdict {
  return { tier: "keep", source: "training", reasons: [], matchedRules: [], training: {
    status, matchKind: "exact", amount, low: amount, high: amount, currency: "divine",
    confidence: status === "matched" ? 40 : 0, exampleCount: 1,
    lessonIds: ["lesson-1"], fingerprint: "item", groupKey: "ring", reasons: ["Saved item correction"],
  } };
}

describe("EvaluateService learned prices stay local", () => {
  it.each([false, true])("shows the saved divine price immediately with auto-search enabled (cached stats: %s)", async (cached) => {
    const rig = harness();
    rig.setVerdict(trainedVerdict());
    if (cached) rig.statsPayloadCached.mockReturnValue(STATS);
    const opened = await rig.service.open({ source: "hotkey", autoSearch: true });
    expect(isSession(opened)).toBe(true);
    if (!isSession(opened)) return;
    expect(opened.localEstimate).toMatchObject({ sampleSize: 0, candidateCount: 0,
      valuation: { providerName: "price-training", fair: 1, currency: "divine" } });
    expect(opened.results).toBeUndefined();
    expect(opened.busy).toBe("idle");
    expect(opened.catalogueReady).toBe(cached);
    await rig.service.whenSettled(opened.id);
    for (const request of [rig.statCatalogue, rig.fetchStatic, rig.tradeSearch, rig.tradeFetch, rig.tradeExchange]) {
      expect(request).not.toHaveBeenCalled();
    }
    expect(rig.statsPayloadCached).toHaveBeenCalledTimes(1);
  });

  it.each(["stale", "conflict"] as const)("shows a local review warning for %s examples without an automatic lookup", async (status) => {
    const rig = harness();
    rig.setVerdict(trainedVerdict(1, status));
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    expect(isSession(opened)).toBe(true);
    if (!isSession(opened)) return;
    expect(opened.localEstimate?.valuation.lowConfidenceReason).toContain("need review; no current quote");
    expect(opened.localEstimate?.valuation.providerName).toBe("none");
    await rig.service.whenSettled(opened.id);
    for (const request of [rig.statCatalogue, rig.fetchStatic, rig.tradeSearch, rig.tradeFetch, rig.tradeExchange]) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("does not fetch static currency metadata for a saved stackable price", async () => {
    const rig = harness();
    rig.setVerdict(trainedVerdict());
    const key = "Item Class: Keys\nRarity: Currency\nVault Key\n--------\nStack Size: 2/10\n--------\nOpens a vault.";
    const opened = await rig.service.open({ text: key, source: "paste", autoSearch: true });
    expect(isSession(opened) && opened.localEstimate?.valuation.fair).toBe(1);
    expect(rig.fetchStatic).not.toHaveBeenCalled();
    expect(rig.statCatalogue).not.toHaveBeenCalled();
    expect(rig.tradeExchange).not.toHaveBeenCalled();
  });

  it("keeps explicit Search available and rereads a correction after editing or removing it", async () => {
    const rig = harness();
    rig.setVerdict(trainedVerdict());
    const input = { text: fixture("rare-ring-resists.txt"), source: "paste" as const };
    const first = await rig.service.open(input);
    if (!isSession(first)) throw new Error("Expected a session");
    await rig.service.search(first.id, first.query);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    expect(rig.tradeFetch).toHaveBeenCalledTimes(1);
    rig.setVerdict(trainedVerdict(2));
    rig.advance(600);
    const edited = await rig.service.open(input);
    if (!isSession(edited)) throw new Error("Expected a session");
    expect(edited.localEstimate?.valuation.fair).toBe(2);
    expect(edited.results).toBeUndefined();
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    rig.setVerdict({ tier: "sell", source: "heuristic", reasons: [], matchedRules: [] });
    const removed = await rig.service.open({ ...input, autoSearch: false });
    expect(isSession(removed) && removed.localEstimate).toBeUndefined();
    expect(rig.statCatalogue).toHaveBeenCalledTimes(1);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
  });
});

describe("EvaluateService.open", () => {
  let rig: ReturnType<typeof harness>;

  beforeEach(() => {
    rig = harness();
  });

  it("builds a session from text without touching the network when auto-search is off", async () => {
    const result = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "item-log",
      autoSearch: false,
    });
    expect(isSession(result)).toBe(true);
    if (!isSession(result)) return;
    expect(result.item.kind).toBe("rare");
    expect(result.query.rows.some((row) => row.enabled)).toBe(true);
    expect(result.catalogueReady).toBe(true);
    expect(result.results).toBeUndefined();
    expect(rig.tradeSearch).not.toHaveBeenCalled();
    expect(rig.sessions.length).toBeGreaterThan(0);
  });

  it("refuses text that is not an item copy, and an empty clipboard", async () => {
    const notItem = await rig.service.open({ text: "hello there", source: "paste" });
    expect(notItem).toEqual({
      error: "That does not look like a Path of Exile item copy.",
      reason: "not-item-text",
    });
    const empty = await rig.service.open({ source: "clipboard" });
    expect(empty).toMatchObject({ reason: "empty" });
  });

  it("asks the chat-commands service for one Ctrl+C on a hotkey press", async () => {
    const result = await rig.service.open({ source: "hotkey", autoSearch: false });
    expect(rig.capture).toHaveBeenCalledTimes(1);
    expect(isSession(result) && result.capture).toEqual({
      status: "copied",
      reason: "Copied with one Ctrl+C.",
    });
  });

  it("ignores a repeated hotkey press inside the debounce window", async () => {
    await rig.service.open({ source: "hotkey", autoSearch: false });
    const again = await rig.service.open({ source: "hotkey", autoSearch: false });
    expect(again).toMatchObject({ reason: "blocked" });
    expect(rig.capture).toHaveBeenCalledTimes(1);
    rig.advance(600);
    await rig.service.open({ source: "hotkey", autoSearch: false });
    expect(rig.capture).toHaveBeenCalledTimes(2);
  });

  it("explains a blocked capture in the user's terms", async () => {
    rig.capture.mockResolvedValueOnce({
      ok: false,
      dryRun: false,
      at: NOW.toISOString(),
      blockedBy: "not-foreground",
    });
    const result = await rig.service.open({ source: "hotkey" });
    expect(result).toMatchObject({ reason: "blocked" });
    expect((result as { error: string }).error).toContain("foreground window");
  });

  it("reads the clipboard instead of sending input in dry-run", async () => {
    rig.capture.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      at: NOW.toISOString(),
      text: fixture("rare-ring-resists.txt"),
    });
    const result = await rig.service.open({ source: "hotkey", autoSearch: false });
    expect(isSession(result) && result.capture?.status).toBe("dry-run");
    expect(isSession(result) && result.capture?.reason).toContain("lookups still run");
  });

  it("re-shows the same item inside the search cache instead of spending a second lookup", async () => {
    const first = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(first)) return;
    await rig.service.whenSettled(first.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    rig.advance(5_000);
    const second = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    expect(isSession(second) && first.id === second.id).toBe(true);
    // Past the cache window the next press searches again.
    rig.advance(70_000);
    await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    expect(rig.tradeSearch).toHaveBeenCalledTimes(2);
  });

  it("attaches the cached price history without fetching anything", async () => {
    const result = await rig.service.open({ text: fixture("currency-divine.txt"), source: "paste", autoSearch: false });
    expect(isSession(result) && result.history?.points).toHaveLength(3);
    expect(isSession(result) && result.history?.stale).toBe(false);
  });
});

describe("EvaluateService.search", () => {
  it("spends exactly one search and one fetch, and keeps the rest for paging", async () => {
    const rig = harness();
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    expect(isSession(opened)).toBe(true);
    if (!isSession(opened)) return;
    // The panel is handed the session first; the lookup lands afterwards.
    expect(opened.results).toBeUndefined();
    await rig.service.whenSettled(opened.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    expect(rig.tradeFetch).toHaveBeenCalledTimes(1);
    expect(rig.tradeFetch.mock.calls[0]![0]).toHaveLength(10);
    expect(rig.tradeSearch.mock.calls[0]![1]).toMatchObject({ reason: `evaluate:${opened.id}` });
    const results = opened.results!;
    expect(results.total).toBe(42);
    expect(results.fetched).toBe(LISTINGS.length);
    expect(results.remainingIds).toBe(4);
    expect(results.queryUrl).toContain("pathofexile.com/trade2/search/poe2");
    expect(results.estimate.sampleSize).toBeGreaterThan(0);
  });

  it("pages with a second fetch and never a second search", async () => {
    const rig = harness();
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(opened)) return;
    await rig.service.whenSettled(opened.id);
    const more = await rig.service.more(opened.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    expect(rig.tradeFetch).toHaveBeenCalledTimes(2);
    expect(more.results!.remainingIds).toBe(0);
    const exhausted = await rig.service.more(opened.id);
    expect(exhausted.error).toContain("Nothing left");
  });

  it("sends nothing inside a penalty window and says when it lifts", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    rig.budget.restrictedUntilIso = "2026-09-07T12:10:00Z";
    const failed = await rig.service.search(opened.id, opened.query);
    expect(rig.tradeSearch).not.toHaveBeenCalled();
    expect(failed.error).toContain("rate limited");
  });

  it("refuses to price while two leagues are live", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    rig.status.leagueAmbiguous = true;
    const failed = await rig.service.search(opened.id, opened.query);
    expect(rig.tradeSearch).not.toHaveBeenCalled();
    expect(failed.error).toContain("pin one");
  });

  it("stores a complexity refusal and does not fetch", async () => {
    const rig = harness();
    rig.tradeSearch.mockResolvedValueOnce({
      id: "search-2",
      total: 0,
      resultIds: [],
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-2",
      cached: false,
      complexityError: "too complex",
    } as Awaited<ReturnType<typeof rig.tradeSearch>>);
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(opened)) return;
    await rig.service.whenSettled(opened.id);
    expect(rig.tradeFetch).not.toHaveBeenCalled();
    expect(opened.results?.complexityError).toBeTruthy();
    expect(opened.results?.rows).toEqual([]);
  });
});

describe("EvaluateService currency, copy, watch and profiles", () => {
  it("asks the bulk exchange for a stackable, quoting exalted per unit", async () => {
    const rig = harness();
    const opened = await rig.service.open({ text: fixture("currency-divine.txt"), source: "paste" });
    if (!isSession(opened)) return;
    await rig.service.whenSettled(opened.id);
    expect(rig.tradeExchange).toHaveBeenCalledTimes(1);
    expect(rig.tradeSearch).not.toHaveBeenCalled();
    const body = rig.tradeExchange.mock.calls[0]![0] as { query: { have: string[]; want: string[] } };
    expect(body.query.have).toEqual(["exalted"]);
    expect(body.query.want).toEqual(["divine"]);
    if (!isSession(opened)) return;
    expect(opened.exchange?.bestAskQuoted).toBe(400);
    expect(opened.exchange?.quoteCurrency).toBe("exalted");
  });

  it("refuses the exchange inside a penalty window (it spends a search slot)", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("currency-divine.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    rig.budget.restrictedUntilIso = "2026-09-07T12:10:00Z";
    const blocked = await rig.service.exchange(opened.id);
    expect(rig.tradeExchange).not.toHaveBeenCalled();
    expect(blocked.error).toContain("rate limited");

    rig.budget.restrictedUntilIso = undefined;
    rig.budget.searchesSpare = 0;
    const noSlot = await rig.service.exchange(opened.id);
    expect(rig.tradeExchange).not.toHaveBeenCalled();
    expect(noSlot.error).toContain("No spare trade2 search");
  });

  it("finds an exchange id in /data/static for a stackable the currency table misses", async () => {
    const rig = harness();
    const key = [
      "Item Class: Keys",
      "Rarity: Currency",
      "Vault Key",
      "--------",
      "Stack Size: 2/10",
      "--------",
      "Opens a vault.",
    ].join("\n");
    const opened = await rig.service.open({ text: key, source: "paste", autoSearch: false });
    if (!isSession(opened)) return;
    expect(opened.item.kind).toBe("currency");
    expect(opened.item.currencyId).toBe("vault-key");
    // The known currencies never reach /data/static.
    await rig.service.open({ text: fixture("currency-divine.txt"), source: "paste", autoSearch: false });
    expect(rig.fetchStatic).toHaveBeenCalledTimes(1);
  });

  it("says so instead of guessing when no exchange id is known", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    const refused = await rig.service.exchange(opened.id);
    expect(rig.tradeExchange).not.toHaveBeenCalled();
    expect(refused.error).toContain("No bulk-exchange id");
  });

  it("copies notes, whispers, the item text and the query URL — and nothing else", async () => {
    const rig = harness();
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(opened)) return;
    await rig.service.whenSettled(opened.id);
    const listingId = opened.results!.rows[0]!.id;
    expect(rig.service.copy(opened.id, { kind: "note", listingId })).toEqual({
      ok: true,
      text: "~price 5 exalted",
    });
    expect(rig.service.copy(opened.id, { kind: "b/o", listingId }).text).toBe("~b/o 5 exalted");
    expect(rig.service.copy(opened.id, { kind: "whisper", listingId }).text).toContain("@SellerA");
    expect(rig.service.copy(opened.id, { kind: "item" }).text).toContain("Item Class: Rings");
    expect(rig.service.copy(opened.id, { kind: "query-url" }).text).toContain("?q=");
    expect(rig.service.copy(opened.id, { kind: "note" })).toMatchObject({ ok: false });
    expect(rig.clipboard.writeText).toHaveBeenCalledTimes(5);
  });

  it("opens the trade site only on request", async () => {
    const rig = harness();
    const opened = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(opened)) return;
    await rig.service.whenSettled(opened.id);
    expect(rig.openExternal).not.toHaveBeenCalled();
    const result = await rig.service.openSite(opened.id);
    expect(result.ok).toBe(true);
    expect(rig.openExternal).toHaveBeenCalledWith(opened.results!.url);
  });

  it("hands the item to the Deals watchlist", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    const outcome = rig.service.watch(opened.id);
    expect(outcome.ok).toBe(true);
    const payload = rig.save.mock.calls[0]![0] as { watches: Array<{ id: string; query: unknown }> };
    expect(payload.watches).toHaveLength(1);
    expect(payload.watches[0]!.id).toBe(outcome.watchId);
  });

  it("rebuilds the rows for another profile without a request", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    const exact = rig.service.setProfile(opened.id, "exact-match");
    expect(exact.query.profile).toBe("exact-match");
    expect(exact.query.rows.filter((row) => row.enabled).length).toBeGreaterThan(1);
    expect(rig.tradeSearch).not.toHaveBeenCalled();
  });

  it("keeps at most five sessions and always knows the current one", async () => {
    const rig = harness();
    for (let index = 0; index < 7; index += 1) {
      rig.advance(70_000);
      await rig.service.open({
        text: fixture("rare-ring-resists.txt").replace("Woe Loop", `Woe Loop ${index}`),
        source: "paste",
        autoSearch: false,
      });
    }
    const current = rig.service.current();
    expect(current?.item.name).toBe("Woe Loop 6");
    // The sixth open dropped the first session.
    expect(() => rig.service.copy("ev_missing", { kind: "item" })).toThrow(/unknown evaluate session/);
  });

  it("stops announcing after dispose", async () => {
    const rig = harness();
    await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste", autoSearch: false });
    const before = rig.sessions.length;
    rig.service.dispose();
    expect(rig.service.current()).toBeNull();
    expect(rig.sessions.length).toBe(before);
  });
});

describe("EvaluateService one gesture, one lookup", () => {
  it("debounces a repeated hotkey press in clipboard-only capture mode too", async () => {
    const rig = harness({ settings: { captureMode: "clipboard-only" } });
    rig.clipboard.readText.mockReturnValue(fixture("rare-ring-resists.txt"));
    const first = await rig.service.open({ source: "hotkey" });
    expect(isSession(first)).toBe(true);
    const repeat = await rig.service.open({ source: "hotkey" });
    expect(repeat).toMatchObject({ reason: "blocked" });
    expect(rig.clipboard.readText).toHaveBeenCalledTimes(1);
    if (!isSession(first)) return;
    await rig.service.whenSettled(first.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
  });

  it("re-shows the session while its first search is still in flight", async () => {
    const rig = harness();
    let release = (): void => undefined;
    rig.tradeSearch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        id: "search-1",
        total: 1,
        resultIds: ["id-0"],
        league: "Runes of Aldur",
        url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-1",
        cached: false,
      };
    });
    const first = await rig.service.open({ source: "hotkey" });
    if (!isSession(first)) return;
    expect(first.busy).toBe("searching");
    // Past the debounce, but the first answer has not arrived yet.
    rig.advance(600);
    const second = await rig.service.open({ source: "hotkey" });
    expect(isSession(second) && second.id).toBe(first.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
    release();
    await rig.service.whenSettled(first.id);
    expect(rig.tradeSearch).toHaveBeenCalledTimes(1);
  });

  it("shows the panel before the auto-search answers, and says it is capturing", async () => {
    const rig = harness();
    const first = await rig.service.open({ text: fixture("rare-ring-resists.txt"), source: "paste" });
    if (!isSession(first)) return;
    await rig.service.whenSettled(first.id);
    rig.advance(600);
    const before = rig.sessions.length;
    const capture = rig.service.open({ source: "hotkey", autoSearch: false });
    // The capture is in flight: the open session already says so.
    expect(rig.sessions.slice(before).some((entry) => entry.busy === "capturing")).toBe(true);
    await capture;
    expect(rig.service.current()?.busy).toBe("idle");
  });
});

describe("EvaluateService estimates stay estimates", () => {
  it("carries an exchange/feed divergence as a caution, not as an error", async () => {
    const rig = harness();
    const opened = await rig.service.open({
      text: fixture("currency-divine.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    const after = await rig.service.exchange(opened.id);
    // The fixture medians 410 against a feed price of 400: inside 25 %.
    expect(after.error).toBeUndefined();
    expect(after.exchange?.caution).toBeUndefined();
    expect(after.exchange?.medianAskQuoted).toBe(410);

    const wide = harness();
    wide.tradeExchange.mockImplementationOnce(async () => ({
      id: "ex-2",
      total: 1,
      offers: [
        {
          id: "offer-wide",
          seller: { account: "SellerZ", online: true },
          have: { amount: 900, currency: "exalted" },
          want: { amount: 1, currency: "divine" },
          stock: 3,
          ratio: 900,
        },
      ],
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/exchange/poe2/Runes%20of%20Aldur/ex-2",
    }));
    const currency = await wide.service.open({
      text: fixture("currency-divine.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(currency)) return;
    const diverged = await wide.service.exchange(currency.id);
    expect(diverged.error).toBeUndefined();
    expect(diverged.exchange?.caution).toContain("disagree by more than 25 %");
  });

  it("keeps the learned tier badges across a profile switch", async () => {
    const rig = harness();
    const probe = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(probe)) return;
    const sample = probe.query.rows.find(
      (row) => row.kind === "mod" && row.statIds.length > 0 && row.value !== undefined,
    )!;
    rig.setLearnedTiers({
      version: 1,
      stats: { [sample.statIds[0]!]: { tiers: { "2": { min: 1, max: 9_999, count: 5 } } } },
      classes: {},
    });
    rig.advance(70_000);
    const opened = await rig.service.open({
      text: fixture("rare-ring-resists.txt"),
      source: "paste",
      autoSearch: false,
    });
    if (!isSession(opened)) return;
    const learnedKey = opened.query.rows.find((row) => row.tierSource === "learned")?.key;
    expect(learnedKey).toBeDefined();
    const switched = rig.service.setProfile(opened.id, "broad");
    expect(switched.query.rows.find((row) => row.key === learnedKey)?.tierSource).toBe("learned");
  });
});
