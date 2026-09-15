import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbiguousLeagueError } from "../src/core/priceFeed.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { PriceFeedService, TradeRateLimitedError } from "../src/main/priceFeedService.js";

const LEAGUES = [
  { Value: "HC Runes of Aldur", IsCurrent: true },
  { Value: "Runes of Aldur", IsCurrent: true },
  { Value: "Standard", IsCurrent: false },
];
const TWO_LEAGUES = [
  { Value: "Forbidden Rites", IsCurrent: true, DivinePrice: 97.93 },
  { Value: "Runes of Aldur", IsCurrent: true, DivinePrice: 623.76 },
];

const BODY = {
  query: { status: { option: "online" }, type: "Ruby Ring", filters: { type_filters: { filters: { rarity: { option: "nonunique" } } } } },
  sort: { price: "asc" },
};
const IDS = Array.from({ length: 23 }, (_, index) => `id${String(index).padStart(2, "0")}`);

function fetchRow(id: string, amount = 1) {
  return {
    id,
    listing: { account: { name: `seller-${id}`, online: { league: "Runes of Aldur" } }, price: { amount, currency: "exalted" }, indexed: "2026-09-07T10:00:00Z" },
    item: { typeLine: "Ruby Ring", rarity: "Rare", explicitMods: ["+100 to maximum Life"] },
  };
}

const EXCHANGE = {
  id: "ex-9",
  result: {
    a: {
      id: "a",
      listing: {
        account: { name: "Bulk", online: { league: "Runes of Aldur" } },
        offers: [{ exchange: { currency: "divine", amount: 1 }, item: { currency: "exalted", amount: 130, stock: 1300 } }],
      },
    },
  },
  total: 1,
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

function defaultResponder(url: string, init?: RequestInit): Response {
  if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
  if (url.includes("/search/")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: { type?: string } };
    return jsonResponse({ id: `search-${body.query?.type ?? "x"}`, result: IDS, total: 123 });
  }
  if (url.includes("/exchange/")) return jsonResponse(EXCHANGE);
  const fetched = /\/fetch\/([^?]+)/.exec(url);
  if (fetched) return jsonResponse({ result: fetched[1]!.split(",").map((id) => fetchRow(id)) });
  return jsonResponse({}, 404);
}

function makeService(options?: {
  respond?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  configDir?: string;
  now?: () => Date;
}) {
  const calls: FetchCall[] = [];
  let table: PriceTable = {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [{ id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 400 }],
  };
  const respond = options?.respond ?? defaultResponder;
  const service = new PriceFeedService({
    configDir: options?.configDir ?? mkdtempSync(path.join(tmpdir(), "pfs-generic-")),
    secretDir: mkdtempSync(path.join(tmpdir(), "pfs-generic-secret-")),
    rateLimitBackoffMs: 0,
    getPriceTable: () => table,
    savePriceTable: (next) => (table = next),
    now: options?.now,
    tradeSpacingMs: 0,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }) as typeof fetch,
  });
  return { service, calls };
}

const searches = (calls: FetchCall[]) => calls.filter((call) => call.url.includes("/search/"));
const fetches = (calls: FetchCall[]) => calls.filter((call) => call.url.includes("/fetch/"));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.useRealTimers();
});

describe("PriceFeedService.tradeSearch", () => {
  it("posts the body once, resolves the league, and caches by body hash for the TTL", async () => {
    let now = Date.parse("2026-09-07T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { service, calls } = makeService({ now: () => new Date(now) });
    disposers.push(() => service.dispose());
    const first = await service.tradeSearch(BODY, { reason: "market" });
    expect(first).toEqual({
      id: "search-Ruby Ring",
      total: 123,
      resultIds: IDS,
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-Ruby%20Ring",
      cached: false,
    });
    const search = searches(calls)[0]!;
    expect(search.url).toBe("https://www.pathofexile.com/api/trade2/search/poe2/Runes%20of%20Aldur");
    expect(search.init?.method).toBe("POST");
    expect(JSON.parse(String(search.init?.body))).toEqual(BODY);
    expect(JSON.stringify(search.init?.headers)).not.toContain("POESESSID");
    expect(fetches(calls)).toHaveLength(0); // a search never fetches by itself

    // Same body (key order irrelevant) → the cache, no traffic.
    const reordered = { sort: BODY.sort, query: { ...BODY.query } };
    const again = await service.tradeSearch(reordered, { reason: "market" });
    expect(again.cached).toBe(true);
    expect(again.resultIds).toEqual(IDS);
    expect(searches(calls)).toHaveLength(1);

    // Past the TTL it searches again.
    now += 61_000;
    vi.setSystemTime(now);
    const fresh = await service.tradeSearch(BODY, { reason: "market" });
    expect(fresh.cached).toBe(false);
    expect(searches(calls)).toHaveLength(2);

    // A caller may raise the TTL; a different league is a different key.
    await service.tradeSearch(BODY, { reason: "watch", cacheTtlMs: 10 * 60_000 });
    expect(searches(calls)).toHaveLength(2);
    now += 5 * 60_000;
    vi.setSystemTime(now);
    await service.tradeSearch(BODY, { reason: "watch", cacheTtlMs: 10 * 60_000 });
    expect(searches(calls)).toHaveLength(2);
    const pinned = await service.tradeSearch(BODY, { reason: "watch", league: "Standard" });
    expect(pinned.league).toBe("Standard");
    expect(searches(calls)).toHaveLength(3);
    expect(searches(calls)[2]!.url).toContain("/search/poe2/Standard");
    expect(service.tradeRequestHistory().map((entry) => entry.reason)).toEqual(["market", "market", "watch"]);
  });

  it("refuses to guess between two current leagues and sends the cookie only when set", async () => {
    const ambiguous = makeService({
      respond: (url) => (url.endsWith("/Leagues") ? jsonResponse(TWO_LEAGUES) : jsonResponse({}, 404)),
    });
    disposers.push(() => ambiguous.service.dispose());
    await expect(ambiguous.service.tradeSearch(BODY, { reason: "market" })).rejects.toBeInstanceOf(AmbiguousLeagueError);
    expect(searches(ambiguous.calls)).toHaveLength(0);
    expect(ambiguous.service.status().leagueAmbiguous).toBe(true);

    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    expect(service.hasSession()).toBe(false);
    expect(service.tradeHeaders()).toEqual({ "User-Agent": "poe2-trade-companion/0.1 (local desktop tool)" });
    service.configure({ poesessid: "cookie-1" });
    expect(service.hasSession()).toBe(true);
    expect(service.tradeHeaders().Cookie).toBe("POESESSID=cookie-1");
    await service.tradeSearch(BODY, { reason: "market" });
    expect(JSON.stringify(searches(calls)[0]!.init?.headers)).toContain("POESESSID=cookie-1");
  });

  it("surfaces a complexity refusal on the result and other HTTP errors as throws", async () => {
    const { service, calls } = makeService({
      respond: (url, init) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) {
          const body = JSON.parse(String(init?.body)) as { query: { type?: string } };
          return body.query.type === "complex"
            ? jsonResponse({ error: { code: 2, message: "Query is too complex." } }, 400)
            : jsonResponse({ error: { code: 1, message: "Invalid query" } }, 400);
        }
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const complex = await service.tradeSearch({ query: { type: "complex" } }, { reason: "market" });
    expect(complex).toEqual({ id: "", total: 0, resultIds: [], league: "Runes of Aldur", url: "", cached: false, complexityError: "Query is too complex." });
    await expect(service.tradeSearch({ query: { type: "bad" } }, { reason: "market" })).rejects.toThrow(
      "trade2 search → HTTP 400: Invalid query",
    );
    // Neither answer was cached.
    await service.tradeSearch({ query: { type: "complex" } }, { reason: "market" });
    expect(searches(calls)).toHaveLength(3);
    await expect(service.tradeSearch({ query: { __proto__: { x: 1 } } } as Record<string, unknown>, { reason: "m" })).rejects.toThrow(
      /rejected/,
    );
  });

  it("remembers a 429 penalty and refuses without traffic until it lifts", async () => {
    const { service, calls } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({}, 429, { "Retry-After": "600" });
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const error = await service.tradeSearch(BODY, { reason: "market" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TradeRateLimitedError);
    expect((error as TradeRateLimitedError).restrictedUntilIso).toBeDefined();
    expect(searches(calls)).toHaveLength(1); // a 600 s window is never retried inline
    const budget = service.tradeBudget();
    expect(budget.lookups).toBe(0);
    expect(budget.searchesSpare).toBe(0);
    expect(budget.fetchesSpare).toBe(0);
    expect(budget.restrictedUntilIso).toBeDefined();

    const refused = await service.tradeSearch({ query: { type: "other" } }, { reason: "market" }).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(TradeRateLimitedError);
    expect((refused as Error).message).toContain("rate limited until");
    expect(searches(calls)).toHaveLength(1);
    await expect(service.tradeFetch(["a"], "s", { reason: "market" })).rejects.toBeInstanceOf(TradeRateLimitedError);
    await expect(service.tradeExchange({}, { reason: "market" })).rejects.toBeInstanceOf(TradeRateLimitedError);
    expect(fetches(calls)).toHaveLength(0);
  });
});

describe("PriceFeedService.tradeFetch", () => {
  it("fetches at most ten ids per GET, in order, through the pacer, and prices rows", async () => {
    // Generous advertised rules so the pacer does not sleep inside the test;
    // the house rules (10 per five minutes) still count every request.
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-generic-batches-"));
    const generous = [{ max: 60, periodSec: 10, penaltySec: 60 }];
    writeFileSync(
      path.join(configDir, "trade-pacing.json"),
      JSON.stringify({
        "trade-search": { rules: generous, hits: [], restrictedUntil: 0 },
        "trade-fetch": { rules: generous, hits: [], restrictedUntil: 0 },
      }),
    );
    const { service, calls } = makeService({ configDir });
    disposers.push(() => service.dispose());
    const search = await service.tradeSearch(BODY, { reason: "market" });
    const listings = await service.tradeFetch([...search.resultIds, "id00", " "], search.id, { reason: "market" });
    expect(listings.map((listing) => listing.id)).toEqual(IDS);
    expect(fetches(calls).map((call) => call.url)).toEqual([
      `https://www.pathofexile.com/api/trade2/fetch/${IDS.slice(0, 10).join(",")}?query=search-Ruby%20Ring`,
      `https://www.pathofexile.com/api/trade2/fetch/${IDS.slice(10, 20).join(",")}?query=search-Ruby%20Ring`,
      `https://www.pathofexile.com/api/trade2/fetch/${IDS.slice(20).join(",")}?query=search-Ruby%20Ring`,
    ]);
    expect(fetches(calls)[0]!.init?.method).toBe("GET");
    expect(listings[0]).toMatchObject({
      league: "Runes of Aldur",
      price: { amount: 1, currency: "exalted" },
      priceExalted: 1,
      seller: { account: "seller-id00", online: true },
      listingType: "whisper",
      item: { typeLine: "Ruby Ring", rarity: "Rare", explicitMods: ["+100 to maximum Life"] },
    });
    expect(listings[0]!.raw).toBeUndefined();
    const kept = await service.tradeFetch(["id01"], search.id, { reason: "debug", keepRaw: true });
    expect(kept[0]!.raw).toMatchObject({ id: "id01" });
    // The pacer counted every request.
    const budget = service.tradeBudget();
    expect(budget.fetchesSpare).toBeLessThan(9);
    expect(budget.searchesSpare).toBeLessThan(9);
    expect(service.tradeRequestHistory().filter((entry) => entry.kind === "fetch")).toHaveLength(4);
  });

  it("makes no request for an empty id list and needs a search id", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    expect(await service.tradeFetch([], "s", { reason: "x" })).toEqual([]);
    await expect(service.tradeFetch(["a"], "", { reason: "x" })).rejects.toThrow(/search id/);
    expect(calls).toHaveLength(0);
  });

  it("throws on a 429 (and remembers it) and on other HTTP errors", async () => {
    const limited = makeService({
      respond: (url) => (url.includes("/fetch/") ? jsonResponse({}, 429) : jsonResponse({}, 404)),
    });
    disposers.push(() => limited.service.dispose());
    await expect(limited.service.tradeFetch(["a"], "s", { reason: "x" })).rejects.toBeInstanceOf(TradeRateLimitedError);
    expect(fetches(limited.calls)).toHaveLength(2); // one immediate backoff retry (test seam)
    // Still throttled after the retry: the window is remembered and the next call refused offline.
    await expect(limited.service.tradeFetch(["b"], "s", { reason: "x" })).rejects.toThrow(/rate limited until/);
    expect(fetches(limited.calls)).toHaveLength(2);

    const failing = makeService({
      respond: (url) =>
        url.includes("/fetch/") ? jsonResponse({ error: { message: "Unknown query" } }, 404) : jsonResponse({}, 404),
    });
    disposers.push(() => failing.service.dispose());
    await expect(failing.service.tradeFetch(["b"], "s", { reason: "x" })).rejects.toThrow("trade2 fetch → HTTP 404: Unknown query");
  });

  it("waits the pacer's spacing between requests", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-generic-pacing-"));
    // A fetch policy with a tiny window already holding its allowance: the
    // next fetch must wait for the window to free a slot.
    const now = Date.now();
    writeFileSync(
      path.join(configDir, "trade-pacing.json"),
      JSON.stringify({
        "trade-fetch": { rules: [{ max: 2, periodSec: 1, penaltySec: 10 }], hits: [now - 200], restrictedUntil: 0 },
      }),
    );
    const { service, calls } = makeService({ configDir });
    disposers.push(() => service.dispose());
    const before = Date.now();
    await service.tradeFetch(["a"], "s", { reason: "x" });
    expect(fetches(calls)).toHaveLength(1);
    expect(Date.now() - before).toBeGreaterThanOrEqual(700);
  });
});

describe("PriceFeedService.tradeSearchById", () => {
  function byIdService(options?: { payload?: unknown; status?: number }) {
    return makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (/\/search\/poe2\/[^/]+\/[^/]+$/.test(url)) {
          return jsonResponse(options?.payload ?? { id: "srch-1", result: IDS.slice(0, 3), total: 3, query: BODY.query }, options?.status ?? 200);
        }
        return jsonResponse({}, 404);
      },
    });
  }

  it("GETs the search by id, returns the query it stands for, and paces it as a search", async () => {
    const { service, calls } = byIdService();
    disposers.push(() => service.dispose());
    const result = await service.tradeSearchById("", "srch-1", { reason: "market paste" });
    expect(result).toEqual({
      id: "srch-1",
      total: 3,
      resultIds: ["id00", "id01", "id02"],
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/srch-1",
      cached: false,
      query: BODY.query,
    });
    const search = searches(calls)[0]!;
    expect(search.url).toBe("https://www.pathofexile.com/api/trade2/search/poe2/Runes%20of%20Aldur/srch-1");
    expect(search.init?.method).toBe("GET");
    expect(service.tradeRequestHistory()).toEqual([
      expect.objectContaining({ kind: "search", reason: "market paste", league: "Runes of Aldur", detail: "srch-1" }),
    ]);
    expect(service.tradeBudget().searchesSpare).toBeLessThan(9);
    // A pinned league overrides the resolved one, and there is no cache:
    // the id IS the cache, so a second call goes out again.
    const pinned = await service.tradeSearchById("Standard", " srch-1 ", { reason: "market paste" });
    expect(pinned.league).toBe("Standard");
    expect(searches(calls)).toHaveLength(2);
    expect(searches(calls)[1]!.url).toContain("/search/poe2/Standard/srch-1");
  });

  it("tolerates a thin answer, needs an id, and refuses inside a penalty window", async () => {
    const thin = byIdService({ payload: { result: ["id00", 7, ""] } });
    disposers.push(() => thin.service.dispose());
    const result = await thin.service.tradeSearchById("Standard", "srch-2", { reason: "paste" });
    expect(result).toMatchObject({ id: "srch-2", total: 1, resultIds: ["id00"], league: "Standard" });
    expect(result.query).toBeUndefined();
    await expect(thin.service.tradeSearchById("Standard", "  ", { reason: "paste" })).rejects.toThrow(/search id/);

    const gone = byIdService({ payload: { error: { message: "Invalid query" } }, status: 404 });
    disposers.push(() => gone.service.dispose());
    await expect(gone.service.tradeSearchById("Standard", "nope", { reason: "paste" })).rejects.toThrow(
      "trade2 search → HTTP 404: Invalid query",
    );

    const limited = makeService({
      respond: (url) => (url.endsWith("/Leagues") ? jsonResponse(LEAGUES) : jsonResponse({}, 429, { "Retry-After": "600" })),
    });
    disposers.push(() => limited.service.dispose());
    await expect(limited.service.tradeSearchById("Standard", "a", { reason: "paste" })).rejects.toBeInstanceOf(
      TradeRateLimitedError,
    );
    const refused = await limited.service.tradeSearchById("Standard", "b", { reason: "paste" }).catch((e: unknown) => e);
    expect((refused as Error).message).toContain("rate limited until");
    expect(searches(limited.calls)).toHaveLength(1); // the second never went out
  });
});

const STATS_PAYLOAD = {
  result: [
    {
      id: "explicit",
      label: "Explicit",
      entries: [
        { id: "explicit.stat_life", text: "+# to maximum Life", type: "explicit" },
        { id: "explicit.stat_es", text: "+# to maximum Energy Shield", type: "explicit" },
      ],
    },
    {
      id: "implicit",
      label: "Implicit",
      entries: [{ id: "implicit.stat_rarity", text: "#% increased Rarity of Items found", type: "implicit" }],
    },
  ],
};
const STATIC_PAYLOAD = { result: [{ id: "Currency", entries: [{ id: "exalted", text: "Exalted Orb" }] }] };

function staticDataService(options?: {
  configDir?: string;
  statsStatus?: number;
  staticStatus?: number;
}) {
  return makeService({
    ...(options?.configDir ? { configDir: options.configDir } : {}),
    respond: (url) => {
      if (url.endsWith("/data/stats")) return jsonResponse(STATS_PAYLOAD, options?.statsStatus ?? 200);
      if (url.endsWith("/data/static")) return jsonResponse(STATIC_PAYLOAD, options?.staticStatus ?? 200);
      if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
      return jsonResponse({}, 404);
    },
  });
}

const dataCalls = (calls: FetchCall[], kind: "stats" | "static") =>
  calls.filter((call) => call.url.endsWith(`/data/${kind}`));

describe("PriceFeedService.statsPayloadCached", () => {
  it("serves memory, then a disk copy under a week, and never the network", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-stats-"));
    const cold = staticDataService({ configDir });
    disposers.push(() => cold.service.dispose());
    expect(cold.service.statsPayloadCached()).toBeUndefined();
    expect(cold.calls).toHaveLength(0);

    expect(await cold.service.fetchStats()).toBeDefined();
    expect(dataCalls(cold.calls, "stats")).toHaveLength(1);
    expect(cold.service.statsPayloadCached()).toEqual(STATS_PAYLOAD);
    expect(dataCalls(cold.calls, "stats")).toHaveLength(1);

    // A fresh process reads the file fetchStats wrote — still no request.
    const reopened = staticDataService({ configDir });
    disposers.push(() => reopened.service.dispose());
    expect(reopened.service.statsPayloadCached()).toEqual(STATS_PAYLOAD);
    expect(reopened.calls).toHaveLength(0);
  });

  it("ignores a copy older than seven days and a corrupt one", () => {
    const old = mkdtempSync(path.join(tmpdir(), "pfs-stats-old-"));
    writeFileSync(
      path.join(old, "trade-stats.json"),
      JSON.stringify({ at: Date.now() - 8 * 24 * 3_600_000, payload: STATS_PAYLOAD }),
    );
    const stale = staticDataService({ configDir: old });
    disposers.push(() => stale.service.dispose());
    expect(stale.service.statsPayloadCached()).toBeUndefined();

    const broken = mkdtempSync(path.join(tmpdir(), "pfs-stats-bad-"));
    writeFileSync(path.join(broken, "trade-stats.json"), "{not json");
    const bad = staticDataService({ configDir: broken });
    disposers.push(() => bad.service.dispose());
    expect(bad.service.statsPayloadCached()).toBeUndefined();
    expect(bad.calls).toHaveLength(0);
  });
});

describe("PriceFeedService.statCatalogue", () => {
  it("indexes one payload for any stat types and fetches it once", async () => {
    const { service, calls } = staticDataService();
    disposers.push(() => service.dispose());
    const explicit = await service.statCatalogue();
    expect(explicit?.entryCount).toBe(2);
    expect(explicit?.byText.get("# to maximum life")).toEqual(["explicit.stat_life"]);
    expect(dataCalls(calls, "stats")).toHaveLength(1);

    const implicit = await service.statCatalogue(["implicit"]);
    expect(implicit?.entryCount).toBe(1);
    expect(implicit?.byText.get("#% increased rarity of items found")).toEqual(["implicit.stat_rarity"]);
    expect(dataCalls(calls, "stats")).toHaveLength(1); // same payload, re-indexed

    const both = await service.statCatalogue(["explicit", "implicit"]);
    expect(both?.entryCount).toBe(3);
    expect(await service.statCatalogue(["enchant"])).toBeUndefined(); // no entries of that type
    expect(await service.statCatalogue()).toBe(explicit); // cached per payload + types
    expect(dataCalls(calls, "stats")).toHaveLength(1);
  });

  it("is undefined when no payload can be had", async () => {
    const { service, calls } = staticDataService({ statsStatus: 500 });
    disposers.push(() => service.dispose());
    expect(await service.statCatalogue(["explicit"])).toBeUndefined();
    expect(dataCalls(calls, "stats")).toHaveLength(1);
    // The five-minute retry gate holds the next attempt offline.
    expect(await service.statCatalogue(["explicit"])).toBeUndefined();
    expect(dataCalls(calls, "stats")).toHaveLength(1);
  });
});

describe("PriceFeedService.fetchStatic", () => {
  it("GETs /data/static once a week, caches it in configDir, and never pays the trade budget", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-static-"));
    const { service, calls } = staticDataService({ configDir });
    disposers.push(() => service.dispose());
    const spareBefore = service.tradeBudget();
    expect(await service.fetchStatic()).toEqual(STATIC_PAYLOAD);
    expect(dataCalls(calls, "static")).toHaveLength(1);
    expect(dataCalls(calls, "static")[0]!.url).toBe("https://www.pathofexile.com/api/trade2/data/static");
    expect(JSON.stringify(dataCalls(calls, "static")[0]!.init?.headers)).not.toContain("POESESSID");
    expect(service.tradeBudget().searchesSpare).toBe(spareBefore.searchesSpare); // static data is unpaced
    expect(await service.fetchStatic()).toEqual(STATIC_PAYLOAD);
    expect(dataCalls(calls, "static")).toHaveLength(1);

    const written = JSON.parse(readFileSync(path.join(configDir, "trade-static.json"), "utf8")) as { payload: unknown };
    expect(written.payload).toEqual(STATIC_PAYLOAD);
    const reopened = staticDataService({ configDir });
    disposers.push(() => reopened.service.dispose());
    expect(await reopened.service.fetchStatic()).toEqual(STATIC_PAYLOAD);
    expect(reopened.calls).toHaveLength(0);
  });

  it("serves a stale copy when the fetch fails, and undefined when there is none", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-static-stale-"));
    writeFileSync(
      path.join(configDir, "trade-static.json"),
      JSON.stringify({ at: Date.now() - 8 * 24 * 3_600_000, payload: STATIC_PAYLOAD }),
    );
    const stale = staticDataService({ configDir, staticStatus: 500 });
    disposers.push(() => stale.service.dispose());
    expect(await stale.service.fetchStatic()).toEqual(STATIC_PAYLOAD);
    expect(dataCalls(stale.calls, "static")).toHaveLength(1);
    // Retry gate: the stale copy is served again without a second request.
    expect(await stale.service.fetchStatic()).toEqual(STATIC_PAYLOAD);
    expect(dataCalls(stale.calls, "static")).toHaveLength(1);

    const empty = staticDataService({ staticStatus: 503 });
    disposers.push(() => empty.service.dispose());
    expect(await empty.service.fetchStatic()).toBeUndefined();
  });
});

describe("PriceFeedService.tradeExchange", () => {
  it("posts to the exchange endpoint and parses the offers", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    const body = { query: { status: { option: "online" }, have: ["divine"], want: ["exalted"] }, sort: { have: "asc" }, engine: "new" };
    const result = await service.tradeExchange(body, { reason: "bulk" });
    expect(result).toEqual({
      id: "ex-9",
      total: 1,
      league: "Runes of Aldur",
      url: "https://www.pathofexile.com/trade2/exchange/poe2/Runes%20of%20Aldur/ex-9",
      offers: [
        {
          id: "a",
          seller: { account: "Bulk", online: true, afk: false, hideout: false, league: "Runes of Aldur" },
          have: { currency: "divine", amount: 1 },
          want: { currency: "exalted", amount: 130 },
          stock: 1300,
          ratio: 130,
        },
      ],
    });
    const call = calls.find((entry) => entry.url.includes("/exchange/"))!;
    expect(call.url).toBe("https://www.pathofexile.com/api/trade2/exchange/poe2/Runes%20of%20Aldur");
    expect(JSON.parse(String(call.init?.body))).toEqual(body);
    // Exchanges count against the search policy, uncached.
    await service.tradeExchange(body, { reason: "bulk", league: "Standard" });
    expect(calls.filter((entry) => entry.url.includes("/exchange/"))).toHaveLength(2);
    expect(service.tradeBudget().searchesSpare).toBeLessThan(9);
  });
});
