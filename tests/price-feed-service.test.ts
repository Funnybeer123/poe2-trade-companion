import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import {
  PRICE_TABLE_SCHEMA_VERSION,
  type PriceTable,
} from "../src/core/priceTable.js";

const LEAGUES = [
  { Value: "HC Runes of Aldur", IsCurrent: true },
  { Value: "Runes of Aldur", IsCurrent: true },
  { Value: "Standard", IsCurrent: false },
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
    service.configure({ league: "Standard" });
    await service.refresh();
    expect(calls.some((call) => call.url.includes("/Leagues/Standard/Items"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/Leagues"))).toBe(false);
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
});
