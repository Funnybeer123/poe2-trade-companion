/**
 * Feature module "overlay": owns the transparent overlay window (ctx service
 * "overlay"), the `overlay:*` channels, the "overlay" settings namespace and
 * the "overlay.hide-all" hotkey action.
 *
 * Electron (BrowserWindow, screen, app) is resolved lazily inside register()
 * and every Electron-facing piece is injectable, so the module is exercised
 * in tests with fakes and never opens a real window there.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOverlayWindowService,
  type OverlayScreenLike,
  type OverlayService,
  type OverlayWindowLike,
  type OverlayWindowOptions,
} from "../../overlayWindow.js";
import {
  normalizeOverlaySettings,
  type OverlayPanelEvent,
  type OverlaySettings,
  type OverlayShowOptions,
} from "../../../shared/overlay.js";
import type { FeatureContext, FeatureModule } from "../types.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    overlay: OverlayService;
  }
}

export interface OverlayModuleDeps {
  /** Defaults to a real transparent BrowserWindow loading the renderer at #/overlay. */
  createWindow?: () => OverlayWindowLike;
  /** Defaults to Electron's screen module. */
  screen?: OverlayScreenLike;
  timers?: OverlayWindowOptions["timers"];
  pollMs?: number;
}

/**
 * Same construction as src/main/dryRunOverlayWindow.ts, plus click-through
 * and non-focusable by default (the game keeps focus; panels that need
 * typing ask for it), and the same renderer bundle as the main window at
 * "#/overlay" so panels share the preload, styles and typed feature api.
 */
async function electronWindowFactory(): Promise<() => OverlayWindowLike> {
  const { BrowserWindow, app } = await import("electron");
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs");
  return () => {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    // "screen-saver" keeps the overlay above a borderless-fullscreen game.
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setMenuBarVisibility(false);
    if (process.env.VITE_DEV_SERVER_URL) {
      void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/overlay`);
    } else {
      void win.loadFile(path.join(app.getAppPath(), "dist", "index.html"), { hash: "/overlay" });
    }
    return win as unknown as OverlayWindowLike;
  };
}

async function electronScreen(): Promise<OverlayScreenLike> {
  const { screen } = await import("electron");
  return screen;
}

async function poeRunning(ctx: FeatureContext): Promise<boolean> {
  try {
    return (await ctx.poeWindows()).length > 0;
  } catch {
    return false;
  }
}

export function createOverlayModule(deps: OverlayModuleDeps = {}): FeatureModule {
  return {
    id: "overlay",
    async register(ctx) {
      const settings = ctx.settings.namespace<OverlaySettings>("overlay", normalizeOverlaySettings);
      const createWindow = deps.createWindow ?? (await electronWindowFactory());
      const screen = deps.screen ?? (await electronScreen());
      const service = createOverlayWindowService({
        createWindow: () => {
          // A hidden overlay window would keep the app alive after the main
          // window closes ("window-all-closed" never fires): tie its life to
          // the main window, which exists by the time a panel is first shown.
          try {
            ctx.mainWindow()?.once("closed", () => service.dispose());
          } catch {
            // Fakes in tests may not be event emitters.
          }
          return createWindow();
        },
        screen,
        settings: () => settings.get(),
        emit: (channel, payload) => ctx.emit(channel, payload),
        registerWindow: (win) => ctx.registerWindow(win as never),
        poeRunning: () => poeRunning(ctx),
        timers: deps.timers,
        pollMs: deps.pollMs,
        log: (level, message, detail) => ctx.log({ feature: "overlay", level, message, detail }),
      });
      const stopSettings = settings.onChange(() => service.applySettings());
      ctx.provide("overlay", service);

      ctx.handle("overlay:state", () => service.state());
      ctx.handle("overlay:panel-event", (event: OverlayPanelEvent) => {
        if (typeof event === "object" && event !== null) service.handlePanelEvent(event);
      });
      ctx.handle("overlay:show", (panelId: string, options?: OverlayShowOptions) =>
        service.show(String(panelId), typeof options === "object" && options !== null ? options : {}),
      );
      ctx.handle("overlay:hide", (panelId: string) => service.hide(String(panelId)));
      ctx.handle("overlay:hide-all", (includePinned?: boolean) => service.hideAll(Boolean(includePinned)));
      ctx.handle("overlay:set-focus", (panelId: string, focus: boolean) =>
        service.setFocus(String(panelId), Boolean(focus)),
      );
      ctx.handle("overlay:set-ignore-mouse", (ignore: boolean) => service.setIgnoreMouse(Boolean(ignore)));

      const stopHotkey = ctx.require("hotkeys").contribute({
        id: "overlay.hide-all",
        label: "Hide all overlay panels",
        detail: "Closes every unpinned overlay panel (Escape does the same while a panel has focus).",
        group: "Overlay",
        defaultAccelerator: null,
        run: () => service.hideAll(),
      });

      return {
        dispose: () => {
          stopHotkey();
          stopSettings();
          service.dispose();
        },
      };
    },
  };
}

export const overlayModule: FeatureModule = createOverlayModule();
