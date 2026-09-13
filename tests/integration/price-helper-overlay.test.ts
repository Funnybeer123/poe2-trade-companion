import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { helperDefaults, type HelperRow } from "../../src/core/priceHelper.js";
const fake = vi.hoisted(() => ({ scale: 1, options: {} as Record<string, unknown>, hide: vi.fn(), showInactive: vi.fn(), setBounds: vi.fn(), loadURL: vi.fn(async (_url: string) => {}), executeJavaScript: vi.fn(async (_script: string) => {}), setIgnoreMouseEvents: vi.fn(), setContentProtection: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(), destroy: vi.fn() }));
vi.mock("electron", () => ({ app: {}, ipcMain: {}, globalShortcut: {}, Menu: {}, Tray: {},
  screen: { screenToDipRect: (_window: unknown, bounds: Record<string, number>) => Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value / fake.scale])) },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) { fake.options = options; }
    isDestroyed = () => false;
    hide = fake.hide; showInactive = fake.showInactive; setBounds = fake.setBounds;
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
    expect(fake.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false });
    expect(fake.options.parent).toBeUndefined(); expect(fake.options.focusable).toBe(false);
    expect(fake.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(fake.setContentProtection).toHaveBeenCalledWith(true);
    expect(fake.showInactive).toHaveBeenCalledTimes(1);
    const window = rendered();
    expect(window.document.querySelector("img")).toBeNull();
    expect(window.document.querySelector("small")?.textContent).toBe(rows[0]!.text);
    expect(window.document.querySelector(".price")?.textContent).toBe(rows[0]!.detail);
    overlay.dispose(); await window.happyDOM.close();
  });
  it("does not reveal a late-loading overlay after stop", async () => {
    let finish!: () => void; fake.loadURL.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const overlay = new HelperOverlay(), showing = overlay.show(rows, target, config);
    overlay.hide(); finish(); await showing;
    expect(fake.showInactive).not.toHaveBeenCalled(); expect(fake.executeJavaScript).not.toHaveBeenCalled(); overlay.dispose();
  });
  it("does not reveal an in-flight render after stop or place prices over the capture region", async () => {
    let finish!: () => void; fake.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const overlay = new HelperOverlay(), showing = overlay.show(rows, target, config);
    await Promise.resolve(); overlay.hide(); finish(); await showing;
    expect(fake.showInactive).not.toHaveBeenCalled(); overlay.dispose();
    const noRoom = { ...config, regions: { prices: { ...config.regions.prices, x: 0, width: 1920 } } };
    await expect(new HelperOverlay().show(rows, target, noRoom)).rejects.toThrow("Leave room");
  });
  it.each([{ scale: 1, y: 1225 }, { scale: 1.5, y: 1225 }, { scale: 1.5, y: 387 }])("centers eight irregular rows including an unknown at scale $scale and region y=$y", async ({ scale, y }) => {
    fake.scale = scale;
    const region = { x: 627, y, width: 465, height: 935, clientWidth: 3840, clientHeight: 2160 };
    const entries: HelperRow[] = [15, 177, 339, 501, 589, 684, 779, 874].map((y, i) => ({ text: `Item ${i}`, detail: i === 2 ? "? — unknown" : `${i + 1} ex`, state: i === 2 ? "unknown" : "priced", stale: false, y, height: i < 4 ? 36 : 30 }));
    const overlay = new HelperOverlay();
    await overlay.show(entries, { left: 0, top: 0, width: 3840, height: 2160 }, { ...config, regions: { prices: region } });
    const bounds = fake.setBounds.mock.calls[0]![0] as { x: number; y: number };
    expect(bounds.x).toBeGreaterThanOrEqual((region.x + region.width) / scale);
    if (y === 1225) expect(bounds.y).toBeLessThan(region.y / scale);
    const window = rendered(), elements = [...window.document.querySelectorAll(".row")];
    expect(elements).toHaveLength(8);
    for (const [i, element] of elements.entries()) {
      const entry = entries[i]!;
      expect(element.textContent).toBe(entry.detail);
      expect(bounds.y + Number.parseFloat(window.getComputedStyle(element).top)).toBeCloseTo((region.y + entry.y! + entry.height! / 2) / scale, 6);
      expect(window.getComputedStyle(element).transform).toBe("translateY(-50%)");
    }
    overlay.dispose(); await window.happyDOM.close();
  });
  it("keeps prices with invalid or clipped geometry out of the overlay", async () => {
    const invalid = [{ y: undefined }, { y: Number.NaN }, { y: -1 }, { height: undefined }, { height: Number.POSITIVE_INFINITY }, { height: 0 }, { y: 395, height: 20 }];
    const overlay = new HelperOverlay(); await overlay.show([...invalid.map(value => ({ ...rows[0]!, ...value })), ...rows], target, config);
    const window = rendered(); expect(window.document.querySelectorAll(".row")).toHaveLength(1);
    overlay.dispose(); await window.happyDOM.close();
  });
  it("uses distinct price colors only for fresh known values and keeps debug text below the price anchor", async () => {
    const base = { ...rows[0]!, state: "priced" as const, detail: "12 div" };
    const entries: HelperRow[] = [base, { ...base, valueTier: "high" }, { ...base, valueTier: "very-high" }, { ...base, valueTier: "very-high", stale: true }, { ...base, valueTier: "high", state: "unknown" }, { ...base, valueTier: "high", state: "no-data" }];
    const overlay = new HelperOverlay(); await overlay.show(entries, target, { ...config, debug: true });
    const window = rendered(), elements = [...window.document.querySelectorAll(".row")];
    expect(elements.map(element => window.getComputedStyle(element).color)).toEqual(["#86efac", "#facc15", "#f472b6", "#fbbf24", "#aaa", "#aaa"]);
    for (const element of elements) {
      expect(element.querySelector(".price")?.textContent).toBe("12 div");
      expect(window.getComputedStyle(element.querySelector("small")!).position).toBe("absolute");
    }
    overlay.dispose(); await window.happyDOM.close();
  });
});
