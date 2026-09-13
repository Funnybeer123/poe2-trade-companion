import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { helperDefaults, type HelperRow } from "../../src/core/priceHelper.js";
const fake = vi.hoisted(() => ({ scale: 1, setAlwaysOnTop: vi.fn(), moveTop: vi.fn(), options: {} as Record<string, unknown>, hide: vi.fn(), showInactive: vi.fn(), setBounds: vi.fn(), loadURL: vi.fn(async (_url: string) => {}), executeJavaScript: vi.fn(async (_script: string) => {}), setIgnoreMouseEvents: vi.fn(), setContentProtection: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(), destroy: vi.fn() }));
vi.mock("electron", () => ({ app: {}, ipcMain: {}, globalShortcut: {}, Menu: {}, Tray: {},
  screen: { screenToDipRect: (_window: unknown, bounds: Record<string, number>) => Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value / fake.scale])) },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) { fake.options = options; }
    isDestroyed = () => false;
    setAlwaysOnTop = fake.setAlwaysOnTop; moveTop = fake.moveTop; hide = fake.hide; showInactive = fake.showInactive; setBounds = fake.setBounds;
    loadURL = fake.loadURL; destroy = fake.destroy; setIgnoreMouseEvents = fake.setIgnoreMouseEvents; setContentProtection = fake.setContentProtection;
    webContents = { executeJavaScript: fake.executeJavaScript, setWindowOpenHandler: fake.setWindowOpenHandler, on: fake.on };
  },
}));
import { HelperOverlay } from "../../src/main/priceHelperIntegration.js";
const config = { ...helperDefaults(), regions: { prices: { x: 100, y: 100, width: 300, height: 400, clientWidth: 1920, clientHeight: 1080 } } };
const target = { left: 0, top: 0, width: 1920, height: 1080 };
const rows: HelperRow[] = [{ text: '<img src=x onerror="alert(1)">', detail: "? — unknown", state: "unknown", stale: false, y: 20, height: 20 }];
function rendered(): Window {
  const window = new Window();
  const url = fake.loadURL.mock.calls[0]![0];
  window.document.write(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
  window.eval(fake.executeJavaScript.mock.calls.at(-1)![0]);
  return window;
}
beforeEach(() => { vi.clearAllMocks(); fake.scale = 1; });
describe("price helper overlay isolation", () => {
  it("uses a sandboxed, click-through window without a preload or parent that would hide it in tray", async () => {
    const overlay = new HelperOverlay(); await overlay.show(rows, target, { ...config, debug: true });
    expect(fake.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false });
    expect(fake.options.parent).toBeUndefined(); expect(fake.options.focusable).toBe(false);
    expect(fake.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(fake.setContentProtection).toHaveBeenCalledWith(true);
    expect(fake.showInactive).toHaveBeenCalledTimes(1);
    expect(fake.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(fake.moveTop).toHaveBeenCalledTimes(1);
    expect(fake.moveTop.mock.invocationCallOrder[0]).toBeGreaterThan(fake.showInactive.mock.invocationCallOrder[0]!);
    const window = rendered();
    expect(window.document.querySelector("img")).toBeNull();
    expect(window.document.querySelector("small")?.textContent).toBe(rows[0]!.text);
    expect(window.document.querySelector(".price")?.textContent).toBe("?");
    overlay.dispose(); await window.happyDOM.close();
  });
  it("does not reveal a late-loading overlay after stop", async () => {
    let finish!: () => void; fake.loadURL.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const overlay = new HelperOverlay(), showing = overlay.show(rows, target, config);
    overlay.hide(); finish(); await showing;
    expect(fake.showInactive).not.toHaveBeenCalled(); expect(fake.moveTop).not.toHaveBeenCalled(); expect(fake.setAlwaysOnTop).not.toHaveBeenCalled(); expect(fake.executeJavaScript).not.toHaveBeenCalled(); overlay.dispose();
  });
  it("does not reveal an in-flight render after stop or place prices over the capture region", async () => {
    let finish!: () => void; fake.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const overlay = new HelperOverlay(), showing = overlay.show(rows, target, config);
    await Promise.resolve(); overlay.hide(); finish(); await showing;
    expect(fake.showInactive).not.toHaveBeenCalled(); expect(fake.moveTop).not.toHaveBeenCalled(); expect(fake.setAlwaysOnTop).not.toHaveBeenCalled(); overlay.dispose();
    const noRoom = { ...config, regions: { prices: { ...config.regions.prices, x: 0, width: 1920 } } };
    await expect(new HelperOverlay().show(rows, target, noRoom)).rejects.toThrow("Leave room");
  });
  it.each([{ scale: 1, y: 1225 }, { scale: 1.5, y: 1225 }, { scale: 1.5, y: 387 }])("centers eight irregular rows including an unknown at scale $scale and region y=$y", async ({ scale, y }) => {
    fake.scale = scale;
    const region = { x: 627, y, width: 465, height: 935, clientWidth: 3840, clientHeight: 2160 };
    const entries: HelperRow[] = [15, 177, 339, 501, 589, 684, 779, 874].map((y, i) => ({ text: `Item ${i}`, detail: i === 2 ? "? — unknown" : `${i + 1} chaos`, state: i === 2 ? "unknown" : "priced", stale: false, quantity: 1, unit: i + 1, total: i + 1, currency: "chaos", y, height: i < 4 ? 36 : 30 }));
    const overlay = new HelperOverlay();
    await overlay.show(entries, { left: 0, top: 0, width: 3840, height: 2160 }, { ...config, regions: { prices: region } });
    const bounds = fake.setBounds.mock.calls[0]![0] as { x: number; y: number };
    expect(bounds.x).toBeGreaterThanOrEqual((region.x + region.width) / scale);
    if (y === 1225) expect(bounds.y).toBeLessThan(region.y / scale);
    const window = rendered(), elements = [...window.document.querySelectorAll(".row")];
    expect(elements).toHaveLength(8);
    for (const [i, element] of elements.entries()) {
      const entry = entries[i]!;
      expect(element.textContent).toBe(i === 2 ? "?" : String(i + 1));
      expect(element.getAttribute("aria-label")).toBe(entry.detail);
      expect(bounds.y + Number.parseFloat(window.getComputedStyle(element).top)).toBeCloseTo((region.y + entry.y! + entry.height! / 2) / scale, 6);
      expect(window.getComputedStyle(element).transform).toBe("translateY(-50%)");
    }
    overlay.dispose(); await window.happyDOM.close();
  });
  it("renders compact currency icons and numbers with transparent rows and no remote image sources", async () => {
    const entries: HelperRow[] = [
      { text: "1x Divine Orb", detail: "1 div", state: "priced", currency: "div", unit: 1, total: 1, quantity: 1, stale: false, y: 30, height: 30 },
      { text: "3x Chaos Orb", detail: "3 chaos (1 each)", state: "priced", currency: "chaos", unit: 1, total: 3, quantity: 3, stale: false, y: 100, height: 30 },
      { ...rows[0]!, y: 180 },
    ];
    const overlay = new HelperOverlay(); await overlay.show(entries, target, config);
    const window = rendered(), elements = [...window.document.querySelectorAll(".row")];
    expect(elements.map(element => element.querySelector(".price")?.textContent)).toEqual(["1", "3 (1)", "?"]);
    const icons = [...window.document.querySelectorAll("img")];
    expect(icons.map(icon => icon.alt)).toEqual(["Divine Orb", "Chaos Orb"]);
    expect(icons.every(icon => icon.src.startsWith("data:image/png;base64,"))).toBe(true);
    expect(icons[0]!.src).not.toBe(icons[1]!.src);
    for (const element of elements) expect(window.getComputedStyle(element).backgroundColor).toBe("transparent");
    const csp = window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("img-src data:"); expect(csp).not.toContain("https:");
    overlay.dispose(); await window.happyDOM.close();
  });
  it("keeps prices with invalid or clipped geometry out of the overlay", async () => {
    const invalid = [{ y: undefined }, { y: Number.NaN }, { y: -1 }, { height: undefined }, { height: Number.POSITIVE_INFINITY }, { height: 0 }, { y: 395, height: 20 }];
    const overlay = new HelperOverlay(); await overlay.show([...invalid.map(value => ({ ...rows[0]!, ...value })), ...rows], target, config);
    const window = rendered(); expect(window.document.querySelectorAll(".row")).toHaveLength(1);
    overlay.dispose(); await window.happyDOM.close();
  });
  it("uses distinct price colors only for fresh known values and keeps debug text below the price anchor", async () => {
    const base = { ...rows[0]!, state: "priced" as const, detail: "12 div", unit: 12, total: 12, quantity: 1, currency: "div" as const };
    const entries: HelperRow[] = [base, { ...base, valueTier: "high" }, { ...base, valueTier: "very-high" }, { ...base, valueTier: "very-high", stale: true }, { ...base, valueTier: "high", state: "unknown" }, { ...base, valueTier: "high", state: "no-data" }];
    const overlay = new HelperOverlay(); await overlay.show(entries, target, { ...config, debug: true });
    const window = rendered(), elements = [...window.document.querySelectorAll(".row")];
    expect(elements.map(element => window.getComputedStyle(element).color)).toEqual(["#86efac", "#facc15", "#f472b6", "#fbbf24", "#aaa", "#aaa"]);
    expect(elements.map(element => element.querySelector(".price")?.textContent)).toEqual(["12", "12", "12", "12 · stale", "?", "No data"]);
    for (const element of elements) {
      expect(window.getComputedStyle(element.querySelector("small")!).position).toBe("absolute");
    }
    overlay.dispose(); await window.happyDOM.close();
  });
});
