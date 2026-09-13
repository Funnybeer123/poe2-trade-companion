import { beforeEach, describe, expect, it, vi } from "vitest";
import { helperDefaults, type HelperRow } from "../../src/core/priceHelper.js";
const fake = vi.hoisted(() => ({ options: {} as Record<string, unknown>, hide: vi.fn(), showInactive: vi.fn(), setBounds: vi.fn(), loadURL: vi.fn(async () => {}), executeJavaScript: vi.fn(async (_script: string) => {}), setIgnoreMouseEvents: vi.fn(), setContentProtection: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(), destroy: vi.fn() }));
vi.mock("electron", () => ({ app: {}, ipcMain: {}, globalShortcut: {}, Menu: {}, Tray: {},
  screen: { screenToDipRect: (_window: unknown, bounds: unknown) => bounds },
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
const rows: HelperRow[] = [{ text: '<img src=x onerror="alert(1)">', detail: "? — unknown", state: "unknown", stale: false, y: 20 }];
beforeEach(() => vi.clearAllMocks());
describe("price helper overlay isolation", () => {
  it("uses a sandboxed, click-through window without a preload or parent that would hide it in tray", async () => {
    const overlay = new HelperOverlay(); await overlay.show(rows, target, config);
    expect(fake.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false });
    expect(fake.options.parent).toBeUndefined(); expect(fake.options.focusable).toBe(false);
    expect(fake.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(fake.setContentProtection).toHaveBeenCalledWith(true);
    expect(fake.showInactive).toHaveBeenCalledTimes(1);
    expect(fake.executeJavaScript.mock.calls[0]?.[0]).toContain("textContent");
    expect(fake.executeJavaScript.mock.calls[0]?.[0]).not.toContain("innerHTML");
    overlay.dispose();
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
});
