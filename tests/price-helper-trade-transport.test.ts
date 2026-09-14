import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRewardTradeQuery, type RewardIdentity } from "../src/core/helperReward.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { PriceFeedService } from "../src/main/priceFeedService.js";

const GEM: RewardIdentity = { name: "Rain of Blades", type: "Rain of Blades", kind: "gem", gemLevel: 20 };
const LEAGUE = "HC Runes of Aldur";
const id = (n: number) => n.toString(16).padStart(64, "0");
const json = (payload: unknown, init?: ResponseInit) => new Response(JSON.stringify(payload), init);
const searches = { id: "safe_Search-1", result: [id(1), id(2)] };
const listings = { result: [{ id: id(1), item: { typeLine: "Rain of Blades" }, listing: { price: { amount: 1, currency: "divine" } } }] };
const cleanup: Array<() => void> = [];

function makeService(respond: (url: string, init: RequestInit) => Response | Promise<Response> = url => json(url.includes("/search/") ? searches : listings), options?: { tradeSpacingMs?: number; beforeLoad?: (dir: string) => void }) {
  const configDir = mkdtempSync(path.join(tmpdir(), "helper-trade-transport-"));
  options?.beforeLoad?.(configDir);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let table: PriceTable = { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: "exalted", entries: [] };
  const service = new PriceFeedService({
    configDir,
    getPriceTable: () => table,
    savePriceTable: next => (table = next),
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    tradeSpacingMs: options?.tradeSpacingMs ?? 0,
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch,
  });
  cleanup.push(() => { service.dispose(); rmSync(configDir, { recursive: true, force: true }); });
  return { service, calls, configDir };
}

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  vi.useRealTimers();
});

describe("bounded helper reward trade transport", () => {
  it("uses only the fixed official endpoints, exact gem level, and at most ten listing IDs", async () => {
    const { service, calls } = makeService(url => json(url.includes("/search/") ? { id: "safe_Search-1", result: Array.from({ length: 15 }, (_, i) => id(i + 1)) } : listings));
    expect(calls).toHaveLength(0);
    const result = await service.fetchHelperReward(GEM, LEAGUE);
    expect(result.error).toBeUndefined();
    expect(result.payload).toEqual(listings);
    expect(result.fetchedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(result.tradeUrl).toMatch(/^https:\/\/www\.pathofexile\.com\/trade2\/search\/poe2\//);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://www.pathofexile.com/api/trade2/search/poe2/HC%20Runes%20of%20Aldur");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual(buildRewardTradeQuery(GEM));
    expect(body.query.type).toBe("Rain of Blades");
    expect(body.query.filters.misc_filters.filters.gem_level).toEqual({ min: 20, max: 20 });
    expect(calls[1]!.url).toBe(`https://www.pathofexile.com/api/trade2/fetch/${Array.from({ length: 10 }, (_, i) => id(i + 1)).join(",")}?query=safe_Search-1&realm=poe2`);
    expect(calls[1]!.init.method).toBe("GET");
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.headers).toMatchObject({ Accept: "application/json", "Content-Type": "application/json", "User-Agent": expect.stringContaining("poe2-trade-companion") });
      expect(JSON.stringify(call.init.headers)).not.toContain("Cookie");
    }
  });

  it("preserves an explicitly configured session cookie on official requests", async () => {
    const { service, calls } = makeService();
    service.configure({ poesessid: "fixture-cookie" });
    await service.fetchHelperReward(GEM, LEAGUE);
    expect(calls[0]!.init.headers).toMatchObject({ Cookie: "POESESSID=fixture-cookie" });
  });

  it.each(["", "a".repeat(81), "Standard/../../bad", "Standard?league=bad", "Standard\nInjected", "Standard\n"])("rejects invalid league %j before network use", async league => {
    const { service, calls } = makeService();
    expect((await service.fetchHelperReward(GEM, league)).error).toBe("Invalid reward league.");
    expect(calls).toHaveLength(0);
  });

  it("rejects unsafe or unspecified-level identities before network use", async () => {
    const { service, calls } = makeService();
    const result = await service.fetchHelperReward({ ...GEM, gemLevel: undefined }, LEAGUE);
    expect(result.error).toContain("identified exactly");
    expect(calls).toHaveLength(0);
  });

  it.each(["../other", "abc?realm=other", "https://evil.invalid", "a".repeat(2049), "", "safe\n"])("rejects unsafe search ID %j", async searchId => {
    const { service, calls } = makeService(() => json({ ...searches, id: searchId }));
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("invalid search result");
    expect(calls).toHaveLength(1);
  });

  it("accepts the observed 152-character compressed official search identifier", async () => {
    const searchId = "H4sIAAAAAAAAA02MOwqAQBBDryKptxBLS4_gBWTRUQZmP7ijKOLd3dXGVC8hyYWkVreE9kKIysGjRfDCnnAb6BkpB71lX4W56sROlGAwsyit78pxGoef_-FCbhDaSb5evm5qA2ePAnfRA6X_vZh_AAAA";
    expect(searchId).toHaveLength(152);
    const { service, calls } = makeService(url => json(url.includes("/search/") ? { ...searches, id: searchId } : listings));
    const result = await service.fetchHelperReward(GEM, LEAGUE);
    expect(result.error).toBeUndefined();
    expect(result.payload).toEqual(listings);
    expect(calls[1]!.url).toBe(`https://www.pathofexile.com/api/trade2/fetch/${searches.result.join(",")}?query=${searchId}&realm=poe2`);
  });

  it.each(["short", "../outside", "a".repeat(63), "a".repeat(65), "z".repeat(64), `${id(1)}\n`, null])("rejects unsafe listing ID %j", async listingId => {
    const { service, calls } = makeService(() => json({ ...searches, result: [id(1), listingId] }));
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("invalid listing ID");
    expect(calls).toHaveLength(1);
  });

  it("deduplicates requested listing IDs and returns an empty result without a fetch", async () => {
    const duplicate = makeService(url => json(url.includes("/search/") ? { ...searches, result: [id(1), id(1)] } : listings));
    expect((await duplicate.service.fetchHelperReward(GEM, LEAGUE)).error).toBeUndefined();
    expect(duplicate.calls[1]!.url).toContain(`/fetch/${id(1)}?`);
    const empty = makeService(() => json({ id: "safe", result: [] }));
    expect(await empty.service.fetchHelperReward(GEM, LEAGUE)).toMatchObject({ payload: { result: [] }, fetchedAt: "2026-09-13T12:00:00.000Z" });
    expect(empty.calls).toHaveLength(1);
  });

  it("learns 429 headers, does not retry, and refuses a concurrently queued helper lookup", async () => {
    const { service, calls, configDir } = makeService(() => json({ error: "private response body" }, {
      status: 429, headers: { "retry-after": "120", "x-rate-limit-ip": "8:10:60", "x-rate-limit-ip-state": "8:10:120" },
    }));
    const results = await Promise.all([service.fetchHelperReward(GEM, LEAGUE), service.fetchHelperReward(GEM, LEAGUE)]);
    expect(results.every(result => result.error?.includes("rate limit"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private response body");
    expect(calls).toHaveLength(1);
    expect(service.rateLimitedUntilIso()).toBeDefined();
    const saved = JSON.parse(readFileSync(path.join(configDir, "trade-pacing.json"), "utf8"));
    expect(saved["trade-search"].rules).toEqual([{ max: 8, periodSec: 10, penaltySec: 60 }]);
    expect(saved["trade-search"].restrictedUntil).toBeGreaterThan(Date.now() + 110_000);
  });

  it("remembers a default penalty for a 429 without Retry-After, including on fetch", async () => {
    const { service, calls } = makeService(url => url.includes("/search/") ? json(searches) : json({}, { status: 429 }));
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("rate limit");
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("rate limit");
    expect(calls).toHaveLength(2);
  });

  it("honors an HTTP-date Retry-After without retrying the helper request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    const { service, calls } = makeService(() => json({}, { status: 429, headers: { "retry-after": "Sun, 13 Sep 2026 12:02:00 GMT" } }));
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("rate limit");
    expect(service.rateLimitedUntilIso()).toBe("2026-09-13T12:02:00.000Z");
    expect(calls).toHaveLength(1);
  });

  it("checks a saved pacer penalty before queueing or sending", async () => {
    const { service, calls } = makeService(undefined, { beforeLoad: dir => writeFileSync(path.join(dir, "trade-pacing.json"), JSON.stringify({
      "trade-search": { rules: [{ max: 8, periodSec: 10, penaltySec: 60 }], hits: [], restrictedUntil: Date.now() + 60_000 },
    })) });
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("rate limit");
    expect(calls).toHaveLength(0);
  });

  it.each(["declared", "streamed", "fetch"])("rejects a %s response exceeding 2 MB", async mode => {
    const oversized = () => new Response(" ".repeat(2 * 1024 * 1024 + 1), mode === "declared" ? { headers: { "content-length": String(2 * 1024 * 1024 + 1) } } : undefined);
    const { service, calls } = makeService(url => mode === "fetch" && url.includes("/search/") ? json(searches) : oversized());
    const result = await service.fetchHelperReward(GEM, LEAGUE);
    expect(result.error).toContain("2 MB limit");
    expect(result.payload).toBeUndefined();
    expect(calls).toHaveLength(mode === "fetch" ? 2 : 1);
  });

  it("rejects malformed JSON without including its potentially private body", async () => {
    const { service } = makeService(() => new Response("private account data is not JSON"));
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toBe("trade2 returned invalid JSON.");
  });

  it("rejects a redirected response even if a fetch adapter disregards redirect:error", async () => {
    const response = json(searches);
    Object.defineProperty(response, "redirected", { value: true });
    const { service, calls } = makeService(() => response);
    expect((await service.fetchHelperReward(GEM, LEAGUE)).error).toContain("redirects are not allowed");
    expect(calls).toHaveLength(1);
  });

  it("enforces the 15 second deadline while waiting for headers", async () => {
    vi.useFakeTimers();
    const { service, calls } = makeService(() => new Promise<Response>(() => undefined));
    const result = service.fetchHelperReward(GEM, LEAGUE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).error).toContain("timed out");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it("keeps the same 15 second deadline until the response body finishes and cancels it", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { service, calls } = makeService(() => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const result = service.fetchHelperReward(GEM, LEAGUE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).error).toContain("timed out");
    expect(calls[0]!.init.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("checks the cancellation gate after pacing before sending the fetch", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const { service, calls } = makeService(undefined, { tradeSpacingMs: 750 });
    const result = service.fetchHelperReward(GEM, LEAGUE, () => allowed);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    allowed = false;
    await vi.advanceTimersByTimeAsync(750);
    expect((await result).error).toBe("Reward lookup cancelled.");
    expect(calls).toHaveLength(1);
  });

  it("does not send a request if the cancellation gate is already closed", async () => {
    const { service, calls } = makeService();
    expect((await service.fetchHelperReward(GEM, LEAGUE, () => false)).error).toBe("Reward lookup cancelled.");
    expect(calls).toHaveLength(0);
  });
});
