import { EmergencyStop } from "@poe2tc/core";
import { app, BrowserWindow, globalShortcut } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

export const emergencyStop = new EmergencyStop();
export const EMERGENCY_STOP_ACCELERATOR = "CommandOrControl+Shift+F12";

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    title: "PoE2 QA Trade Companion",
    webPreferences: {
      preload: path.join(appDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const overlayUrl = process.env.POE2TC_OVERLAY_URL;
  if (overlayUrl !== undefined && overlayUrl.length > 0) {
    void window.loadURL(overlayUrl);
  } else {
    void window.loadFile(path.join(appDir, "../../overlay/dist/index.html"));
  }

  return window;
}

export function registerEmergencyStopHotkey(): boolean {
  return globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, () => {
    emergencyStop.trip();
  });
}

void app.whenReady().then(() => {
  registerEmergencyStopHotkey();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
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
