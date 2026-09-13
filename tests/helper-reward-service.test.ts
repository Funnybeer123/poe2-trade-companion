import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelperRewardService, type HelperRewardOptions, type HelperRewardResult } from "../src/main/helperRewardService.js";
import type { CategorySnapshot } from "../src/core/priceHelper.js";
import type { RewardIdentity } from "../src/core/helperReward.js";

const START = Date.parse("2026-09-13T01:00:00Z"), MINUTE = 60_000;
const LEAGUE = "Runes of Aldur", ITEM = "Mystic Alloy", GEM = "Skill Level 20: Rain of Blades";
const itemNames = [ITEM, "Masterwork Rune", ...Array.from({ length: 8 }, (_, i) => `Test Item ${i}`)];
const catalogPayload = { result: [{ id: "currency", entries: itemNames.map(type => ({ type })) }, { id: "gem", entries: [{ type: "Rain of Blades" }, { type: "Hollow Shell" }] }] };
const directories: string[] = [];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; };
function listings(identity: RewardIdentity, offers: Array<[number, string]> = [[2, "chaos"], [4, "chaos"], [6, "chaos"]]): unknown {
  return { result: offers.map(([amount, currency], i) => ({ id: `listing-${i}`, item: { name: identity.kind === "unique" ? identity.name : "", baseType: identity.type, properties: identity.kind === "gem" ? [{ name: "Level", values: [[String(identity.gemLevel), 0]] }] : [] }, listing: { price: { amount, currency }, account: { name: `Private Seller ${i}` } } })) };
}
function rates(at = START, extra: Partial<CategorySnapshot> = {}): CategorySnapshot[] {
  return [{ category: "Currency", fetchedAt: new Date(at).toISOString(), prices: [{ id: "divine", name: "Divine Orb", chaos: 100 }, { id: "exalted", name: "Exalted Orb", chaos: 2 }], ...extra }];
}
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "poe-helper-reward-test-")); directories.push(directory);
  let clock = START;
  const readCatalog = vi.fn<HelperRewardOptions["readCatalog"]>(async () => catalogPayload);
  const fetchReward = vi.fn<HelperRewardOptions["fetchReward"]>(async identity => ({ payload: listings(identity), fetchedAt: new Date(clock).toISOString() }));
  const options: HelperRewardOptions = { directory, readCatalog, fetchReward, now: () => clock };
  const service = new HelperRewardService(options);
  return { service, options, readCatalog, fetchReward, setTime: (time: number) => { clock = time; } };
}
async function ready() { const context = setup(); await context.service.refreshCatalog(); return context; }
afterEach(() => {
  const root = path.resolve(tmpdir());
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith("poe-helper-reward-test-")) throw new Error("Unexpected test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("reward catalog lifecycle", () => {
  it("does no work on construction and deduplicates an explicitly requested catalog read", async () => {
    const { service, readCatalog, fetchReward } = setup();
    expect(readCatalog).not.toHaveBeenCalled(); expect(fetchReward).not.toHaveBeenCalled();
    const gate = deferred<unknown>(); readCatalog.mockReturnValueOnce(gate.promise);
    const first = service.refreshCatalog(), second = service.refreshCatalog();
    expect(first).toBe(second); expect(readCatalog).toHaveBeenCalledTimes(1);
    gate.resolve(catalogPayload); await first;
    expect(service.identity(GEM)).toMatchObject({ kind: "gem", name: "Rain of Blades", gemLevel: 20 });
  });
  it("restores a valid catalog without network and refreshes at the 24-hour boundary", async () => {
    const { service, options, readCatalog, setTime } = await ready();
    const restored = new HelperRewardService(options);
    expect(restored.catalog).toEqual(service.catalog);
    await restored.refreshCatalog(); expect(readCatalog).toHaveBeenCalledTimes(1);
    setTime(START + 24 * 60 * MINUTE - 1); await restored.refreshCatalog(); expect(readCatalog).toHaveBeenCalledTimes(1);
    setTime(START + 24 * 60 * MINUTE); await restored.refreshCatalog(); expect(readCatalog).toHaveBeenCalledTimes(2);
  });
  it("retains the previous usable catalog and reports an invalid replacement", async () => {
    const { service, options, readCatalog, setTime } = await ready();
    const previous = readFileSync(path.join(options.directory, "catalog.json"), "utf8");
    setTime(START + 24 * 60 * MINUTE); readCatalog.mockResolvedValueOnce({ result: "invalid" });
    await service.refreshCatalog();
    expect(service.identity(GEM)?.gemLevel).toBe(20); expect(service.catalogError).toBeTruthy();
    expect(readFileSync(path.join(options.directory, "catalog.json"), "utf8")).toBe(previous);
    await service.refreshCatalog(); expect(service.catalogError).toBeUndefined();
  });
  it("retains cached identities when the catalog request fails", async () => {
    const { service, readCatalog, setTime } = await ready();
    setTime(START + 24 * 60 * MINUTE); readCatalog.mockRejectedValueOnce(new Error("Catalog request failed"));
    await service.refreshCatalog();
    expect(service.identity(ITEM)?.name).toBe(ITEM); expect(service.catalogError).toContain("Catalog request failed");
  });
});

describe("reward price ranges and exact identities", () => {
  it("converts mixed currencies using fresh rates and scales the entire range for stacks", async () => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementation(async identity => ({ payload: listings(identity, [[20, "chaos"], [0.5, "divine"], [30, "exalted"]]) }));
    await service.request(ITEM, LEAGUE, () => true);
    expect(service.row(ITEM, LEAGUE, rates())).toMatchObject({ state: "priced", source: "trade", unit: 20, total: 20, rangeHigh: 60, currency: "chaos", sampleCount: 3 });
    expect(service.row(`3x ${ITEM}`, LEAGUE, rates())).toMatchObject({ unit: 20, total: 60, rangeHigh: 180, currency: "chaos", quantity: 3 });
    const valuableStack = service.row(`6x ${ITEM}`, LEAGUE, rates())!;
    expect(valuableStack).toMatchObject({ unit: 0.2, currency: "div", valueTier: "high" });
    expect(valuableStack.total).toBeCloseTo(1.2); expect(valuableStack.rangeHigh).toBeCloseTo(3.6);
    expect(fetchReward).toHaveBeenCalledTimes(1);
  });
  it("uses an explicit per-item range when the OCR quantity is unreadable", async () => {
    const { service } = await ready(); await service.request(`IX ${ITEM}`, LEAGUE, () => true);
    const row = service.row(`IX ${ITEM}`, LEAGUE, rates())!;
    expect(row).toMatchObject({ state: "priced", unit: 2, rangeHigh: 6, currency: "chaos" });
    expect(row.quantity).toBeUndefined(); expect(row.total).toBeUndefined();
    expect(row.detail).toContain("each · quantity unreadable");
  });
  it("can display all-divine offers without conversion rates but does not guess mixed currencies", async () => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementationOnce(async identity => ({ payload: listings(identity, [[2, "divine"], [3, "divine"], [4, "divine"]]) }));
    await service.request(ITEM, LEAGUE, () => true);
    expect(service.row(ITEM, LEAGUE, [])).toMatchObject({ currency: "div", unit: 2, total: 2, rangeHigh: 4, valueTier: "high" });
    fetchReward.mockImplementationOnce(async identity => ({ payload: listings(identity, [[2, "chaos"], [1, "divine"]]) }));
    await service.request("Masterwork Rune", LEAGUE, () => true);
    expect(service.row("Masterwork Rune", LEAGUE, [])).toMatchObject({ state: "no-data", lookupState: "unavailable" });
  });
  it.each(["stale", "failed", "future"])("does not use %s exchange rates to compare mixed listings", async kind => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementation(async identity => ({ payload: listings(identity, [[2, "chaos"], [1, "divine"]]) }));
    await service.request(ITEM, LEAGUE, () => true);
    const snapshots = kind === "stale" ? rates(START - 30 * MINUTE) : kind === "future" ? rates(START + MINUTE) : rates(START, { error: "HTTP 429" });
    const row = service.row(ITEM, LEAGUE, snapshots)!;
    expect(row).toMatchObject({ state: "no-data", lookupState: "unavailable" }); expect(row.total).toBeUndefined();
    expect(row.detail).toContain("Refresh currency rates");
  });
  it("requires three samples before emphasizing high-value listing ranges", async () => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementationOnce(async identity => ({ payload: listings(identity, [[10, "divine"], [20, "divine"]]) }));
    await service.request(ITEM, LEAGUE, () => true); expect(service.row(ITEM, LEAGUE, rates())?.valueTier).toBeUndefined();
    fetchReward.mockImplementationOnce(async identity => ({ payload: listings(identity, [[10, "divine"], [20, "divine"], [30, "divine"]]) }));
    await service.request("Masterwork Rune", LEAGUE, () => true); expect(service.row("Masterwork Rune", LEAGUE, rates())?.valueTier).toBe("very-high");
  });
  it("does not request unknown items, unknown-level gems or random reward descriptions", async () => {
    const { service, fetchReward } = await ready();
    for (const text of ["Not A Known Gem", "Rain of Blades", "Skill Level 2O: Rain of Blades", "Rare Unique Ring", "Random Currency"]) await service.request(text, LEAGUE, () => true);
    expect(fetchReward).not.toHaveBeenCalled();
    expect(service.row("Rain of Blades", LEAGUE, [])).toMatchObject({ state: "no-data", liveLookup: false });
    expect(service.row("Rare Unique Ring", LEAGUE, [])?.detail).toContain("actual item is not known");
    expect(service.tradeUrl("Rain of Blades", LEAGUE)).toBeUndefined();
    const url = new URL(service.tradeUrl(GEM, LEAGUE)!);
    expect(url.origin).toBe("https://www.pathofexile.com");
    expect(JSON.parse(url.searchParams.get("q")!).query.filters.misc_filters.filters.gem_level).toEqual({ min: 20, max: 20 });
  });
});

describe("reward request cache, bounds and cancellation", () => {
  it("shares an in-flight identity across stack counts while isolating leagues and gem levels", async () => {
    const { service, fetchReward } = await ready(); const gate = deferred<HelperRewardResult>();
    fetchReward.mockReturnValueOnce(gate.promise);
    const first = service.request(GEM, LEAGUE, () => true), duplicate = service.request(`3x ${GEM}`, LEAGUE, () => true);
    expect(first).toBe(duplicate); expect(service.row(GEM, LEAGUE, [])?.lookupState).toBe("pending");
    await Promise.resolve(); expect(fetchReward).toHaveBeenCalledTimes(1);
    gate.resolve({ payload: listings(service.identity(GEM)!) }); await first;
    await service.request(`3x ${GEM}`, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(1);
    await service.request(GEM, "HC Runes of Aldur", () => true);
    await service.request("Skill Level 19: Rain of Blades", LEAGUE, () => true);
    expect(fetchReward).toHaveBeenCalledTimes(3);
    expect(fetchReward.mock.calls.map(([identity, league]) => [identity.gemLevel, league])).toEqual([[20, LEAGUE], [20, "HC Runes of Aldur"], [19, LEAGUE]]);
  });
  it("serializes at most six queued identities and admits new work after the queue drains", async () => {
    const { service, fetchReward } = await ready(); const gate = deferred<void>();
    fetchReward.mockImplementation(async identity => { await gate.promise; return { payload: listings(identity) }; });
    const names = itemNames.slice(0, 7), requests = names.map(name => service.request(name, LEAGUE, () => true));
    await Promise.resolve(); expect(fetchReward).toHaveBeenCalledTimes(1);
    expect(names.slice(0, 6).every(name => service.row(name, LEAGUE, [])?.lookupState === "pending")).toBe(true);
    expect(service.row(names[6]!, LEAGUE, [])?.lookupState).toBeUndefined();
    gate.resolve(); await Promise.all(requests); expect(fetchReward).toHaveBeenCalledTimes(6);
    await service.request(names[6]!, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(7);
    expect(fetchReward.mock.calls.map(([identity]) => identity.name)).toEqual(names);
  });
  it("skips queued work whose cancellation gate closes before execution", async () => {
    const { service, fetchReward } = await ready(); const gate = deferred<HelperRewardResult>(); let secondAllowed = true;
    fetchReward.mockReturnValueOnce(gate.promise);
    const first = service.request(ITEM, LEAGUE, () => true);
    const second = service.request("Masterwork Rune", LEAGUE, () => secondAllowed);
    await Promise.resolve(); secondAllowed = false;
    gate.resolve({ payload: listings(service.identity(ITEM)!) }); await Promise.all([first, second]);
    expect(fetchReward).toHaveBeenCalledTimes(1); expect(service.row("Masterwork Rune", LEAGUE, [])?.source).toBeUndefined();
    secondAllowed = true; await service.request("Masterwork Rune", LEAGUE, () => secondAllowed); expect(fetchReward).toHaveBeenCalledTimes(2);
  });
  it("discards an in-flight result after cancellation and lets a later explicit request retry", async () => {
    const { service, fetchReward } = await ready(); const gate = deferred<HelperRewardResult>(); let allowed = true;
    fetchReward.mockReturnValueOnce(gate.promise);
    const request = service.request(ITEM, LEAGUE, () => allowed); await Promise.resolve();
    expect(fetchReward.mock.calls[0]![2]?.()).toBe(true); allowed = false;
    gate.resolve({ payload: listings(service.identity(ITEM)!) }); await request;
    expect(service.row(ITEM, LEAGUE, [])).toMatchObject({ state: "no-data" });
    expect(service.row(ITEM, LEAGUE, [])?.lookupState).toBeUndefined();
    allowed = true; await service.request(ITEM, LEAGUE, () => allowed);
    expect(fetchReward).toHaveBeenCalledTimes(2); expect(service.row(ITEM, LEAGUE, [])?.state).toBe("priced");
  });
  it("reuses fresh quotes for ten minutes and refreshes at the expiry boundary", async () => {
    const { service, fetchReward, setTime } = await ready(); await service.request(ITEM, LEAGUE, () => true);
    setTime(START + 10 * MINUTE - 1); await service.request(ITEM, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(1);
    setTime(START + 10 * MINUTE); expect(service.row(ITEM, LEAGUE, [])?.stale).toBe(true);
    await service.request(ITEM, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(2); expect(service.row(ITEM, LEAGUE, [])?.stale).toBe(false);
  });
  it("honors the provider's sample timestamp instead of making an old quote look fresh", async () => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementation(async identity => ({ payload: listings(identity, [[10, "divine"], [20, "divine"], [30, "divine"]]), fetchedAt: new Date(START - 11 * MINUTE).toISOString() }));
    await service.request(ITEM, LEAGUE, () => true);
    const row = service.row(ITEM, LEAGUE, rates())!;
    expect(row.stale).toBe(true); expect(row.valueTier).toBeUndefined(); expect(row.detail).toContain("stale");
  });
  it.each(["not-a-date", "1970-01-01T00:00:00Z", new Date(START + MINUTE).toISOString()])("rejects invalid provider freshness %s", async fetchedAt => {
    const { service, fetchReward } = await ready();
    fetchReward.mockImplementation(async identity => ({ payload: listings(identity), fetchedAt }));
    await service.request(ITEM, LEAGUE, () => true);
    const row = service.row(ITEM, LEAGUE, [])!;
    expect(row).toMatchObject({ state: "no-data", lookupState: "error" });
    expect(row.detail).toContain("timestamp"); expect(row.total).toBeUndefined(); expect(row.valueTier).toBeUndefined();
  });
  it.each(["failure", "empty"])("shows pending while retrying an earlier %s", async kind => {
    const { service, fetchReward, setTime } = await ready();
    if (kind === "failure") fetchReward.mockRejectedValueOnce(new Error("HTTP 429")); else fetchReward.mockResolvedValueOnce({ payload: { result: [] } });
    await service.request(ITEM, LEAGUE, () => true); setTime(START + MINUTE);
    const gate = deferred<HelperRewardResult>(); fetchReward.mockReturnValueOnce(gate.promise);
    const retry = service.request(ITEM, LEAGUE, () => true);
    const pending = service.row(ITEM, LEAGUE, []);
    gate.resolve({ payload: listings(service.identity(ITEM)!) }); await retry;
    expect(pending).toMatchObject({ state: "no-data", lookupState: "pending" });
    expect(pending?.detail).toContain("Checking"); expect(service.row(ITEM, LEAGUE, [])?.state).toBe("priced");
  });
  it.each(["failure", "empty"])("throttles a %s result for one minute", async kind => {
    const { service, fetchReward, setTime } = await ready();
    if (kind === "failure") fetchReward.mockRejectedValueOnce(new Error("HTTP 429")); else fetchReward.mockResolvedValueOnce({ payload: { result: [] } });
    await service.request(ITEM, LEAGUE, () => true);
    expect(service.row(ITEM, LEAGUE, [])?.lookupState).toBe(kind === "failure" ? "error" : "unavailable");
    setTime(START + MINUTE - 1); await service.request(ITEM, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(1);
    setTime(START + MINUTE); await service.request(ITEM, LEAGUE, () => true); expect(fetchReward).toHaveBeenCalledTimes(2);
    expect(service.row(ITEM, LEAGUE, [])?.state).toBe("priced");
  });
  it("persists only anonymous validated quotes and restores their freshness", async () => {
    const { service, options, fetchReward } = await ready(); await service.request(GEM, LEAGUE, () => true);
    const raw = readFileSync(path.join(options.directory, "reward-quotes.json"), "utf8");
    expect(raw).not.toContain("Private Seller"); expect(raw).not.toContain("listing-"); expect(raw).not.toContain("account");
    const cached = Object.values(JSON.parse(raw)) as Array<{ at: number; offers: unknown[] }>;
    expect(cached).toHaveLength(1); expect(Object.keys(cached[0]!).sort()).toEqual(["at", "offers"]);
    expect(cached[0]!.offers).toEqual([{ amount: 2, currency: "chaos" }, { amount: 4, currency: "chaos" }, { amount: 6, currency: "chaos" }]);
    const restored = new HelperRewardService(options); await restored.request(GEM, LEAGUE, () => true);
    expect(fetchReward).toHaveBeenCalledTimes(1); expect(restored.row(GEM, LEAGUE, [])).toMatchObject({ state: "priced", stale: false, sampleCount: 3 });
  });
  it.each(["future", "expired", "invalid amount"])("discards a %s persisted quote", async kind => {
    const { service, options } = await ready();
    const identity = service.identity(ITEM)!;
    const key = JSON.stringify([LEAGUE, identity.kind, identity.name, identity.type, identity.gemLevel]);
    const quote = { at: kind === "future" ? START + MINUTE : kind === "expired" ? START - 25 * 60 * MINUTE : START, offers: [{ amount: kind === "invalid amount" ? "5" : 5, currency: "chaos" }] };
    writeFileSync(path.join(options.directory, "reward-quotes.json"), JSON.stringify({ [key]: quote }));
    const restored = new HelperRewardService(options);
    expect(restored.row(ITEM, LEAGUE, [])).toMatchObject({ state: "no-data" });
    expect(restored.row(ITEM, LEAGUE, [])?.total).toBeUndefined();
  });
});
