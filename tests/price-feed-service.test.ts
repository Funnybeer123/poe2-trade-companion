import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { parseFeedSnapshot } from "../src/core/priceFeed.js";
import { MOD_FAMILIES, matchModFamily } from "../src/core/modKnowledge.js";
import {
  PRICE_TABLE_SCHEMA_VERSION,
  type PriceTable,
} from "../src/core/priceTable.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { parseLearnedTiers } from "../src/core/tierLearning.js";

const LEAGUES = [
  { Value: "HC Runes of Aldur", IsCurrent: true },
  { Value: "Runes of Aldur", IsCurrent: true },
  { Value: "Standard", IsCurrent: false },
];

// Live 2026-09-07: the previous league stays "current" next to the new one.
const TWO_LEAGUES = [
  { Value: "Standard", IsCurrent: false, DivinePrice: 230.6 },
  { Value: "Forbidden Rites", IsCurrent: true, DivinePrice: 97.93 },
  { Value: "HC Forbidden Rites", IsCurrent: true, DivinePrice: 80.1 },
  { Value: "Runes of Aldur", IsCurrent: true, DivinePrice: 623.76 },
];

const ITEMS = [
  { Text: "Divine Orb", ApiId: "divine", CurrentPrice: 404.62 },
  { Text: "Chaos Orb", ApiId: "chaos", CurrentPrice: 35.91 },
  { Name: "Temporalis", Type: "Silk Robe", Text: "Temporalis Silk Robe", CurrentPrice: 1602665 },
];

const SEARCH_RESULT = { id: "search-1", result: ["aaa", "bbb"], total: 2 };
const FETCH_RESULT = {
  result: [
    {
      id: "aaa",
      item: {
        name: "Comp Ring",
        typeLine: "Ruby Ring",
        baseType: "Ruby Ring",
        explicitMods: [
          { description: "+110 to maximum Life" },
          { description: "+35% to [Resistances|Fire Resistance]" },
        ],
      },
      listing: {
        price: { amount: 3, currency: "exalted" },
        account: { name: "seller" },
        whisper: "@seller Hi, I would like to buy your Comp Ring Ruby Ring listed for 3 exalted in Runes of Aldur",
      },
    },
    {
      id: "bbb",
      item: {
        name: "Junk Ring",
        typeLine: "Ruby Ring",
        explicitMods: [{ description: "5% increased Light Radius" }],
      },
      listing: { price: { amount: 1, currency: "exalted" } },
    },
  ],
};

const RARE_RING = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
].join("\n");

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

function makeService(options?: {
  respond?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  now?: () => Date;
  configDir?: string;
}) {
  const calls: FetchCall[] = [];
  let table: PriceTable = {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [{ id: "manual-1", match: { name: "My Thing" }, value: 9, note: "mine" }],
  };
  const respond =
    options?.respond ??
    ((url: string) => {
      if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
      if (url.includes("/Items")) return jsonResponse(ITEMS);
      if (url.includes("/search/")) return jsonResponse(SEARCH_RESULT);
      if (url.includes("/fetch/")) return jsonResponse(FETCH_RESULT);
      return jsonResponse({}, 404);
    });
  const service = new PriceFeedService({
    configDir: options?.configDir ?? mkdtempSync(path.join(tmpdir(), "pfs-test-")),
    rateLimitBackoffMs: 0, // a 429 retries once, immediately
    getPriceTable: () => table,
    savePriceTable: (next) => (table = next),
    now: options?.now,
    tradeSpacingMs: 0,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }) as typeof fetch,
  });
  return { service, calls, table: () => table };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.useRealTimers();
});

describe("PriceFeedService refresh", () => {
  it("auto-resolves the softcore league and merges the snapshot", async () => {
    const { service, calls, table } = makeService();
    disposers.push(() => service.dispose());
    const status = await service.refresh();
    expect(status.lastError).toBeUndefined();
    expect(status.resolvedLeague).toBe("Runes of Aldur");
    expect(status.feedEntryCount).toBe(3);
    expect(calls.some((call) => call.url.includes("/Leagues/Runes%20of%20Aldur/Items"))).toBe(true);
    // Manual entry survives; feed entries carry provenance.
    const entries = table().entries;
    expect(entries.find((entry) => entry.id === "manual-1")?.value).toBe(9);
    expect(entries.find((entry) => entry.match.name === "Divine Orb")?.value).toBe(404.62);
  });

  it("throttles back-to-back refreshes but retries after an error", async () => {
    let failNext = false;
    const { service, calls } = makeService({
      respond: (url) => {
        if (failNext && url.endsWith("/Leagues")) return jsonResponse("boom", 500);
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/Items")) return jsonResponse(ITEMS);
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    await service.refresh();
    const afterFirst = calls.length;
    await service.refresh(); // inside the min interval — no new requests
    expect(calls.length).toBe(afterFirst);

    failNext = true;
    // Errors are never throttled away silently: force a failing refresh by
    // faking the clock past the interval via a new service instead.
    const late = makeService({
      now: () => new Date(Date.now() + 3_600_000),
      respond: () => jsonResponse("boom", 500),
    });
    disposers.push(() => late.service.dispose());
    const status = await late.service.refresh();
    expect(status.lastError).toContain("500");
    // A failed refresh may be retried immediately.
    const again = await late.service.refresh();
    expect(again.lastError).toContain("500");
  });

  it("keeps the table untouched when the feed returns nothing", async () => {
    const { service, table } = makeService({
      respond: (url) =>
        url.endsWith("/Leagues") ? jsonResponse(LEAGUES) : jsonResponse([]),
    });
    disposers.push(() => service.dispose());
    const status = await service.refresh();
    expect(status.lastError).toContain("no priced items");
    expect(table().entries).toHaveLength(1);
  });

  it("honours a manually configured league", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    const configured = service.configure({ league: "Standard" });
    expect(configured.resolvedLeague).toBe("Standard");
    await service.refresh();
    expect(calls.some((call) => call.url.includes("/Leagues/Standard/Items"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/Leagues"))).toBe(false);
  });

  it("refuses to guess between two current leagues until one is pinned", async () => {
    const { service, calls, table } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(TWO_LEAGUES);
        if (url.includes("/Items")) return jsonResponse(ITEMS);
        if (url.includes("/search/")) return jsonResponse(SEARCH_RESULT);
        if (url.includes("/fetch/")) return jsonResponse(FETCH_RESULT);
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    expect(service.status().leagueCandidates).toEqual([]);
    expect(service.status().leagueAmbiguous).toBe(false);

    const status = await service.refresh();
    expect(status.lastError).toBe(
      "more than one current league: Forbidden Rites (divine ≈ 98 ex), Runes of Aldur (divine ≈ 624 ex) — " +
        "pick one in Tools → Settings → Market data or pass --league=NAME",
    );
    expect(status.leagueAmbiguous).toBe(true);
    expect(status.leagueCandidates).toEqual([
      { value: "Forbidden Rites", divinePrice: 97.93 },
      { value: "Runes of Aldur", divinePrice: 623.76 },
    ]);
    expect(status.resolvedLeague).toBeUndefined();
    expect(calls.some((call) => call.url.includes("/Items"))).toBe(false);
    expect(table().entries).toHaveLength(1); // table untouched

    // Comps refuse too, before any trade2 traffic.
    const comps = await service.fetchComps(RARE_RING);
    expect(comps.ok).toBe(false);
    expect(comps.error).toContain("more than one current league");
    expect(calls.some((call) => call.url.includes("/search/"))).toBe(false);

    // Pinning one league unblocks both, without another /Leagues read.
    const leagueCalls = calls.filter((call) => call.url.endsWith("/Leagues")).length;
    const pinned = service.configure({ league: "Runes of Aldur" });
    expect(pinned.leagueAmbiguous).toBe(false);
    expect(pinned.resolvedLeague).toBe("Runes of Aldur");
    expect(pinned.leagueCandidates).toHaveLength(2); // still listed for the picker
    const refreshed = await service.refresh();
    expect(refreshed.lastError).toBeUndefined();
    expect(refreshed.feedEntryCount).toBe(3);
    expect(calls.some((call) => call.url.includes("/Leagues/Runes%20of%20Aldur/Items"))).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/Leagues")).length).toBe(leagueCalls);
  });

  it("caches the league list for ten minutes", async () => {
    let now = new Date("2026-09-07T10:00:00Z");
    const { service, calls } = makeService({ now: () => now });
    disposers.push(() => service.dispose());
    const first = await service.leagues();
    expect(first).toEqual([{ value: "Runes of Aldur" }]);
    expect(service.status().resolvedLeague).toBe("Runes of Aldur"); // one candidate, auto
    await service.leagues();
    expect(calls.filter((call) => call.url.endsWith("/Leagues"))).toHaveLength(1);
    now = new Date("2026-09-07T10:11:00Z");
    await service.leagues();
    expect(calls.filter((call) => call.url.endsWith("/Leagues"))).toHaveLength(2);
  });
});

describe("PriceFeedService snapshot", () => {
  it("persists the fetched snapshot and a fresh process merges it without the network", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-snapshot-"));
    const first = makeService({ configDir });
    disposers.push(() => first.service.dispose());
    const status = await first.service.refresh();
    expect(status.lastError).toBeUndefined();
    const file = path.join(configDir, "feed-snapshot.json");
    expect(existsSync(file)).toBe(true);
    const snapshot = parseFeedSnapshot(JSON.parse(readFileSync(file, "utf8")));
    expect(snapshot?.league).toBe("Runes of Aldur");
    expect(snapshot?.prices.map((price) => price.name)).toEqual(["Divine Orb", "Chaos Orb", "Temporalis"]);

    // A second process (a CLI, the app after a restart) starts with a table
    // that has no feed data: the snapshot fills it in at construction.
    const second = makeService({ configDir });
    disposers.push(() => second.service.dispose());
    expect(second.calls).toHaveLength(0);
    const entries = second.table().entries;
    expect(entries.find((entry) => entry.id === "manual-1")?.value).toBe(9);
    expect(entries.find((entry) => entry.match.name === "Divine Orb")?.value).toBe(404.62);
    expect(second.service.status().feedEntryCount).toBe(3);
    expect(second.service.status().feedAgeHours).toBeLessThan(24);
  });

  it("skips a snapshot for another pinned league", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-snapshot-pinned-"));
    const first = makeService({ configDir });
    disposers.push(() => first.service.dispose());
    await first.service.refresh();
    first.service.configure({ league: "Standard" });
    const second = makeService({ configDir });
    disposers.push(() => second.service.dispose());
    expect(second.service.status().config.league).toBe("Standard");
    expect(second.table().entries).toHaveLength(1);
    expect(second.service.status().feedEntryCount).toBe(0);
  });
});

describe("PriceFeedService config", () => {
  it("persists config, masks the cookie, and clears it explicitly", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-config-"));
    const first = makeService({ configDir });
    disposers.push(() => first.service.dispose());
    const masked = first.service.configure({ league: "Standard", poesessid: "secret-cookie" });
    expect(masked.config.poesessid).toBe("(set)");
    const raw = JSON.parse(readFileSync(path.join(configDir, "price-feed.json"), "utf8"));
    expect(raw.poesessid).toBe("secret-cookie");
    expect(raw.league).toBe("Standard");

    // A fresh instance reloads the persisted config.
    const second = makeService({ configDir });
    disposers.push(() => second.service.dispose());
    expect(second.service.status().config.league).toBe("Standard");
    expect(second.service.status().config.poesessid).toBe("(set)");

    const cleared = second.service.configure({ poesessid: "" });
    expect(cleared.config.poesessid).toBe("");
  });

  it("sends the cookie only when configured", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    await service.fetchComps(RARE_RING);
    const search = calls.find((call) => call.url.includes("/search/"))!;
    expect(JSON.stringify(search.init?.headers ?? {})).not.toContain("POESESSID");

    service.configure({ poesessid: "cookie-123" });
    const { service: withCookie, calls: cookieCalls } = makeService();
    disposers.push(() => withCookie.dispose());
    withCookie.configure({ poesessid: "cookie-123" });
    await withCookie.fetchComps(RARE_RING);
    const cookieSearch = cookieCalls.find((call) => call.url.includes("/search/"))!;
    expect(JSON.stringify(cookieSearch.init?.headers ?? {})).toContain("POESESSID=cookie-123");
  });
});

describe("PriceFeedService comps", () => {
  it("runs search + fetch, filters by similarity, and caches", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.summary?.candidateCount).toBe(2);
    expect(result.summary?.sampleSize).toBe(1); // the junk ring is filtered
    expect(result.summary?.lowest).toBe(3);
    const requestCount = calls.length;

    const cached = await service.fetchComps(RARE_RING);
    expect(cached.cached).toBe(true);
    expect(calls.length).toBe(requestCount); // no new traffic
  });

  it("surfaces trade rate limiting as a friendly error", async () => {
    const { service, calls } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({}, 429);
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rate limit");
    // One backoff retry happened before giving up.
    expect(calls.filter((call) => call.url.includes("/search/")).length).toBe(2);
  });

  it("remembers the server's full Retry-After, and a fresh process reads it from the pacing log", async () => {
    // 2026-09-07: 429 + Retry-After 600 with no rate headers at all.
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-retry-after-"));
    const before = Date.now();
    const { service, calls } = makeService({
      configDir,
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({}, 429, { "Retry-After": "600" });
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(false);
    const until = Date.parse(service.tradeBudget().restrictedUntilIso!);
    expect(until).toBeGreaterThanOrEqual(before + 599_000); // not shortened to the 300 s cap
    expect(service.tradeBudget().lookups).toBe(0);

    // Another process (a CLI) sees the window from trade-pacing.json alone
    // and reports it instead of stalling on its first request.
    const next = makeService({ configDir });
    disposers.push(() => next.service.dispose());
    expect(next.service.rateLimitedUntilIso()).toBeDefined();
    expect(Date.parse(next.service.rateLimitedUntilIso()!)).toBe(until);
    const refused = await next.service.fetchComps(RARE_RING);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("rate limited until");
    expect(next.calls.filter((call) => call.url.includes("/search/"))).toHaveLength(0);
    // A 600 s Retry-After is never retried inline, even with the test seam's
    // zero backoff: one search, then the window is remembered.
    expect(calls.filter((call) => call.url.includes("/search/"))).toHaveLength(1);
  });

  it("returns an empty summary when the search finds nothing", async () => {
    const { service } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({ id: "s", result: [] });
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.summary?.sampleSize).toBe(0);
  });

  it("rejects non-item text without touching the network", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    const result = await service.fetchComps("hello world");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("peeks the cache without any network traffic", async () => {
    const { service, calls } = makeService();
    disposers.push(() => service.dispose());
    // Cold cache: nothing, and no request went out.
    expect(service.peekComps(RARE_RING)).toBeUndefined();
    expect(service.peekComps("hello world")).toBeUndefined();
    expect(calls).toHaveLength(0);

    await service.fetchComps(RARE_RING);
    const requestCount = calls.length;
    const peeked = service.peekComps(RARE_RING);
    expect(peeked?.sampleSize).toBe(1);
    expect(peeked?.lowest).toBe(3);
    expect(calls.length).toBe(requestCount);
  });

  it("never prices with another league's cached comps", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-league-cache-"));
    const first = makeService({ configDir });
    disposers.push(() => first.service.dispose());
    first.service.configure({ league: "Runes of Aldur" });
    const primed = await first.service.fetchComps(RARE_RING);
    expect(primed.ok).toBe(true);
    expect(primed.league).toBe("Runes of Aldur");

    // Same cache file, another pinned league: the cache is not a hit.
    const second = makeService({ configDir });
    disposers.push(() => second.service.dispose());
    second.service.configure({ league: "Standard" });
    expect(second.service.peekComps(RARE_RING)).toBeUndefined();
    const result = await second.service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.cached).toBeUndefined();
    expect(result.league).toBe("Standard");
    expect(second.calls.some((call) => call.url.includes("/search/poe2/Standard"))).toBe(true);

    // "auto" while poe2scout lists two leagues: refused, cache or no cache.
    const ambiguous = makeService({
      configDir,
      respond: (url) => (url.endsWith("/Leagues") ? jsonResponse(TWO_LEAGUES) : jsonResponse({}, 404)),
    });
    disposers.push(() => ambiguous.service.dispose());
    ambiguous.service.configure({ league: "auto" }); // the shared config file still says Standard
    expect(ambiguous.service.peekComps(RARE_RING)).toBeUndefined();
    const refused = await ambiguous.service.fetchComps(RARE_RING);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("more than one current league");
    expect(ambiguous.calls.some((call) => call.url.includes("/search/"))).toBe(false);
  });

  it("peekComps serves the stat-filtered sample the way fetchComps does", async () => {
    const { service, calls } = makeService({ respond: twoStageResponder(["aaa", "bbb", "ccc"]) });
    disposers.push(() => service.dispose());
    const fetched = await service.fetchComps(RARE_RING);
    expect(fetched.basis).toBe("stat-filtered");
    const requestCount = calls.length;
    const peeked = service.peekComps(RARE_RING);
    expect(peeked?.basis).toBe("stat-filtered");
    expect(peeked?.sampleSize).toBe(fetched.summary?.sampleSize);
    expect(peeked?.lowest).toBe(3);
    expect(calls.length).toBe(requestCount);
  });

  it("keeps the shared pacing log even when a trade2 request throws", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-pacing-throw-"));
    const { service } = makeService({
      configDir,
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) throw new Error("socket hang up");
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("socket hang up");
    const pacing = JSON.parse(readFileSync(path.join(configDir, "trade-pacing.json"), "utf8")) as {
      "trade-search"?: { hits: number[] };
    };
    expect(pacing["trade-search"]?.hits).toHaveLength(1);
  });

  it("budgets lookups by the house rules, not just the advertised windows", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-house-"));
    const now = Date.now();
    const generous = [{ max: 60, periodSec: 10, penaltySec: 60 }];
    writeFileSync(
      path.join(configDir, "trade-pacing.json"),
      JSON.stringify({
        "trade-search": { rules: generous, hits: Array.from({ length: 9 }, (_, i) => now - 60_000 - i * 1000), restrictedUntil: 0 },
        "trade-fetch": { rules: generous, hits: Array.from({ length: 8 }, (_, i) => now - 60_000 - i * 1000), restrictedUntil: 0 },
      }),
    );
    const { service } = makeService({ configDir });
    disposers.push(() => service.dispose());
    expect(service.tradeBudget().lookups).toBe(0);
    const fresh = makeService();
    disposers.push(() => fresh.service.dispose());
    expect(fresh.service.tradeBudget().lookups).toBeGreaterThan(0);
  });

  it("peekComps ignores an expired cache entry", async () => {
    let now = Date.parse("2026-09-07T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { service } = makeService({ now: () => new Date(now) });
    disposers.push(() => service.dispose());
    await service.fetchComps(RARE_RING);
    expect(service.peekComps(RARE_RING)).toBeDefined();
    // Base-type searches live six hours; step past that.
    now += 7 * 60 * 60_000;
    vi.setSystemTime(now);
    expect(service.peekComps(RARE_RING)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchListings: the watchlist's raw, uncached search + fetch
// ---------------------------------------------------------------------------

const WATCH_BODY = {
  query: { status: { option: "online" }, name: "Temporalis", type: "Silk Robe" },
  sort: { price: "asc" },
};

describe("PriceFeedService searchListings", () => {
  it("runs one search and one fetch capped at the limit, parsing whispers, without touching the comps cache", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-search-"));
    const { service, calls } = makeService({
      configDir,
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({ id: "search-9", result: ["aaa", "bbb", "ccc"], total: 42 });
        if (url.includes("/fetch/")) return jsonResponse(FETCH_RESULT);
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const result = await service.searchListings(WATCH_BODY, { limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.league).toBe("Runes of Aldur");
    expect(result.total).toBe(42);
    expect(result.listings.map((listing) => listing.id)).toEqual(["aaa", "bbb"]);
    expect(result.listings[0]?.whisper).toContain("@seller Hi, I would like to buy your Comp Ring");
    expect(result.listings[1]?.whisper).toBeUndefined();
    const search = calls.find((call) => call.url.includes("/search/"))!;
    expect(search.url).toContain("/search/poe2/Runes%20of%20Aldur");
    expect(JSON.parse(String(search.init?.body))).toEqual(WATCH_BODY);
    const fetched = calls.filter((call) => call.url.includes("/fetch/"));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toContain("/fetch/aaa,bbb?query=search-9");
    // Not a price check: nothing was cached for this query.
    expect(existsSync(path.join(configDir, "comps-cache.json"))).toBe(false);

    // The limit is capped at ten and a search with no ids skips the fetch.
    const { service: empty, calls: emptyCalls } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({ id: "s", result: [], total: 0 });
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => empty.dispose());
    const nothing = await empty.searchListings(WATCH_BODY, { limit: 50 });
    expect(nothing).toEqual({ ok: true, listings: [], league: "Runes of Aldur", total: 0 });
    expect(emptyCalls.filter((call) => call.url.includes("/fetch/"))).toHaveLength(0);
  });

  it("refuses inside a remembered penalty window without any traffic", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-penalty-"));
    writeFileSync(
      path.join(configDir, "comps-cache.json"),
      JSON.stringify({ _rateLimitedUntil: Date.now() + 10 * 60_000 }),
    );
    const { service, calls } = makeService({ configDir });
    disposers.push(() => service.dispose());
    const result = await service.searchListings(WATCH_BODY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rate limited until");
    expect(result.listings).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(service.tradeBudget().restrictedUntilIso).toBeDefined();
  });

  it("surfaces a 429 and the league ambiguity like a price check does", async () => {
    const { service, calls } = makeService({
      respond: (url) => {
        if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
        if (url.includes("/search/")) return jsonResponse({}, 429);
        return jsonResponse({}, 404);
      },
    });
    disposers.push(() => service.dispose());
    const limited = await service.searchListings(WATCH_BODY);
    expect(limited.ok).toBe(false);
    expect(limited.error).toContain("rate limit");
    expect(calls.filter((call) => call.url.includes("/search/"))).toHaveLength(2); // one backoff retry

    const ambiguous = makeService({
      respond: (url) => (url.endsWith("/Leagues") ? jsonResponse(TWO_LEAGUES) : jsonResponse({}, 404)),
    });
    disposers.push(() => ambiguous.service.dispose());
    const result = await ambiguous.service.searchListings(WATCH_BODY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("more than one current league");
    expect(ambiguous.calls.some((call) => call.url.includes("/search/"))).toBe(false);
    expect(ambiguous.service.status().leagueAmbiguous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two-stage comps: stat-filtered first, base-type fallback (2026-09-07)
// ---------------------------------------------------------------------------

const STATS: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
);
const LIFE_ID = "explicit.stat_3299347043";
const FIRE_ID = "explicit.stat_3372524247";

/** A fetched ring in the live PoE2 shape: tier data on each explicitMods entry. */
function tieredRing(id: string, amount: number, life: number) {
  return {
    id,
    item: {
      name: `Comp ${id}`,
      typeLine: "Ruby Ring",
      baseType: "Ruby Ring",
      explicitMods: [
        {
          description: `+${life} to maximum Life`,
          domain: "explicit",
          hash: `stat.${LIFE_ID}`,
          mods: [{ name: "Robust", tier: "P2", level: 60, magnitudes: [{ min: "100", max: "119" }] }],
        },
        {
          description: "+35% to [Resistances|Fire Resistance]",
          domain: "explicit",
          hash: `stat.${FIRE_ID}`,
          mods: [{ name: "of the Dragon", tier: "S2", level: 50, magnitudes: [{ min: "31", max: "35" }] }],
        },
      ],
      extended: { hashes: { explicit: [[LIFE_ID, [0]], [FIRE_ID, [1]]] } },
    },
    listing: { price: { amount, currency: "exalted" } },
  };
}
const FETCH_TIERED = {
  result: [tieredRing("aaa", 3, 110), tieredRing("bbb", 4, 105), tieredRing("ccc", 5, 118)],
};

/** Serves the catalogue; a stat-filtered search finds `statIds`, a base search SEARCH_RESULT. */
function twoStageResponder(statIds: string[]) {
  return (url: string, init?: RequestInit): Response => {
    if (url.endsWith("/Leagues")) return jsonResponse(LEAGUES);
    if (url.endsWith("/data/stats")) return jsonResponse(STATS);
    if (url.includes("/search/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: { stats?: unknown } };
      return Array.isArray(body.query?.stats)
        ? jsonResponse({ id: "stat-search", result: statIds, total: statIds.length })
        : jsonResponse(SEARCH_RESULT);
    }
    if (url.includes("/fetch/")) {
      return jsonResponse(url.includes("query=stat-search") ? FETCH_TIERED : FETCH_RESULT);
    }
    return jsonResponse({}, 404);
  };
}
const searches = (calls: FetchCall[]) => calls.filter((call) => call.url.includes("/search/"));
const fetches = (calls: FetchCall[]) => calls.filter((call) => call.url.includes("/fetch/"));
const searchBody = (call: FetchCall) =>
  JSON.parse(String(call.init?.body)) as { query: { type?: string; stats?: unknown } };

describe("PriceFeedService two-stage comps", () => {
  it("prices by the stat-filtered stage when the search finds three listings", async () => {
    const { service, calls } = makeService({ respond: twoStageResponder(["aaa", "bbb", "ccc"]) });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.basis).toBe("stat-filtered");
    expect(result.summary?.basis).toBe("stat-filtered");
    expect(result.summary?.candidateCount).toBe(3);
    // Matched by construction: the similarity bar is off for this stage.
    expect(result.summary?.sampleSize).toBe(3);
    expect(result.summary?.lowest).toBe(3);
    expect(searches(calls)).toHaveLength(1);
    expect(fetches(calls)).toHaveLength(1);
    const body = searchBody(searches(calls)[0]!);
    expect(body.query.type).toBe("Ruby Ring");
    expect(body.query.stats).toEqual([
      {
        type: "and",
        filters: [
          { id: LIFE_ID, value: { min: 102 } },
          { id: FIRE_ID, value: { min: 32 } },
        ],
      },
    ]);
    // Cached under the stat-filtered query body.
    const again = await service.fetchComps(RARE_RING);
    expect(again.cached).toBe(true);
    expect(again.basis).toBe("stat-filtered");
    expect(searches(calls)).toHaveLength(1);
  });

  it("falls back to the base-type stage when the stat search is thin", async () => {
    const { service, calls } = makeService({ respond: twoStageResponder(["aaa"]) });
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.basis).toBe("base-type");
    expect(result.summary?.sampleSize).toBe(1); // the similarity bar is back
    expect(searches(calls)).toHaveLength(2); // stat-filtered, then base-type
    expect(fetches(calls)).toHaveLength(1); // a thin stat search is not fetched
    expect(searchBody(searches(calls)[1]!).query.stats).toBeUndefined();
    // Both stages are cached: the next call makes no requests.
    const again = await service.fetchComps(RARE_RING);
    expect(again.cached).toBe(true);
    expect(again.basis).toBe("base-type");
    expect(searches(calls)).toHaveLength(2);
    expect(fetches(calls)).toHaveLength(1);
  });

  it("skips the stat stage when the catalogue cannot be fetched", async () => {
    const { service, calls } = makeService(); // the default responder 404s /data/stats
    disposers.push(() => service.dispose());
    const result = await service.fetchComps(RARE_RING);
    expect(result.ok).toBe(true);
    expect(result.basis).toBe("base-type");
    expect(searches(calls)).toHaveLength(1);
    expect(searchBody(searches(calls)[0]!).query.stats).toBeUndefined();
  });

  it("caches the stats catalogue on disk", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-stats-"));
    const first = makeService({ configDir, respond: twoStageResponder(["aaa", "bbb", "ccc"]) });
    disposers.push(() => first.service.dispose());
    await first.service.fetchComps(RARE_RING);
    expect(first.calls.filter((call) => call.url.endsWith("/data/stats"))).toHaveLength(1);
    expect(existsSync(path.join(configDir, "trade-stats.json"))).toBe(true);

    const second = makeService({ configDir, respond: twoStageResponder(["aaa", "bbb", "ccc"]) });
    disposers.push(() => second.service.dispose());
    const result = await second.service.fetchComps(RARE_RING);
    expect(result.basis).toBe("stat-filtered");
    expect(result.cached).toBe(true); // the comps cache is on disk too
    expect(second.calls.filter((call) => call.url.endsWith("/data/stats"))).toHaveLength(0);
  });

  it("learns mod tiers from every fetch and persists them", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "pfs-tiers-"));
    const { service } = makeService({ configDir, respond: twoStageResponder(["aaa", "bbb", "ccc"]) });
    disposers.push(() => service.dispose());
    await service.fetchComps(RARE_RING);
    const file = path.join(configDir, "mod-tiers.json");
    expect(existsSync(file)).toBe(true);
    const store = parseLearnedTiers(readFileSync(file, "utf8"));
    expect(store.stats[LIFE_ID]?.tiers["2"]).toEqual({ min: 100, max: 119, count: 3, level: 60 });
    expect(store.classes.Rings?.[FIRE_ID]?.tiers["2"]).toMatchObject({ min: 31, max: 35, count: 3 });
    // The observed range now judges: 125 life sits above tier 2's ceiling, so
    // it reads as tier 1 — the hand threshold (150) would have said tier 2.
    const match = matchModFamily("+125 to maximum Life", {
      itemClass: "Rings",
      learnedTiers: service.learnedTiers(),
      statIds: buildStatCatalogue(STATS, MOD_FAMILIES),
    })!;
    expect(match).toMatchObject({ tier: 1, source: "learned" });
    expect(matchModFamily("+125 to maximum Life")).toMatchObject({ tier: 2, source: "threshold" });
    // A fresh service reloads the store from disk.
    const reloaded = makeService({ configDir });
    disposers.push(() => reloaded.service.dispose());
    expect(reloaded.service.learnedTiers().stats[LIFE_ID]?.tiers["2"]?.count).toBe(3);
  });
});
