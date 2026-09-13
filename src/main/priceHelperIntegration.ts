import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, Tray } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startWinHost } from "../adapters/winHost.js";
import { HELPER_THEMES, type HelperConfig, type HelperRow } from "../core/priceHelper.js";
import { helperOverlayLabel } from "../core/helperOverlayLabel.js";
import { HELPER_CURRENCY_ICONS } from "./priceHelperIcons.js";
import { PriceHelperService } from "./priceHelperService.js";
import type { HelperRewardOptions } from "./helperRewardService.js";

const OVERLAY = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
body{margin:0;background:transparent;color:#e2e8f0;font:700 20px 'Segoe UI',sans-serif;overflow:hidden}
.row{position:absolute;left:4px;max-width:calc(100% - 8px);min-height:30px;display:flex;align-items:center;gap:7px;line-height:26px;transform:translateY(-50%);background:transparent;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 2px 4px #000}
.currency{display:block;flex:none;width:30px;height:30px}.currency img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 1px 2px #000)}
.price{display:block;min-width:0;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rumour{font-size:13px;line-height:18px}.high{color:#facc15}.very-high{color:#f472b6}.unknown{color:#aaa}.stale{color:#fbbf24}
small{position:absolute;top:100%;left:37px;max-width:340px;font:500 11px/14px 'Segoe UI',sans-serif;color:#ccc;background:#10151aee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stamp{position:absolute;bottom:0;right:6px;color:#aaa;font:500 10px 'Segoe UI',sans-serif;background:#10151acc}
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
      const window = this.window = new BrowserWindow({ title: "Reward prices · PoE2 Trade Companion", width, height, show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false } });
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setContentProtection(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      this.ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY)}`);
    }
    const window = this.window;
    await this.ready;
    if (generation !== this.generation || window.isDestroyed()) return;
    const overlayY = Math.round(Math.min(roi.y, bounds.y + bounds.height - height));
    window.setBounds({ x: Math.round(x), y: overlayY, width: Math.round(width), height: Math.round(height) });
    const data = rows.flatMap(row => {
      // A label without a verified text box could point at a different reward.
      if (typeof row.y !== "number" || !Number.isFinite(row.y) || row.y < 0 ||
          typeof row.height !== "number" || !Number.isFinite(row.height) || row.height <= 0 ||
          row.y + row.height > region.height) return [];
      return [{ text: helperOverlayLabel(row), detail: row.detail, raw: row.text, currency: row.state === "priced" ? row.currency : undefined,
        centerY: roi.y - overlayY + (row.y + row.height / 2) * roi.height / region.height,
        state: row.state, stale: row.stale, valueTier: row.state === "priced" && !row.stale ? row.valueTier : undefined }];
    });
    // Data only reaches textContent. No HTML, URLs, event handlers, or Node bridge in this window.
    await window.webContents.executeJavaScript(`(() => {
      const data = ${JSON.stringify(data)};
      const icons = ${JSON.stringify(HELPER_CURRENCY_ICONS)};
      document.body.style.color = ${JSON.stringify(HELPER_THEMES[config.theme])};
      const root = document.getElementById('rows'); root.replaceChildren();
      for (const row of data) {
        const el = document.createElement('div');
        el.className = 'row' + (row.stale ? ' stale' : row.state === 'unknown' || row.state === 'no-data' ? ' unknown' : row.valueTier === 'very-high' ? ' very-high' : row.valueTier === 'high' ? ' high' : '');
        if (row.state === 'rumour') el.classList.add('rumour');
        el.style.top = row.centerY + 'px';
        el.setAttribute('aria-label', row.detail);
        if (row.state !== 'rumour') {
          const currency = document.createElement('span'); currency.className = 'currency';
          if (row.text !== '?' && (row.currency === 'chaos' || row.currency === 'div')) {
            const icon = document.createElement('img'); icon.src = icons[row.currency];
            icon.alt = row.currency === 'div' ? 'Divine Orb' : 'Chaos Orb'; currency.append(icon);
          }
          el.append(currency);
        }
        const price = document.createElement('span'); price.className = 'price'; price.textContent = row.text; el.append(price);
        if (${config.debug}) { const small = document.createElement('small'); small.textContent = row.raw; el.append(small); }
        root.append(el);
      }
      document.getElementById('stamp').textContent = ${JSON.stringify(config.mode === "prices" ? `${config.league} · ${rows.some(row => row.source === "trade") ? "≈ trade listings · variants vary" : "poe.ninja estimate"}` : "Community rumour ratings")};
    })()`);
    if (generation === this.generation && !window.isDestroyed()) {
      // Borderless games can occupy the topmost layer; raise prices without taking focus.
      window.setAlwaysOnTop(true, "screen-saver");
      window.showInactive();
      window.moveTop();
    }
  }
}

export function installPriceHelper(getMain: () => BrowserWindow | undefined, fetchReward?: HelperRewardOptions["fetchReward"]): PriceHelperService {
  const overlay = new HelperOverlay();
  let host: ReturnType<typeof startWinHost> | undefined;
  const ensureHost = (calibration = false) => host ??= startWinHost({ scriptName: "win-price-helper.ps1", requestTimeoutMs: calibration ? 70000 : 15000 });
  const closeHost = () => { void host?.close(); host = undefined; };
  const service = new PriceHelperService({ directory: path.join(app.getPath("userData"), "price-helper"), fetchReward,
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
    "lookup-live": text => service.lookupLive(text), "open-trade": text => shell.openExternal(service.tradeUrl(text)),
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
