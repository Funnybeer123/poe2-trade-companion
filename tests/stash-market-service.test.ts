import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceFeedService } from "../src/main/priceFeedService.js";
import { starterPriceTable } from "../src/core/priceTable.js";

const TEXT = "Item Class: Rings\nRarity: Rare\nDoom Loop\nRuby Ring\n--------\nItem Level: 81\n--------\n+120 to maximum Life";
const ids = ["a", "b", "c"].map(letter => letter.repeat(64));
const statPayload = { result: [{ entries: [{ id: "explicit.stat_3299347043", text: "# to maximum Life" }] }] };
const ratesPayload = { core: { primary: "chaos", rates: { exalted: 5, divine: 0.01 } }, items: [{ id: "exalted", name: "Exalted Orb" }, { id: "divine", name: "Divine Orb" }], lines: [{ id: "exalted", primaryValue: 0.2 }, { id: "divine", primaryValue: 100 }] };
const payload = { result: ids.map((id, i) => ({ id, item: { baseType: "Ruby Ring", frameType: 2, ilvl: 81, explicitMods: ["+120 to maximum Life"] }, listing: { account: { name: `seller-${i}` }, price: { currency: "chaos", amount: i + 2 } } })) };
const services: PriceFeedService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); });
function setup(options: { directory?: string; now?: () => Date; respond?: (url: string) => Response } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const directory = options.directory ?? mkdtempSync(path.join(tmpdir(), "stash-market-"));
  const json = (value: unknown) => Response.json(value, { headers: { "x-rate-limit-ip": "1000:1:1", "x-rate-limit-ip-state": "1:1:0" } });
  const service = new PriceFeedService({ configDir: directory, tradeSpacingMs: 0, getPriceTable: starterPriceTable, savePriceTable: table => table, now: options.now,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return options.respond?.(String(url)) ?? json(String(url).includes("poe.ninja") ? ratesPayload : String(url).endsWith("/data/stats") ? statPayload : String(url).includes("/search/") ? { id: "query-id", result: ids } : payload);
    }) as typeof fetch });
  services.push(service); return { service, calls, directory, json };
}

describe("stash quote transport", () => {
  it("looks up the exact requested league and persists timestamps without starter conversion", async () => {
    const { service, calls } = setup();
    const quote = await service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(quote).toMatchObject({ state: "priced", league: "Forbidden Rites", fair: 3, sampleSize: 3 });
    expect(calls[2]!.url).toContain("/search/poe2/Forbidden%20Rites");
    expect(calls[2]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(calls[3]!.url).toContain("&realm=poe2");
    const cached = await service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(cached).toMatchObject({ cached: true, fetchedAt: quote.fetchedAt });
    expect(cached.validUntil).toBe(quote.validUntil);
    expect(calls).toHaveLength(4);
    expect(quote.requests).toEqual({ searches: 1, listingFetches: 1, metadata: 1, economy: 1 });
    expect(cached.requests).toEqual({ searches: 0, listingFetches: 0, metadata: 0, economy: 0 });
  });
  it("counts only emitted requests when cancellation blocks the next paced call", async () => {
    let active = true;
    const f = setup({ respond: url => {
      if (url.endsWith("/data/stats")) active = false;
      return Response.json(url.includes("poe.ninja") ? ratesPayload : statPayload);
    } });
    const result = await f.service.fetchStashQuote(TEXT, "Forbidden Rites", () => active, "0.5.5b");
    expect(result).toMatchObject({ state: "unavailable", patch: "0.5.5b", requests: { searches: 0, listingFetches: 0, metadata: 1, economy: 1 } });
    expect(f.calls).toHaveLength(2);
  });
  it("separates quote caches by patch", async () => {
    const f = setup();
    await f.service.fetchStashQuote(TEXT, "Forbidden Rites", undefined, "0.5.5");
    const next = await f.service.fetchStashQuote(TEXT, "Forbidden Rites", undefined, "0.5.5b");
    expect(next.cached).toBeUndefined();
    expect(next.patch).toBe("0.5.5b");
    expect(f.calls.filter(call => call.url.includes("/search/"))).toHaveLength(2);
  });
  it("does not reuse another league's quote", async () => {
    const { service, calls } = setup();
    await service.fetchStashQuote(TEXT, "Standard");
    const result = await service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(result.league).toBe("Forbidden Rites");
    expect(result.cached).toBeUndefined();
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(2);
  });
  it("invalidates earlier advanced-unique parsing quotes while retaining existing rare quotes", async () => {
    const unique = TEXT.replace("Rarity: Rare", "Rarity: Unique").replace("+120 to maximum Life", "{ Unique Modifier }\n+120 to maximum Life\n--------\nFlavour line without punctuation");
    const first = setup();
    await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    await first.service.fetchStashQuote(unique, "Forbidden Rites");
    const file = path.join(first.directory, "stash-market-quotes.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const key = Object.keys(saved).find(key => key.includes(":advanced-unique-1"))!;
    expect(key).toBeTruthy();
    saved[key.replace(":advanced-unique-1", "")] = saved[key];
    delete saved[key];
    writeFileSync(file, JSON.stringify(saved));
    const next = setup({ directory: first.directory });
    expect((await next.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBe(true);
    expect(next.calls).toHaveLength(0);
    expect((await next.service.fetchStashQuote(unique, "Forbidden Rites")).cached).toBeUndefined();
    expect(next.calls).toHaveLength(4);
  });
  it("can reuse a fresh quote from disk and expires old quotes", async () => {
    let now = new Date();
    const first = setup({ now: () => now });
    await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    const second = setup({ directory: first.directory, now: () => now });
    expect((await second.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBe(true);
    expect(second.calls).toHaveLength(0);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await second.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBeUndefined();
    expect(second.calls).toHaveLength(4);
  });
  it("expires an earlier structured deadline from the disk and memory caches", async () => {
    let now = new Date("2026-09-14T12:00:00Z");
    const first = setup({ now: () => now });
    await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    const file = path.join(first.directory, "stash-market-quotes.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { validUntil?: string }>;
    for (const quote of Object.values(saved)) quote.validUntil = "2026-09-14T12:02:00Z";
    writeFileSync(file, JSON.stringify(saved));
    const second = setup({ directory: first.directory, now: () => now });
    expect((await second.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBe(true);
    expect(second.calls).toHaveLength(0);
    now = new Date("2026-09-14T12:02:00Z");
    const third = setup({ directory: first.directory, now: () => now });
    expect((await third.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBeUndefined();
    expect(third.calls).toHaveLength(4);
    expect((await second.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBeUndefined();
    expect(second.calls).toHaveLength(4);
  });
  it("keeps cache entries without structured expiry compatible within the normal lifetime", async () => {
    const now = () => new Date("2026-09-14T12:00:00Z");
    const first = setup({ now });
    await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    const file = path.join(first.directory, "stash-market-quotes.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { validUntil?: string }>;
    for (const quote of Object.values(saved)) delete quote.validUntil;
    writeFileSync(file, JSON.stringify(saved));
    const second = setup({ directory: first.directory, now });
    expect((await second.service.fetchStashQuote(TEXT, "Forbidden Rites")).cached).toBe(true);
    expect(second.calls).toHaveLength(0);
  });
  it("never retries 429 and surfaces 403 as unpriced unavailable", async () => {
    for (const code of [429, 403]) {
      const { service, calls } = setup({ respond: () => Response.json({}, { status: code, headers: { "retry-after": "60" } }) });
      const result = await service.fetchStashQuote(TEXT, "Forbidden Rites");
      expect(result).toMatchObject({ state: "unavailable", confidence: 0 });
      expect(result.fair).toBeUndefined();
      expect(calls.filter(call => call.url.includes("pathofexile.com"))).toHaveLength(1);
    }
  });
  it("exposes an observed restriction after restart without sending or retrying requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    const first = setup({ respond: url => url.includes("poe.ninja") ? Response.json(ratesPayload) : Response.json({}, { status: 429, headers: { "retry-after": "60" } }) });
    const denied = await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(denied.retryAfter).toBe("2026-09-14T12:01:00.000Z");
    expect(first.calls.filter(call => call.url.includes("pathofexile.com"))).toHaveLength(1);
    const resumed = setup({ directory: first.directory });
    expect(resumed.service.rateLimitedUntilIso()).toBe(denied.retryAfter);
    expect(resumed.service.tradeBudget().restrictedUntilIso).toBe(denied.retryAfter);
    expect((await resumed.service.fetchStashQuote(TEXT, "Forbidden Rites")).retryAfter).toBe(denied.retryAfter);
    expect(resumed.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resumed.service.rateLimitedUntilIso()).toBeUndefined();
    expect((await resumed.service.fetchStashQuote(TEXT, "Forbidden Rites")).state).toBe("priced");
  });
  it("does not fetch cancelled work or resolve auto to an unrelated league", async () => {
    const { service, calls } = setup();
    expect((await service.fetchStashQuote(TEXT, "auto")).state).toBe("unavailable");
    expect((await service.fetchStashQuote(TEXT, "Forbidden Rites", () => false)).state).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });
  it("pauses further trade requests for the session after an access failure", async () => {
    const { service, calls } = setup({ respond: url => url.includes("poe.ninja") ? Response.json(ratesPayload) : Response.json({}, { status: 403 }) });
    await service.fetchStashQuote(TEXT, "Forbidden Rites");
    const count = calls.length;
    const second = await service.fetchStashQuote(TEXT.replace("120", "130"), "Forbidden Rites");
    expect(second.reasons.join(" ")).toMatch(/paused for this session/);
    expect(calls).toHaveLength(count);
  });
  it("checks cancellation between the stat catalog and the item search", async () => {
    let active = true;
    const { service, calls } = setup({ respond: url => { if (url.includes("poe.ninja")) return Response.json(ratesPayload); active = false; return Response.json(statPayload); } });
    expect((await service.fetchStashQuote(TEXT, "Forbidden Rites", () => active)).state).toBe("unavailable");
    expect(calls).toHaveLength(2);
  });
  it("waits for normal server-advertised capacity before pricing the next batch item", async () => {
    vi.useFakeTimers();
    const { service, calls } = setup({ respond: url => Response.json(url.includes("poe.ninja") ? ratesPayload : url.includes("/data/stats") ? statPayload : url.includes("/search/") ? { id: "query-id", result: ids } : payload,
      { headers: { "x-rate-limit-ip": "2:1:1", "x-rate-limit-ip-state": "1:1:0" } }) });
    const pending = service.fetchStashQuote(TEXT, "Forbidden Rites");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).state).toBe("priced");
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(1);
  });
  it("enforces an additional server-declared account scope and stores only safe rate diagnostics", async () => {
    vi.useFakeTimers();
    const { service, calls, directory } = setup({ respond: url => Response.json(url.includes("poe.ninja") ? ratesPayload : url.includes("/data/stats") ? statPayload : url.includes("/search/") ? { id: "query-id", result: ids } : payload,
      { headers: { "x-rate-limit-rules": "ip,account", "x-rate-limit-ip": "1000:1:1", "x-rate-limit-ip-state": "1:1:0", "x-rate-limit-account": "2:1:1", "x-rate-limit-account-state": "1:1:0", "set-cookie": "do-not-log" } }) });
    const pending = service.fetchStashQuote(TEXT, "Forbidden Rites");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).state).toBe("priced");
    const diagnostics = readFileSync(path.join(directory, "trade-response-diagnostics.json"), "utf8");
    expect(diagnostics).toContain("x-rate-limit-account");
    expect(diagnostics).not.toContain("do-not-log");
    expect(diagnostics).not.toContain("seller-");
  });
  it("sees another already-running instance's newly persisted restriction before sending trade traffic", async () => {
    const first = setup({ respond: url => url.includes("poe.ninja") ? Response.json(ratesPayload) : Response.json({}, { status: 429, headers: { "retry-after": "60" } }) });
    const second = setup({ directory: first.directory });
    const denied = await first.service.fetchStashQuote(TEXT, "Forbidden Rites");
    const blocked = await second.service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(blocked.retryAfter).toBe(denied.retryAfter);
    expect(second.calls.filter(call => call.url.includes("pathofexile.com"))).toHaveLength(0);
  });
  it("cancels a queued stash lookup while waiting for normal capacity", async () => {
    vi.useFakeTimers();
    let active = true;
    const { service, calls } = setup({ respond: url => Response.json(url.includes("poe.ninja") ? ratesPayload : statPayload,
      { headers: { "x-rate-limit-ip": "2:1:1", "x-rate-limit-ip-state": "1:1:0" } }) });
    const pending = service.fetchStashQuote(TEXT, "Forbidden Rites", () => active);
    await vi.advanceTimersByTimeAsync(0);
    active = false;
    await vi.advanceTimersByTimeAsync(100);
    const quote = await pending;
    expect(quote.state).toBe("unavailable");
    expect(quote.reasons.join(" ")).toMatch(/cancelled/);
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(0);
  });
  it("uses fresh league-specific ninja rates for exalted offers without sending session credentials to ninja", async () => {
    const quoted = { result: payload.result.map(row => ({ ...row, listing: { ...row.listing, price: { currency: "exalted", amount: 20 } } })) };
    const { service, calls } = setup({ respond: url => Response.json(url.includes("poe.ninja") ? ratesPayload : url.includes("/data/stats") ? statPayload : url.includes("/search/") ? { id: "query-id", result: ids } : quoted) });
    service.configure({ poesessid: "test-cookie" });
    const result = await service.fetchStashQuote(TEXT, "Forbidden Rites");
    expect(result).toMatchObject({ state: "priced", fair: 4, currency: "chaos" });
    expect(result.reasons.join(" ")).toMatch(/poe.ninja.*Forbidden Rites/);
    expect(JSON.stringify(calls[0]!.init?.headers)).not.toContain("test-cookie");
    expect(calls[0]!.url).toContain("league=Forbidden%20Rites");
    expect(JSON.parse(String(calls[2]!.init?.body)).query.filters.trade_filters.filters.price).toBeUndefined();
  });
  it("falls back to native-chaos search when fresh exchange rates cannot be fetched", async () => {
    const { service, calls } = setup({ respond: url => Response.json(url.includes("poe.ninja") ? {} : url.includes("/data/stats") ? statPayload : url.includes("/search/") ? { id: "query-id", result: ids } : payload) });
    expect((await service.fetchStashQuote(TEXT, "Forbidden Rites")).state).toBe("priced");
    expect(JSON.parse(String(calls[2]!.init?.body)).query.filters.trade_filters.filters.price).toEqual({ option: "chaos" });
  });
  it("also keeps the older broad-comps cache isolated when configured leagues change", async () => {
    const { service, calls } = setup();
    service.configure({ league: "Standard" });
    await service.fetchComps(TEXT);
    service.configure({ league: "Forbidden Rites" });
    expect((await service.fetchComps(TEXT)).league).toBe("Forbidden Rites");
    expect(calls.filter(call => call.url.includes("/search/"))).toHaveLength(2);
  });
});
