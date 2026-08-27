import { EmergencyStop, createRedactingLogger, type FilterProfile, type OperatorRuntime } from "@poe2tc/core";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS } from "./ipcChannels.js";
import { createDesktopRuntime, resolveRuntimeModeFromDesktop } from "./operatorHost.js";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const logger = createRedactingLogger({ redactIdentifiers: true });

export const emergencyStop = new EmergencyStop();
export const EMERGENCY_STOP_ACCELERATOR = "CommandOrControl+Shift+F12";
export const PRICE_CHECK_ACCELERATOR = "CommandOrControl+Shift+D";

let runtime: OperatorRuntime | undefined;
let overlayWindow: BrowserWindow | undefined;
let bannerWindow: BrowserWindow | undefined;
let workerWindow: BrowserWindow | undefined;
let emergencyStopRegistered = false;

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

function tripEmergencyStop(): void {
  if (runtime !== undefined) {
    runtime.tripStop();
    return;
  }
  emergencyStop.trip();
}

export function registerEmergencyStopHotkey(): boolean {
  const registered = globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, tripEmergencyStop);
  emergencyStopRegistered = registered || emergencyStopRegistered;
  if (!registered) {
    logger.warn("emergency-stop-hotkey-register-failed", { accelerator: EMERGENCY_STOP_ACCELERATOR });
  }
  return emergencyStopRegistered;
}

/**
 * Re-register the kill switch if the OS dropped it. A previous successful
 * registration is never treated as lost while the process is alive.
 */
export function ensureEmergencyStopRegistered(): boolean {
  if (emergencyStopRegistered && globalShortcut.isRegistered(EMERGENCY_STOP_ACCELERATOR)) {
    return true;
  }
  return registerEmergencyStopHotkey();
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
  ipcMain.handle(IPC_CHANNELS.getBuildFlags, () => requireRuntime().getBuildFlags());
  ipcMain.handle(IPC_CHANNELS.completeFirstRun, (_event, submission) =>
    requireRuntime().completeFirstRun(submission),
  );
}

export function createOperatorWindows(): {
  overlay: BrowserWindow;
  worker: BrowserWindow;
  banner?: BrowserWindow;
} {
  const overlay = createOverlayWindow();
  const worker = createHiddenWorker();
  const mode = resolveRuntimeModeFromDesktop(
    process.env,
    app.isPackaged ? app.getAppPath() : undefined,
  );
  const banner =
    mode === "authorized-qa" && runtime?.getCapabilities().qaBannerRequired === true
      ? createQaBannerWindow()
      : undefined;
  return { overlay, worker, banner };
}

void app.whenReady().then(() => {
  const hotkeyRegistered = ensureEmergencyStopRegistered();
  registerPriceCheckHotkey();
  runtime = createDesktopRuntime({
    emergencyStop,
    dbPath: process.env.POE2TC_DB_PATH ?? path.join(app.getPath("userData"), "poe2tc.sqlite"),
    tracesPath: path.join(app.getPath("userData"), "qa-traces.jsonl"),
    fsyncTraces: process.env.POE2TC_TRACE_FSYNC !== "0",
    clipboard: { readText: () => clipboard.readText() },
    hotkeyRegistered,
    packagedAppPath: app.isPackaged ? app.getAppPath() : undefined,
  });
  runtime.setHotkeyRegistered(hotkeyRegistered);
  registerIpcHandlers();
  createOperatorWindows();

  app.on("activate", () => {
    const stillRegistered = ensureEmergencyStopRegistered();
    runtime?.setHotkeyRegistered(stillRegistered);
    if (BrowserWindow.getAllWindows().length === 0) {
      createOperatorWindows();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregister(PRICE_CHECK_ACCELERATOR);
  globalShortcut.unregister(EMERGENCY_STOP_ACCELERATOR);
  emergencyStopRegistered = false;
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

export function wasEmergencyStopRegistered(): boolean {
  return emergencyStopRegistered;
}
