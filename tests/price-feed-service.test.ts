import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { parseFeedSnapshot } from "../src/core/priceFeed.js";
import {
  PRICE_TABLE_SCHEMA_VERSION,
  type PriceTable,
} from "../src/core/priceTable.js";

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
      listing: { price: { amount: 3, currency: "exalted" }, account: { name: "seller" } },
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

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
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
