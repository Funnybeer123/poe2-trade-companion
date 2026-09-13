import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { helperDefaults } from "../src/core/priceHelper.js";
import { fetchHelperText, PriceHelperService } from "../src/main/priceHelperService.js";

const payload = { core: { primary: "divine", rates: { chaos: 200, exalted: 300 } }, items: [{ id: "divine", name: "Divine Orb" }], lines: [{ id: "divine", primaryValue: 1 }] };
const region = { x: 100, y: 100, width: 300, height: 300, clientWidth: 1920, clientHeight: 1080 };
const services: PriceHelperService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); });
function setup(fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("type=Currency") ? payload : { ...payload, items: [{ id: "other", name: `Other ${new URL(String(url)).searchParams.get("type")}` }], lines: [{ id: "other", primaryValue: 2 }] }), { status: 200 }))) {
  const directory = mkdtempSync(path.join(tmpdir(), "poe-price-helper-test-"));
  const capture = { read: vi.fn(async () => ({ ok: false, error: "Paused: game not foreground" } as Record<string, unknown>)), calibrate: vi.fn(async () => ({ ok: true, region })), close: vi.fn() };
  const options = { directory, capture, show: vi.fn(async () => {}), hide: vi.fn(), fetchImpl: fetchImpl as typeof fetch };
  const service = new PriceHelperService(options); services.push(service);
  return { service, options, capture, fetchImpl };
}
describe("price helper service safety", () => {
  it("does not capture or network on startup; requires calibration and data", () => {
    const { service, capture, fetchImpl } = setup();
    expect(service.start().running).toBe(false); expect(fetchImpl).not.toHaveBeenCalled(); expect(capture.read).not.toHaveBeenCalled();
    expect(service.status().config.autoRefresh).toBe(false);
  });
  it("fetches exactly five categories without credentials; coalesces and throttles refreshes", async () => {
    const { service, fetchImpl } = setup();
    await Promise.all([service.refresh(), service.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(5); await service.refresh(); expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(service.lookup("2x Divine Orb")[0]?.total).toBe(2);
    expect(service.status().categories.every(c => c.count === 1)).toBe(true);
  });
  it("isolates league caches and allows immediate refresh after switching league", async () => {
    const { service, options, fetchImpl } = setup(); await service.refresh();
    service.configure({ ...helperDefaults(), league: "Forbidden Rites" });
    expect(service.lookup("Divine Orb")[0]?.state).toBe("unknown");
    await service.refresh(); expect(fetchImpl).toHaveBeenCalledTimes(10);
    const persisted = new PriceHelperService(options); services.push(persisted);
    expect(persisted.status().config.league).toBe("Forbidden Rites"); expect(persisted.status().running).toBe(false);
    expect(persisted.lookup("Divine Orb")[0]?.state).toBe("priced");
    expect(readFileSync(path.join(options.directory, "settings.json"), "utf8")).not.toContain("POESESSID");
  });
  it.each([
    { name: "actual chaos conversion", rates: { chaos: 0.25, divine: 0.01 }, expected: { state: "priced", currency: "chaos", unit: 2, total: 6 } },
    { name: "genuine divine fallback", rates: { divine: 0.01 }, expected: { state: "priced", currency: "div", unit: 0.08, total: 0.24 } },
    { name: "missing display rates", rates: {}, expected: { state: "no-data" } },
  ])("reparses a legacy exalted-primary raw cache using $name", async ({ rates, expected }) => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const category = new URL(String(url)).searchParams.get("type");
      const name = category === "Currency" ? "Cached Rune" : `Other ${category}`;
      return new Response(JSON.stringify({ core: { primary: "exalted", rates }, items: [{ id: "item", name }], lines: [{ id: "item", primaryValue: 8 }] }));
    });
    const { service, options } = setup(fetchImpl); await service.refresh();
    const restored = new PriceHelperService(options); services.push(restored);
    const row = restored.lookup("3x Cached Rune")[0]!;
    expect(row).toMatchObject(expected);
    if (expected.state === "no-data") { expect(row.currency).toBeUndefined(); expect(row.total).toBeUndefined(); }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(restored.status().running).toBe(false);
  });
  it("preserves the last successful category on partial failure and reports stale", async () => {
    vi.useFakeTimers(); const { service, fetchImpl } = setup(); await service.refresh();
    await vi.advanceTimersByTimeAsync(60_001);
    fetchImpl.mockImplementation(async url => String(url).includes("type=Currency") ? new Response("busy", { status: 429 }) : new Response(JSON.stringify(payload), { status: 200 }));
    await service.refresh();
    const currency = service.status().categories.find(c => c.category === "Currency");
    expect(currency?.count).toBe(1); expect(currency?.error).toContain("429");
  });
  it("does not publish an old-league in-flight refresh after settings change", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const fetchImpl = vi.fn(async () => { await gate; return new Response(JSON.stringify(payload)); });
    const { service } = setup(fetchImpl);
    const refreshing = service.refresh(); service.configure({ ...helperDefaults(), league: "Forbidden Rites" });
    finish(); await refreshing;
    expect(service.status().categories.every(c => c.count === 0)).toBe(true);
  });
  it("keeps eight irregular Verisium reward rows aligned through an unknown item", async () => {
    const market: Record<string, Array<{ id: string; name: string; primaryValue: number }>> = {
      Currency: [{ id: "artificer", name: "Artificer's Orb", primaryValue: 0.01 }],
      Runes: [
        { id: "robust", name: "Greater Robust Rune", primaryValue: 1.5 },
        { id: "resolve", name: "Greater Resolve Rune", primaryValue: 0.04 },
        { id: "adept", name: "Greater Adept Rune", primaryValue: 0.0025 },
      ],
      Verisium: [
        { id: "olroth", name: "Olroth's Saga", primaryValue: 2 },
        { id: "vorana", name: "Vorana's Saga", primaryValue: 0.25 },
        { id: "uhtred", name: "Uhtred's Saga", primaryValue: 12 },
      ],
      Expedition: [{ id: "expedition", name: "Other Expedition", primaryValue: 1 }],
      UncutGems: [{ id: "gem", name: "Uncut Skill Gem (Level 19)", primaryValue: 1 }],
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const entries = market[new URL(String(url)).searchParams.get("type")!]!;
      return new Response(JSON.stringify({ core: payload.core, items: entries, lines: entries }));
    });
    const { service, capture, options } = setup(fetchImpl);
    await service.refresh();
    const captureRegion = { x: 627, y: 387, width: 465, height: 935, clientWidth: 3840, clientHeight: 2160 };
    service.configure({ ...helperDefaults(), regions: { prices: captureRegion } });
    const lines = [
      { text: "1x Olroth's Saga", y: 15, height: 36 },
      { text: "1x Vorana's Saga", y: 177, height: 36 },
      { text: "2x Uhtred's Saga", y: 339, height: 36 },
      { text: "1x Unreadable Reward", y: 501, height: 36 },
      { text: "3x Artificer's Orb", y: 589, height: 30 },
      { text: "lx Greater Robust Rune", y: 684, height: 30 },
      { text: "1x Greater Resolve Rune", y: 779, height: 30 },
      { text: "1x Greater Adept Rune", y: 874, height: 39 },
    ];
    const target = { left: 0, top: 0, width: 3840, height: 2160 };
    capture.read.mockResolvedValueOnce({ ok: true, target, lines });
    service.start();
    await vi.waitFor(() => expect(options.show).toHaveBeenCalledTimes(1));
    expect(capture.read).toHaveBeenCalledWith(captureRegion);
    const rows = service.status().rows;
    expect(rows.map(({ text, y, height }) => ({ text, y, height }))).toEqual(lines);
    expect(rows).toMatchObject([
      { name: "Olroth's Saga", quantity: 1, total: 2, currency: "div", valueTier: "high" },
      { name: "Vorana's Saga", quantity: 1, total: 50, currency: "chaos" },
      { name: "Uhtred's Saga", quantity: 2, total: 24, currency: "div", valueTier: "very-high" },
      { state: "unknown" },
      { name: "Artificer's Orb", quantity: 3, unit: 2, total: 6, currency: "chaos" },
      { name: "Greater Robust Rune", unit: 1.5, currency: "div", detail: "1.5 div each · quantity unreadable" },
      { name: "Greater Resolve Rune", quantity: 1, total: 8, currency: "chaos" },
      { name: "Greater Adept Rune", quantity: 1, total: 0.5, currency: "chaos" },
    ]);
    expect(rows[3]?.total).toBeUndefined(); expect(rows[3]?.name).toBeUndefined();
    expect(rows[5]?.total).toBeUndefined(); expect(rows[5]?.quantity).toBeUndefined();
    expect(options.show).toHaveBeenCalledWith(rows, target, service.status().config);
    expect(service.status().message).toBe("Scanning prices · 8 rows");
  });
  it("skips missing, invalid, and clipped OCR boxes without closing valid row gaps", async () => {
    const { service, capture, options } = setup(); await service.refresh(); await service.calibrate();
    const invalid = [
      { text: "Divine Orb", height: 20 },
      { text: "Divine Orb", y: 25 },
      { text: "Divine Orb", y: NaN, height: 20 },
      { text: "Divine Orb", y: Infinity, height: 20 },
      { text: "Divine Orb", y: 30, height: NaN },
      { text: "Divine Orb", y: 40, height: Infinity },
      { text: "Divine Orb", y: 50, height: "20" },
      { text: "Divine Orb", y: 60, height: 0 },
      { text: "Divine Orb", y: 70, height: -1 },
      { text: "Divine Orb", y: 80, height: 200 },
      { text: "Divine Orb", y: -1, height: 20 },
      { text: "Divine Orb", y: 300, height: 20 },
      { text: "Divine Orb", y: 290, height: 11 },
    ];
    const valid = [
      { text: "Divine Orb", y: 0, height: 18 },
      { text: "2x Divine Orb", y: 100, height: 24 },
      { text: "3x Divine Orb", y: 282, height: 18 },
    ];
    capture.read.mockResolvedValueOnce({ ok: true, target: {}, lines: [valid[0], ...invalid, ...valid.slice(1)] });
    service.start();
    await vi.waitFor(() => expect(options.show).toHaveBeenCalledTimes(1));
    expect(service.status().rows.map(({ text, y, height, total }) => ({ text, y, height, total }))).toEqual(valid.map((row, i) => ({ ...row, total: i + 1 })));
    service.stop(); options.show.mockClear(); options.hide.mockClear();
    capture.read.mockResolvedValueOnce({ ok: true, target: {}, lines: invalid });
    service.start();
    await vi.waitFor(() => expect(service.status().message).toBe("No readable rows. Prices hidden."));
    expect(service.status().rows).toEqual([]);
    expect(options.show).not.toHaveBeenCalled(); expect(options.hide).toHaveBeenCalled();
  });
  it("hides on focus loss and rejects late OCR results after stop", async () => {
    const { service, capture, options } = setup(); await service.refresh(); await service.calibrate();
    service.start(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(options.hide).toHaveBeenCalled(); expect(options.show).not.toHaveBeenCalled(); expect(service.status().rows).toEqual([]);
    service.stop();
    let finish!: (value: Record<string, unknown>) => void;
    capture.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    service.start(); service.stop(); finish({ ok: true, target: {}, lines: [{ text: "Divine Orb", y: 10 }] });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(options.show).not.toHaveBeenCalled(); expect(service.status().rows).toEqual([]);
  });
  it("cancels auto-refresh timers and in-flight fetches on disposal", async () => {
    vi.useFakeTimers(); const { service, fetchImpl } = setup();
    service.configure({ ...helperDefaults(), autoRefresh: true });
    service.configure(helperDefaults()); await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    service.dispose(); await service.refresh(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
describe("public data network boundary", () => {
  it("blocks redirects to local or unexpected hosts without making the redirected request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(fetchHelperText("https://docs.google.com/sheet", fetchImpl as typeof fetch, new AbortController().signal, true)).rejects.toThrow("Blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects excessive streamed bodies and uses credential-free requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(1_000_001)));
    await expect(fetchHelperText("https://docs.google.com/sheet", fetchImpl as typeof fetch, new AbortController().signal, true)).rejects.toThrow("too large");
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: "omit", redirect: "manual", headers: expect.not.objectContaining({ Cookie: expect.anything() }) }));
  });
});
