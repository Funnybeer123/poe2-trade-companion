/**
 * The optional "open this bookmark in an always-on-top window" mode.
 *
 * NOT an overlay panel: Electron's <webview> is disabled and an <iframe> is
 * refused by every site we would want (X-Frame-Options / frame-ancestors), so
 * the honest in-app substitute is one ordinary framed BrowserWindow that
 * floats above the game. One instance is reused across bookmarks.
 *
 * Hardening (the window loads arbitrary user URLs):
 * - sandboxed renderer, no preload, no node integration, context isolation,
 *   `webSecurity` explicitly on;
 * - its own session partition, so the app's trade cookie is never in reach;
 * - permission requests (camera, mic, notifications, geolocation…) denied;
 * - `will-attach-webview` denied;
 * - navigation and redirects limited to http/https; popups denied and handed
 *   to the OS browser instead.
 */
import type { BookmarkWindowSettings } from "../../../shared/commandsBookmarksNotes.js";

export interface BookmarkWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface BookmarkWebWindow {
  /** Creates the window on first use, otherwise navigates it and shows it. */
  open(url: string, title: string, bounds: BookmarkWindowBounds, alwaysOnTop: boolean): Promise<void>;
  /** Hides the window when it already shows this url; returns the new visibility. */
  toggle(url: string, title: string, bounds: BookmarkWindowBounds, alwaysOnTop: boolean): Promise<boolean>;
  close(): boolean;
  /**
   * A window EXISTS — it may be hidden by its own toggle hotkey and still be
   * loading the page, which is exactly when "Close window" must stay enabled.
   */
  isOpen(): boolean;
  /** …and it is on screen. */
  isVisible(): boolean;
  currentUrl(): string | undefined;
  /** Bounds the user dragged/resized; the module persists them (debounced). */
  onBoundsChanged(callback: (bounds: BookmarkWindowBounds) => void): () => void;
}

export interface BookmarkWebWindowHooks {
  openExternal: (url: string) => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export type BookmarkWebWindowFactory = (hooks: BookmarkWebWindowHooks) => BookmarkWebWindow;

export const BOOKMARK_PARTITION = "persist:bookmark-web";

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Bounds for a window that has never been placed: beside the overlay display's right edge. */
export function defaultWindowBounds(
  settings: BookmarkWindowSettings,
  display?: { x: number; y: number; width: number; height: number },
): BookmarkWindowBounds {
  const bounds: BookmarkWindowBounds = { width: settings.width, height: settings.height };
  if (settings.x !== undefined && settings.y !== undefined) {
    bounds.x = settings.x;
    bounds.y = settings.y;
    return bounds;
  }
  if (display) {
    bounds.x = Math.round(display.x + display.width - settings.width);
    bounds.y = Math.round(display.y + Math.max(0, (display.height - settings.height) / 2));
  }
  return bounds;
}

/** The slice of Electron's BrowserWindow this module drives (fakeable). */
export interface BookmarkWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setBounds(bounds: { x?: number; y?: number; width: number; height: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setTitle(title: string): void;
  loadURL(url: string): Promise<void>;
  show(): void;
  hide(): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" | "allow" }): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
}

export interface BookmarkWindowCreateOptions {
  bounds: BookmarkWindowBounds;
  alwaysOnTop: boolean;
  title: string;
}

/** Makes the window the state machine below drives; tests inject a fake. */
export type BookmarkWindowCreator = (
  options: BookmarkWindowCreateOptions,
  hooks: BookmarkWebWindowHooks,
) => Promise<BookmarkWindowLike>;

/**
 * The real window. Electron is imported lazily so this module stays importable
 * (and testable) under plain Node. Everything in the file header's hardening
 * list is applied here, at construction.
 */
export const electronWindowCreator: BookmarkWindowCreator = async ({ bounds, alwaysOnTop, title }, hooks) => {
  const { BrowserWindow, session } = await import("electron");
  const created = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    title,
    frame: true,
    show: false,
    alwaysOnTop,
    skipTaskbar: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      partition: BOOKMARK_PARTITION,
    },
  }) as unknown as BookmarkWindowLike;
  created.setAlwaysOnTop(alwaysOnTop, "floating");
  // Arbitrary sites must not be able to ask for camera/mic/notifications.
  try {
    const partition = (session as unknown as { fromPartition(name: string): { setPermissionRequestHandler(handler: (...args: unknown[]) => void): void } })
      .fromPartition(BOOKMARK_PARTITION);
    partition.setPermissionRequestHandler((...args: unknown[]) => {
      const callback = args[2];
      if (typeof callback === "function") (callback as (granted: boolean) => void)(false);
    });
  } catch (error) {
    hooks.log("warn", "bookmark window: permission handler not installed", error);
  }
  created.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isHttpUrl(target)) void hooks.openExternal(target);
    return { action: "deny" };
  });
  const guard = (...args: unknown[]): void => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const target = typeof args[1] === "string" ? args[1] : "";
    if (!isHttpUrl(target)) {
      event?.preventDefault?.();
      hooks.log("warn", `bookmark window refused a non-http navigation to ${target}`);
    }
  };
  created.webContents.on("will-navigate", guard);
  created.webContents.on("will-redirect", guard);
  created.webContents.on("will-attach-webview", (...args: unknown[]) => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    event?.preventDefault?.();
    hooks.log("warn", "bookmark window refused a webview attachment");
  });
  return created;
};

/**
 * One reusable window, its current address and its bounds listeners. Split
 * from the Electron construction above so the whole state machine — including
 * "the page failed to load" — is exercised offline.
 */
export function createBookmarkWebWindow(
  hooks: BookmarkWebWindowHooks,
  createWindow: BookmarkWindowCreator = electronWindowCreator,
): BookmarkWebWindow {
  let window: BookmarkWindowLike | undefined;
  let url: string | undefined;
  const boundsListeners = new Set<(bounds: BookmarkWindowBounds) => void>();

  function announceBounds(): void {
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds();
    for (const listener of boundsListeners) {
      try {
        listener({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y });
      } catch (error) {
        hooks.log("warn", "bookmark window bounds listener failed", error);
      }
    }
  }

  async function ensure(
    bounds: BookmarkWindowBounds,
    alwaysOnTop: boolean,
    title: string,
  ): Promise<BookmarkWindowLike> {
    if (window && !window.isDestroyed()) {
      window.setTitle(title);
      window.setAlwaysOnTop(alwaysOnTop, "floating");
      return window;
    }
    const created = await createWindow({ bounds, alwaysOnTop, title }, hooks);
    created.on("closed", () => {
      window = undefined;
      url = undefined;
    });
    created.on("moved", announceBounds);
    created.on("resized", announceBounds);
    window = created;
    return created;
  }

  const api: BookmarkWebWindow = {
    async open(target, title, bounds, alwaysOnTop) {
      if (!isHttpUrl(target)) throw new Error("only http and https addresses can be opened");
      const win = await ensure(bounds, alwaysOnTop, title);
      try {
        if (url !== target) await win.loadURL(target);
        url = target;
      } catch (error) {
        // loadURL rejects on a routine ERR_ABORTED (a redirect, a cancelled
        // navigation). The window must still appear — and must NOT remember
        // this address, so the next press loads it again instead of showing a
        // blank page.
        url = undefined;
        hooks.log("warn", `bookmark window could not load ${target}: ${String(error)}`);
      } finally {
        win.show();
      }
    },
    async toggle(target, title, bounds, alwaysOnTop) {
      if (window && !window.isDestroyed() && window.isVisible() && url === target) {
        window.hide();
        return false;
      }
      await api.open(target, title, bounds, alwaysOnTop);
      return true;
    },
    close() {
      if (!window || window.isDestroyed()) return false;
      window.close();
      window = undefined;
      url = undefined;
      return true;
    },
    isOpen() {
      return Boolean(window && !window.isDestroyed());
    },
    isVisible() {
      return Boolean(window && !window.isDestroyed() && window.isVisible());
    },
    currentUrl() {
      return url;
    },
    onBoundsChanged(callback) {
      boundsListeners.add(callback);
      return () => boundsListeners.delete(callback);
    },
  };
  return api;
}

export const electronBookmarkWebWindow: BookmarkWebWindowFactory = (hooks) => createBookmarkWebWindow(hooks);
