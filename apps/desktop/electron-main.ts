import { EmergencyStop, type FilterProfile, type OperatorRuntime } from "@poe2tc/core";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS } from "./ipcChannels.js";
import { createDesktopRuntime, resolveRuntimeMode } from "./operatorHost.js";

const appDir = path.dirname(fileURLToPath(import.meta.url));

export const emergencyStop = new EmergencyStop();
export const EMERGENCY_STOP_ACCELERATOR = "CommandOrControl+Shift+F12";
export const PRICE_CHECK_ACCELERATOR = "CommandOrControl+Shift+D";

let runtime: OperatorRuntime | undefined;
let overlayWindow: BrowserWindow | undefined;
let bannerWindow: BrowserWindow | undefined;
let workerWindow: BrowserWindow | undefined;

function overlayBaseUrl(): string | undefined {
  const overlayUrl = process.env.POE2TC_OVERLAY_URL;
  return overlayUrl !== undefined && overlayUrl.length > 0 ? overlayUrl.replace(/\/$/, "") : undefined;
}

function overlayFile(name: string): string {
  return path.join(appDir, "../../overlay/dist", name);
}

function loadOverlay(window: BrowserWindow, page: "index.html" | "banner.html" | "worker.html"): void {
  const base = overlayBaseUrl();
  if (base !== undefined) {
    void window.loadURL(`${base}/${page}`);
    return;
  }
  void window.loadFile(overlayFile(page));
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "PoE2 QA Trade Companion",
    webPreferences: {
      preload: path.join(appDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  loadOverlay(window, "index.html");
  overlayWindow = window;
  return window;
}

function createHiddenWorker(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    title: "PoE2 QA Worker",
    webPreferences: {
      preload: path.join(appDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  loadOverlay(window, "worker.html");
  workerWindow = window;
  return window;
}

function createQaBannerWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 48,
    x: 0,
    y: 0,
    frame: false,
    closable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "QA Automation Banner",
    webPreferences: {
      preload: path.join(appDir, "banner-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  loadOverlay(window, "banner.html");
  bannerWindow = window;
  return window;
}

export function registerEmergencyStopHotkey(): boolean {
  return globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, () => {
    if (runtime !== undefined) {
      runtime.tripStop();
      return;
    }
    emergencyStop.trip();
  });
}

/**
 * User-invoked public companion price-check. Reads clipboard only.
 * Must not generate additional game actions or call GameInputController.
 */
export function registerPriceCheckHotkey(): boolean {
  return globalShortcut.register(PRICE_CHECK_ACCELERATOR, () => {
    if (runtime === undefined) {
      return;
    }
    void runtime.parseClipboard().then((result) => {
      overlayWindow?.webContents.send(IPC_CHANNELS.priceCheckResult, result);
    });
  });
}

function requireRuntime(): OperatorRuntime {
  if (runtime === undefined) {
    throw new Error("operator-runtime-unavailable");
  }
  return runtime;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getCapabilities, () => requireRuntime().getCapabilities());
  ipcMain.handle(IPC_CHANNELS.getWorldState, () => requireRuntime().getWorldState());
  ipcMain.handle(IPC_CHANNELS.getTraces, () => requireRuntime().getTraces());
  ipcMain.handle(IPC_CHANNELS.armQa, () => requireRuntime().armQa());
  ipcMain.handle(IPC_CHANNELS.disarmQa, () => requireRuntime().disarmQa());
  ipcMain.handle(IPC_CHANNELS.tripStop, () => requireRuntime().tripStop());
  ipcMain.handle(IPC_CHANNELS.rearmStop, () => requireRuntime().rearmStop());
  ipcMain.handle(IPC_CHANNELS.runReplay, (_event, id: string) => requireRuntime().runReplay(id));
  ipcMain.handle(IPC_CHANNELS.parseClipboard, (_event, text?: string) =>
    requireRuntime().parseClipboard(text),
  );
  ipcMain.handle(IPC_CHANNELS.exportFilter, (_event, profile?: FilterProfile) =>
    requireRuntime().exportFilter(profile),
  );
  ipcMain.handle(IPC_CHANNELS.getSettings, () => requireRuntime().getSettings());
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, settings) => requireRuntime().saveSettings(settings));
  ipcMain.handle(IPC_CHANNELS.getCatalog, () => requireRuntime().getCatalog());
  ipcMain.handle(IPC_CHANNELS.getScenarios, () => requireRuntime().getScenarios());
  ipcMain.handle(IPC_CHANNELS.saveScenario, (_event, scenario) => requireRuntime().saveScenario(scenario));
}

export function createOperatorWindows(): {
  overlay: BrowserWindow;
  worker: BrowserWindow;
  banner?: BrowserWindow;
} {
  const overlay = createOverlayWindow();
  const worker = createHiddenWorker();
  const mode = resolveRuntimeMode();
  const banner =
    mode === "authorized-qa" && runtime?.getCapabilities().qaBannerRequired === true
      ? createQaBannerWindow()
      : undefined;
  return { overlay, worker, banner };
}

void app.whenReady().then(() => {
  const hotkeyRegistered = registerEmergencyStopHotkey();
  registerPriceCheckHotkey();
  runtime = createDesktopRuntime({
    emergencyStop,
    dbPath: process.env.POE2TC_DB_PATH ?? path.join(app.getPath("userData"), "poe2tc.sqlite"),
    clipboard: { readText: () => clipboard.readText() },
    hotkeyRegistered,
  });
  runtime.setHotkeyRegistered(hotkeyRegistered);
  registerIpcHandlers();
  createOperatorWindows();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOperatorWindows();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

export function getWindows(): {
  overlay?: BrowserWindow;
  worker?: BrowserWindow;
  banner?: BrowserWindow;
} {
  return { overlay: overlayWindow, worker: workerWindow, banner: bannerWindow };
}
