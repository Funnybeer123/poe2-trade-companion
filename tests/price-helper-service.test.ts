import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { helperDefaults } from "../src/core/priceHelper.js";
import { fetchHelperText, PriceHelperService } from "../src/main/priceHelperService.js";

const payload = { core: { primary: "divine", rates: { exalted: 300 } }, items: [{ id: "divine", name: "Divine Orb" }], lines: [{ id: "divine", primaryValue: 1 }] };
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
