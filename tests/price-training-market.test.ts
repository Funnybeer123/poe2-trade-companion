import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { SEARCH_POLICY, TradePacer } from "../src/core/tradePacing.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";

const LEAGUE = "Training League";
const RING = "Item Class: Rings\nRarity: Rare\nDoom Loop\nRuby Ring\n--------\nItem Level: 81\n--------\n+120 to maximum Life\n+38% to Fire Resistance";
const JUNK_RING = "Item Class: Rings\nRarity: Rare\nDim Loop\nRuby Ring\n--------\nItem Level: 81\n--------\n5% increased Light Radius";
const STATS = JSON.parse(readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"));
const SAPPHIRE = readFileSync(new URL("../fixtures/items/chilling-sapphire-training.txt", import.meta.url), "utf8");
const PLAIN_SAPPHIRE = parseAdvancedItemText(SAPPHIRE).plainText;

interface Call { url: string; init?: RequestInit }
function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300, status, json: async () => payload,
    headers: { get: (key: string) => normalized[key.toLowerCase()] ?? null },
  } as Response;
}
function listing(id: string) {
  return {
    id,
    item: { name: id === "b" ? "Junk Ring" : "Life Ring", typeLine: "Ruby Ring", baseType: "Ruby Ring",
      explicitMods: id === "b" ? ["5% increased Light Radius"] : ["+110 to maximum Life", "+35% to Fire Resistance"] },
    listing: { price: { amount: id === "b" ? 1 : 3, currency: "exalted" } },
  };
}
function responder(url: string): Response {
  if (url.includes("/search/")) return response({ id: "training-search", result: ["a", "b"] });
  const fetchIds = /\/fetch\/([^?]+)/.exec(url)?.[1];
  if (fetchIds) return response({ result: fetchIds.split(",").map(listing) });
  throw new Error(`Unexpected metadata/network request: ${url}`);
}
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); });
function rig(options: {
  configDir?: string;
  league?: string;
  respond?: (url: string, init?: RequestInit) => Response | Promise<Response>;
} = {}) {
  const configDir = options.configDir ?? mkdtempSync(path.join(tmpdir(), "training-market-"));
  const calls: Call[] = [];
  let table: PriceTable = { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: "exalted", entries: [] };
  const service = new PriceFeedService({
    configDir, secretDir: mkdtempSync(path.join(tmpdir(), "training-market-secrets-")),
    getPriceTable: () => table, savePriceTable: (next) => (table = next),
    tradeSpacingMs: 0, rateLimitBackoffMs: 0,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return (options.respond ?? responder)(String(url), init);
    }) as typeof fetch,
  });
  if (options.league !== "auto") service.configure({ league: options.league ?? LEAGUE });
  else service.configure({ league: "auto" });
  disposers.push(() => service.dispose());
  return { service, calls, configDir };
}
const searchCalls = (calls: Call[]) => calls.filter((call) => call.url.includes("/search/"));
const fetchCalls = (calls: Call[]) => calls.filter((call) => call.url.includes("/fetch/"));

describe("price training offline cache", () => {
  it("returns undefined on a cold cache or invalid text without requesting metadata or listings", () => {
    const { service, calls } = rig();
    expect(service.peekCompsResult(RING)).toBeUndefined();
    expect(service.peekCompsResult("not an item")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("preserves sample timestamps and serves repeat checks across process restarts", async () => {
    const first = rig();
    const fetched = await first.service.fetchTrainingComps(RING);
    expect(fetched).toMatchObject({ ok: true, cached: false, league: LEAGUE, basis: "base-type" });
    expect(Date.parse(fetched.expiresAt!) - Date.parse(fetched.fetchedAt!)).toBe(6 * 60 * 60_000);
    expect(first.service.peekCompsResult(RING)).toEqual({ ...fetched, cached: true });
    expect(await first.service.fetchTrainingComps(RING)).toEqual({ ...fetched, cached: true });
    expect(first.calls).toHaveLength(2);

    const next = rig({ configDir: first.configDir });
    expect(next.service.peekCompsResult(RING)).toEqual({ ...fetched, cached: true });
    expect(await next.service.fetchTrainingComps(RING)).toEqual({ ...fetched, cached: true });
    expect(next.calls).toEqual([]);
  });

  it("re-scores shared raw base listings for each item's actual modifiers", async () => {
    const { service, calls } = rig();
    const useful = await service.fetchTrainingComps(RING);
    const junk = await service.fetchTrainingComps(JUNK_RING);
    expect(useful.summary?.lowest).toBe(3);
    expect(junk.summary?.lowest).toBe(1);
    expect(junk.cached).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not return another league's sample or resolve auto leagues over the network", async () => {
    const first = rig();
    await first.service.fetchTrainingComps(RING);
    const second = rig({ configDir: first.configDir, league: "Other League" });
    expect(second.service.peekCompsResult(RING)).toBeUndefined();
    const other = await second.service.fetchTrainingComps(RING);
    expect(other.league).toBe("Other League");
    expect(searchCalls(second.calls)[0].url).toContain("Other%20League");
    const automatic = rig({ configDir: first.configDir, league: "auto" });
    expect(automatic.service.peekCompsResult(RING)).toBeUndefined();
    expect((await automatic.service.fetchTrainingComps(RING)).error).toContain("Pin a league");
    expect(automatic.calls).toEqual([]);
  });

  it("does not fetch when a cached sample expires until the user explicitly checks again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    const { service, calls } = rig();
    const first = await service.fetchTrainingComps(RING);
    vi.setSystemTime(new Date("2026-09-14T19:00:00Z"));
    expect(service.peekCompsResult(RING)).toBeUndefined();
    expect(calls).toHaveLength(2);
    const next = await service.fetchTrainingComps(RING);
    expect(next.cached).toBe(false);
    expect(next.fetchedAt).not.toBe(first.fetchedAt);
    expect(calls).toHaveLength(4);
  });
});

describe("explicit sparse training lookups", () => {
  it("searches the canonical Sapphire base and shares the sample across advanced/plain copies", async () => {
    const { service, calls } = rig({ respond: () => response({ id: "sapphire", result: [] }) });
    const result = await service.fetchTrainingComps(SAPPHIRE);
    expect(result).toMatchObject({ ok: true, basis: "base-type" });
    expect(JSON.parse(String(searchCalls(calls)[0].init?.body)).query.type).toBe("Sapphire");
    expect(service.peekCompsResult(PLAIN_SAPPHIRE)).toEqual({ ...result, cached: true });
    expect(await service.fetchTrainingComps(PLAIN_SAPPHIRE)).toEqual({ ...result, cached: true });
    expect(calls).toHaveLength(1);
  });

  it("uses actual advanced Sapphire rolls for cached stat filters, without requesting metadata", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "training-sapphire-stats-"));
    writeFileSync(path.join(configDir, "trade-stats.json"), JSON.stringify({ at: Date.now(), payload: STATS }));
    const { service, calls } = rig({ configDir, respond: () => response({ id: "sapphire", result: [] }) });
    const result = await service.fetchTrainingComps(SAPPHIRE);
    expect(result).toMatchObject({ ok: true, basis: "stat-filtered" });
    const query = JSON.parse(String(searchCalls(calls)[0].init?.body)).query;
    expect(query.type).toBe("Sapphire");
    expect(query.stats).toEqual([{ type: "and", filters: [
      { id: "explicit.stat_3291658075", value: { min: 12 } },
    ] }]);
    expect(service.peekCompsResult(PLAIN_SAPPHIRE)).toEqual({ ...result, cached: true });
    expect(calls).toHaveLength(1);
  });

  it("caps one deliberate check at one search and one fetch of ten listings", async () => {
    const { service, calls } = rig({ respond: (url) => url.includes("/search/") ?
      response({ id: "training-search", result: Array.from({ length: 24 }, (_, index) => `a${index}`) }) : responder(url) });
    const result = await service.fetchTrainingComps(RING);
    expect(result.ok).toBe(true);
    expect(searchCalls(calls)).toHaveLength(1);
    expect(fetchCalls(calls)).toHaveLength(1);
    expect(/\/fetch\/([^?]+)/.exec(fetchCalls(calls)[0].url)![1].split(",")).toHaveLength(10);
    expect(calls).toHaveLength(2); // no /data/stats, /Leagues, or secondary query
    expect(service.tradeRequestHistory().every((entry) => entry.reason === "price-training:explicit-check")).toBe(true);
  });

  it("coalesces concurrent same-query requests without sharing one item's similarity result", async () => {
    const { service, calls } = rig();
    const [useful, junk, repeat] = await Promise.all([
      service.fetchTrainingComps(RING), service.fetchTrainingComps(JUNK_RING), service.fetchTrainingComps(RING),
    ]);
    expect(calls).toHaveLength(2);
    expect(useful.summary?.lowest).toBe(3);
    expect(junk.summary?.lowest).toBe(1);
    expect(repeat.summary).toEqual(useful.summary);
    expect(junk.cached).toBe(true);
  });

  it.each([{ ids: [] }, { ids: ["a"] }])("caches a thin stat-filtered sample without widening the query: $ids", async ({ ids }) => {
    const configDir = mkdtempSync(path.join(tmpdir(), "training-stat-cache-"));
    writeFileSync(path.join(configDir, "trade-stats.json"), JSON.stringify({ at: Date.now(), payload: STATS }));
    const { service, calls } = rig({ configDir, respond: (url) => url.includes("/search/") ?
      response({ id: "training-search", result: ids }) : responder(url) });
    const fresh = await service.fetchTrainingComps(RING);
    expect(fresh.basis).toBe("stat-filtered");
    expect(fresh.summary?.candidateCount).toBe(ids.length);
    expect(Date.parse(fresh.expiresAt!) - Date.parse(fresh.fetchedAt!)).toBe(60 * 60_000);
    expect(searchCalls(calls)).toHaveLength(1);
    expect(fetchCalls(calls)).toHaveLength(ids.length ? 1 : 0);
    expect(JSON.parse(String(searchCalls(calls)[0].init?.body)).query.stats).toBeDefined();
    const count = calls.length;
    expect((await service.fetchTrainingComps(RING)).cached).toBe(true);
    expect(calls).toHaveLength(count);
    const next = rig({ configDir });
    expect(next.service.peekCompsResult(RING)?.basis).toBe("stat-filtered");
    expect(next.calls).toEqual([]);
  });

  it("does not attempt a request with an exhausted shared budget", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "training-budget-"));
    const pacer = new TradePacer();
    for (let index = 0; index < 9; index += 1) pacer.record(SEARCH_POLICY);
    writeFileSync(path.join(configDir, "trade-pacing.json"), JSON.stringify(pacer.toJSON()));
    const { service, calls } = rig({ configDir });
    expect(service.tradeBudget().lookups).toBe(0);
    expect((await service.fetchTrainingComps(RING)).error).toContain("No spare trade2 lookup");
    expect(calls).toEqual([]);
  });

  it.each(["600", undefined])("never retries a 429 and persists its cooldown across restarts: %s", async (retryAfter) => {
    const first = rig({ respond: () => response({}, 429, retryAfter ? { "Retry-After": retryAfter } : {}) });
    const before = Date.now();
    const failed = await first.service.fetchTrainingComps(RING);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("not retried");
    expect(first.calls).toHaveLength(1);
    expect(Date.parse(first.service.tradeBudget().restrictedUntilIso!)).toBeGreaterThanOrEqual(before + (retryAfter ? 600 : 60) * 1000);
    expect((await first.service.fetchTrainingComps(RING)).error).toContain("rate limited until");
    expect(first.calls).toHaveLength(1);
    const second = rig({ configDir: first.configDir });
    expect((await second.service.fetchTrainingComps(RING)).error).toContain("rate limited until");
    expect(second.calls).toEqual([]);
  });

  it("serves a fresh cache during a cooldown, with no new requests", async () => {
    const first = rig();
    await first.service.fetchTrainingComps(RING);
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { retryAfter: "600" });
    writeFileSync(path.join(first.configDir, "trade-pacing.json"), JSON.stringify(pacer.toJSON()));
    const second = rig({ configDir: first.configDir });
    expect(second.service.tradeBudget().lookups).toBe(0);
    expect((await second.service.fetchTrainingComps(RING)).cached).toBe(true);
    expect(second.calls).toEqual([]);
  });

  it("does not fetch or fall back after a search response consumes the remaining budget", async () => {
    const { service, calls } = rig({ respond: () => response({ id: "last-slot", result: ["a"] }, 200, {
      "X-Rate-Limit-Ip": "10:300:600", "X-Rate-Limit-Ip-State": "17:300:0",
    }) });
    const result = await service.fetchTrainingComps(RING);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No spare trade2 request");
    expect(calls).toHaveLength(1);
  });
});
