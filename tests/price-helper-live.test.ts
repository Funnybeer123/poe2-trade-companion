import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helperDefaults } from "../src/core/priceHelper.js";
import { PriceHelperService, type HelperServiceOptions } from "../src/main/priceHelperService.js";
import type { HelperRewardResult } from "../src/main/helperRewardService.js";

const gemText = "Skill Level 20: Rain of Blades";
const secondGemText = "Skill Level 20: Wardbound Minions";
const region = { x: 100, y: 120, width: 500, height: 600, clientWidth: 1920, clientHeight: 1080 };
const lines = [
  { text: gemText, y: 12, height: 22 },
  { text: "1x Unreadable Reward", y: 140, height: 19 },
  { text: secondGemText, y: 398, height: 31 },
];
const target = { left: 0, top: 0, width: 1920, height: 1080 };
const captureResult = (rows = lines): Record<string, unknown> => ({ ok: true, target, lines: rows });
const catalog = { result: [
  { id: "gem", entries: [{ type: "Rain of Blades" }, { type: "Wardbound Minions" }] },
  { id: "currency", entries: [{ type: "Mystic Alloy" }] },
] };
const services: PriceHelperService[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T08:00:00Z")); });
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); });

function offers(type = "Rain of Blades"): HelperRewardResult {
  return { fetchedAt: new Date(Date.now()).toISOString(), payload: { result: [2, 4, 6].map((amount, index) => ({
    id: `fixture-${index}`, item: { name: "", typeLine: type, baseType: type, properties: [{ name: "Level", values: [["20 (Max)", 0]] }] },
    listing: { account: { name: `FixtureSeller${index}` }, price: { amount, currency: "chaos" } },
  })) } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function setup(livePrices = true) {
  const directory = mkdtempSync(path.join(tmpdir(), "poe-helper-live-test-"));
  const capture = {
    read: vi.fn<HelperServiceOptions["capture"]["read"]>(async () => ({ ok: false, error: "Paused: game not foreground" })),
    calibrate: vi.fn(async () => ({ ok: true, region })), close: vi.fn(),
  };
  // Every network dependency is replaced; an unrecognized endpoint fails the test fixture.
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.origin === "https://www.pathofexile.com" && url.pathname === "/api/trade2/data/items") return new Response(JSON.stringify(catalog));
    if (url.origin !== "https://poe.ninja" || url.pathname !== "/poe2/api/economy/exchange/current/overview") throw new Error("Unexpected fixture endpoint");
    const category = url.searchParams.get("type");
    const entries = category === "Currency" ? [
      { id: "divine", name: "Divine Orb", value: 10 }, { id: "exalted", name: "Exalted Orb", value: 0.2 }, { id: "chaos", name: "Chaos Orb", value: 1 },
    ] : category === "Verisium" ? [{ id: "mystic", name: "Mystic Alloy", value: 3 }] : [{ id: "other", name: `Fixture ${category}`, value: 1 }];
    return new Response(JSON.stringify({ core: { primary: "chaos", rates: { divine: 0.1, exalted: 5 } }, items: entries.map(({ id, name }) => ({ id, name })), lines: entries.map(({ id, value }) => ({ id, primaryValue: value })) }));
  });
  const fetchReward = vi.fn<NonNullable<HelperServiceOptions["fetchReward"]>>(async identity => offers(identity.type));
  const show = vi.fn<HelperServiceOptions["show"]>(async () => {}), hide = vi.fn();
  const service = new PriceHelperService({ directory, capture, show, hide, fetchImpl: fetchImpl as typeof fetch, fetchReward, now: () => Date.now() });
  services.push(service);
  service.configure({ ...helperDefaults(), livePrices, regions: { prices: region } });
  await service.refresh();
  expect(service.status().catalogCount).toBe(3);
  show.mockClear(); hide.mockClear();
  return { service, capture, show, hide, fetchReward, fetchImpl };
}

describe("live reward lookup integration", () => {
  it("automatically fills exact gem prices beside their original OCR rows", async () => {
    const { service, capture, show, fetchReward } = await setup();
    capture.read.mockResolvedValue(captureResult());
    service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchReward).toHaveBeenCalledTimes(2);
    expect(fetchReward).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "Rain of Blades", kind: "gem", gemLevel: 20 }), "Runes of Aldur", expect.any(Function));
    await vi.advanceTimersByTimeAsync(750);
    const rows = show.mock.calls.at(-1)![0];
    expect(rows.map(({ text, y, height }) => ({ text, y, height }))).toEqual(lines);
    expect(rows[0]).toMatchObject({ state: "priced", source: "trade", total: 2, rangeHigh: 6, currency: "chaos", sampleCount: 3 });
    expect(rows[1]).toMatchObject({ state: "unknown" }); expect(rows[1].total).toBeUndefined();
    expect(rows[2]).toMatchObject({ name: "Wardbound Minions", state: "priced", source: "trade", total: 2, rangeHigh: 6 });
    expect(rows[0].detail).toContain("quality, corruption and sockets vary");
    expect(fetchReward).toHaveBeenCalledTimes(2);
  });

  it("discards late live prices and queued requests after game focus is lost", async () => {
    const { service, capture, show, hide, fetchReward } = await setup();
    const pending = deferred<HelperRewardResult>(); fetchReward.mockImplementationOnce(() => pending.promise);
    capture.read.mockResolvedValueOnce(captureResult());
    service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchReward).toHaveBeenCalledTimes(1); expect(show).toHaveBeenCalledTimes(1);
    const canRun = fetchReward.mock.calls[0]![2]!; expect(canRun()).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(canRun()).toBe(false); expect(hide).toHaveBeenCalled(); expect(service.status().rows).toEqual([]);
    pending.resolve(offers()); await vi.advanceTimersByTimeAsync(0);
    expect(fetchReward).toHaveBeenCalledTimes(1); expect(show).toHaveBeenCalledTimes(1);
    expect(service.status().lastRows?.filter(row => row.name).every(row => row.state === "no-data")).toBe(true);
    expect(service.lookup(gemText)[0].state).toBe("no-data");
  });

  it("does not revive the overlay or save late automatic prices after Stop", async () => {
    const { service, capture, show, fetchReward } = await setup();
    const pending = deferred<HelperRewardResult>(); fetchReward.mockImplementationOnce(() => pending.promise);
    capture.read.mockResolvedValue(captureResult([lines[0]]));
    service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchReward).toHaveBeenCalledTimes(1); expect(show).toHaveBeenCalledTimes(1);
    service.stop(); expect(fetchReward.mock.calls[0]![2]!()).toBe(false);
    pending.resolve(offers()); await vi.advanceTimersByTimeAsync(1500);
    expect(service.status().running).toBe(false); expect(service.status().rows).toEqual([]);
    expect(service.status().lastRows?.[0]).toMatchObject({ text: gemText, y: 12, height: 22, state: "no-data" });
    expect(show).toHaveBeenCalledTimes(1); expect(capture.read).toHaveBeenCalledTimes(1);
  });

  it("ignores a late capture containing eligible gems after Stop", async () => {
    const { service, capture, show, fetchReward } = await setup();
    const pending = deferred<Record<string, unknown>>(); capture.read.mockImplementationOnce(() => pending.promise);
    service.start(); service.stop(); pending.resolve(captureResult()); await vi.advanceTimersByTimeAsync(0);
    expect(show).not.toHaveBeenCalled(); expect(fetchReward).not.toHaveBeenCalled();
    expect(service.status().rows).toEqual([]); expect(service.status().lastRows).toEqual([]);
  });

  it.each(["focus loss", "Stop"])("retains and reprices the last list after %s with automatic live prices disabled", async transition => {
    const { service, capture, show, fetchReward } = await setup(false);
    capture.read.mockResolvedValueOnce(captureResult());
    service.start(); await vi.advanceTimersByTimeAsync(0);
    const stamp = service.status().lastCaptureAt;
    expect(fetchReward).not.toHaveBeenCalled(); expect(show).toHaveBeenCalledTimes(1);
    if (transition === "Stop") service.stop(); else await vi.advanceTimersByTimeAsync(750);
    expect(service.status().rows).toEqual([]);
    const result = await service.lookupLive(gemText);
    expect(fetchReward).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ state: "priced", source: "trade", total: 2, rangeHigh: 6, currency: "chaos" });
    const status = service.status();
    expect(status.config.livePrices).toBe(false); expect(status.rows).toEqual([]); expect(status.lastCaptureAt).toBe(stamp);
    expect(status.lastRows?.map(({ text, y, height }) => ({ text, y, height }))).toEqual(lines);
    expect(status.lastRows?.[0]).toMatchObject({ state: "priced", total: 2 });
    expect(status.lastRows?.[1].state).toBe("unknown"); expect(status.lastRows?.[2].state).toBe("no-data");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("never sends unknown identities or unspecified gem levels for live pricing", async () => {
    const { service, capture, fetchReward } = await setup();
    capture.read.mockResolvedValue(captureResult([{ text: "Unknown Reward", y: 10, height: 20 }, { text: "Rain of Blades", y: 120, height: 20 }]));
    service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(service.status().rows.map(row => Boolean(row.liveLookup))).toEqual([false, false]);
    await expect(service.lookupLive("Unknown Reward")).rejects.toThrow("No exact trade identity");
    await expect(service.lookupLive("Rain of Blades")).rejects.toThrow("No exact trade identity");
    expect(fetchReward).not.toHaveBeenCalled();
  });

  it("prefers a verified exchange-feed value instead of scheduling another item lookup", async () => {
    const { service, capture, fetchReward } = await setup();
    capture.read.mockResolvedValue(captureResult([{ text: "2x Mystic Alloy", y: 36, height: 24 }]));
    service.start(); await vi.advanceTimersByTimeAsync(750);
    const row = service.status().rows[0];
    expect(row).toMatchObject({ name: "Mystic Alloy", state: "priced", quantity: 2, unit: 3, total: 6, currency: "chaos", y: 36, height: 24 });
    expect(row.source).toBeUndefined(); expect(row.liveLookup).toBeUndefined(); expect(fetchReward).not.toHaveBeenCalled();
  });

  it("rejects a manual lookup that finishes after Stop changes its generation", async () => {
    const { service, show, fetchReward } = await setup(false);
    const pending = deferred<HelperRewardResult>(); fetchReward.mockImplementationOnce(() => pending.promise);
    const request = service.lookupLive(gemText);
    const cancelled = expect(request).rejects.toThrow("Lookup cancelled");
    await vi.advanceTimersByTimeAsync(0); expect(fetchReward).toHaveBeenCalledTimes(1);
    service.stop(); pending.resolve(offers()); await cancelled;
    expect(service.lookup(gemText)[0].state).toBe("no-data"); expect(show).not.toHaveBeenCalled();
  });
});
