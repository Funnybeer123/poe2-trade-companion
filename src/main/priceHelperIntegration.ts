import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, Tray } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startWinHost } from "../adapters/winHost.js";
import { HELPER_THEMES, type HelperConfig, type HelperRow } from "../core/priceHelper.js";
import { PriceHelperService } from "./priceHelperService.js";

const OVERLAY = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
body{margin:0;background:transparent;color:#86efac;font:600 13px 'Segoe UI',sans-serif;overflow:hidden} .row{position:absolute;left:4px;right:4px;padding:3px 8px;background:#10151aee;border-left:2px solid currentColor;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.unknown{color:#aaa}.stale{color:#fbbf24}small{display:block;font-size:10px;color:#ccc}#stamp{position:absolute;bottom:0;right:6px;color:#aaa;font-size:10px;background:#10151a}
</style></head><body><div id="rows"></div><div id="stamp">poe.ninja · estimate</div></body></html>`;

export class HelperOverlay {
  private window?: BrowserWindow;
  private ready?: Promise<void>;
  private generation = 0;
  hide(): void { this.generation++; if (this.window && !this.window.isDestroyed()) this.window.hide(); }
  dispose(): void { this.generation++; if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = undefined; }
  async show(rows: HelperRow[], target: Record<string, unknown>, config: HelperConfig): Promise<void> {
    const generation = ++this.generation;
    const region = config.regions[config.mode]!;
    if (![target.left, target.top, target.width, target.height].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 32768)) throw new Error("Invalid game window coordinates.");
    const bounds = screen.screenToDipRect(null, { x: Number(target.left), y: Number(target.top), width: Number(target.width), height: Number(target.height) });
    const roi = screen.screenToDipRect(null, { x: Number(target.left) + region.x, y: Number(target.top) + region.y, width: region.width, height: region.height });
    const width = Math.min(380, bounds.width), height = Math.min(roi.height + 26, bounds.height);
    const right = roi.x + roi.width + 6, left = roi.x - width - 6;
    const x = right + width <= bounds.x + bounds.width ? right : left >= bounds.x ? left : undefined;
    if (x === undefined) throw new Error("Leave room beside the calibrated list for the price overlay.");
    if (!this.window || this.window.isDestroyed()) {
      const window = this.window = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setContentProtection(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      this.ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY)}`);
    }
    const window = this.window;
    await this.ready;
    if (generation !== this.generation || window.isDestroyed()) return;
    window.setBounds({ x: Math.round(x), y: Math.round(Math.min(roi.y, bounds.y + bounds.height - height)), width: Math.round(width), height: Math.round(height) });
    const data = rows.map(row => ({ text: row.detail, raw: row.text, y: Math.round((row.y ?? 0) * roi.height / region.height), state: row.state, stale: row.stale }));
    // Data only reaches textContent. No HTML, URLs, event handlers, or Node bridge in this window.
    await window.webContents.executeJavaScript(`(() => { const data = ${JSON.stringify(data)}; document.body.style.color = ${JSON.stringify(HELPER_THEMES[config.theme])}; const root = document.getElementById('rows'); root.replaceChildren(); for (const row of data) { const el = document.createElement('div'); el.className = 'row' + (row.stale ? ' stale' : row.state === 'unknown' ? ' unknown' : ''); el.style.top = row.y + 'px'; el.textContent = row.text; if (${config.debug}) { const small = document.createElement('small'); small.textContent = row.raw; el.append(small); } root.append(el); } document.getElementById('stamp').textContent = ${JSON.stringify(config.mode === "prices" ? `${config.league} · poe.ninja estimate` : "Community rumour ratings")}; })()`);
    if (generation === this.generation && !window.isDestroyed()) window.showInactive();
  }
}

export function installPriceHelper(getMain: () => BrowserWindow | undefined): PriceHelperService {
  const overlay = new HelperOverlay();
  let host: ReturnType<typeof startWinHost> | undefined;
  const ensureHost = (calibration = false) => host ??= startWinHost({ scriptName: "win-price-helper.ps1", requestTimeoutMs: calibration ? 70000 : 15000 });
  const closeHost = () => { void host?.close(); host = undefined; };
  const service = new PriceHelperService({ directory: path.join(app.getPath("userData"), "price-helper"),
    capture: {
      read: async region => { try { return await ensureHost().send({ op: "read", region }); } catch (error) { closeHost(); throw error; } },
      calibrate: async () => { const calibrationHost = ensureHost(true); try { return await calibrationHost.send({ op: "calibrate" }); } finally { if (host === calibrationHost) closeHost(); } },
      close: closeHost,
    },
    show: (rows, target, config) => overlay.show(rows, target, config), hide: () => overlay.hide(),
  });
  const handlers: Record<string, (value?: unknown) => unknown> = {
    status: () => service.status(), configure: raw => service.configure(raw), refresh: () => service.refresh(),
    "refresh-rumours": () => service.refreshRumours(), lookup: text => service.lookup(text), calibrate: () => service.calibrate(), start: () => service.start(), stop: () => service.stop(),
  };
  for (const [action, handler] of Object.entries(handlers)) ipcMain.handle(`price-helper:${action}`, (event, value: unknown) => {
    const main = getMain();
    if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error("Price helper request denied.");
    const url = event.senderFrame.url.split("#")[0];
    const expected = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
    if (url !== expected && url !== `${expected}/`) throw new Error("Price helper origin denied.");
    return handler(value);
  });
  const hotkeys: Array<[string, () => void]> = [
    ["CommandOrControl+Shift+F5", () => { if (service.status().running) service.stop(); else service.start(); }],
    ["CommandOrControl+Shift+F4", () => { void service.calibrate(); }],
    ["CommandOrControl+Shift+F3", () => { const status = service.status(); service.configure({ ...status.config, debug: !status.config.debug }); if (status.running) service.start(); }],
  ];
  for (const [key, callback] of hotkeys) {
    if (!globalShortcut.register(key, () => {
      try { callback(); } catch { service.hotkeyErrors = [`${key} failed. Open Price helper to check settings.`]; service.stop(); }
    })) service.hotkeyErrors.push(`${key} is in use. Use the buttons instead.`);
  }
  let tray: Tray | undefined, disposed = false;
  void app.getFileIcon(process.execPath).then(icon => {
    if (disposed) return;
    tray = new Tray(icon); tray.setToolTip("PoE2 Trade Companion");
    const show = () => { const main = getMain(); if (main) { main.show(); main.restore(); main.focus(); } };
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open companion", click: show }, { label: "Stop price scanning", click: () => { service.stop(); } }, { type: "separator" }, { label: "Quit", click: () => app.quit() }]));
    tray.on("double-click", show);
  }).catch(() => service.hotkeyErrors.push("Tray icon unavailable. Minimizing will keep the app in the taskbar."));
  getMain()?.on("minimize", () => { if (tray && service.status().config.minimizeToTray) getMain()?.hide(); });
  getMain()?.on("close", () => { service.dispose(); overlay.dispose(); });
  app.once("before-quit", () => { disposed = true; service.dispose(); overlay.dispose(); tray?.destroy(); });
  return service;
}
