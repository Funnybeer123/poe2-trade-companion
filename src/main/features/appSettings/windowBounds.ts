/**
 * Remembers where the desktop window was, puts it back, and keeps the
 * "always on top" / "open when the game starts" options applied.
 *
 * The feature runtime registers BEFORE `createWindow()` runs and the context
 * has no window-created hook, so the tracker polls `getWindow()` for up to a
 * minute and attaches when the window appears. `createWindow()` has no
 * `show: false`/`ready-to-show` handshake, so the window is visible centred
 * for a moment and then jumps to the saved bounds — expected, not a bug.
 *
 * Nothing here touches the game: it drives only our own BrowserWindow.
 */
import {
  boundsOnSomeDisplay,
  centredBounds,
  DEFAULT_MAIN_WINDOW_SIZE,
  type DisplayArea,
  type WindowBounds,
} from "../../../core/appSettingsWindow.js";
import type { AppSettings } from "../../../shared/appSettings.js";

/** The slice of Electron's BrowserWindow the tracker drives (fakeable). */
export interface MainWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isVisible(): boolean;
  unmaximize(): void;
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  setSize(width: number, height: number): void;
  center(): void;
  setAlwaysOnTop(flag: boolean): void;
  show(): void;
  focus(): void;
  restore(): void;
  on(event: "move" | "resize", callback: () => void): unknown;
  removeListener(event: "move" | "resize", callback: () => void): unknown;
}

export interface TrackerTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TrackerSettings {
  get(): AppSettings;
  set(patch: Partial<AppSettings> | ((current: AppSettings) => AppSettings)): AppSettings;
  onChange(callback: (next: AppSettings, previous: AppSettings) => void): () => void;
}

export interface WindowTrackerOptions {
  getWindow: () => MainWindowLike | undefined;
  settings: TrackerSettings;
  displays: () => DisplayArea[];
  primary: () => DisplayArea;
  /** `ctx.poeWindows().length > 0` — already memoised for 4 s upstream. */
  poeRunning: () => Promise<boolean>;
  timers?: TrackerTimers;
  /** Bounds saves are debounced so a drag writes once, not per pixel. */
  debounceMs?: number;
  attachPollMs?: number;
  attachTries?: number;
  /**
   * Deliberately slow (20 s): the game-start poll shares `ctx.poeWindows()`'s
   * 4 s memo with the overlay's own 5 s poll, and nothing here is urgent.
   */
  gameStartPollMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_ATTACH_POLL_MS = 500;
const DEFAULT_ATTACH_TRIES = 120;
export const DEFAULT_GAME_START_POLL_MS = 20_000;

const realTimers: TrackerTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class MainWindowTracker {
  private readonly timers: TrackerTimers;
  private readonly debounceMs: number;
  private readonly attachPollMs: number;
  private readonly attachTries: number;
  private readonly gameStartPollMs: number;

  private window: MainWindowLike | undefined;
  private attachHandle: unknown;
  private attachAttempts = 0;
  private saveHandle: unknown;
  private gameStartHandle: unknown;
  private gameWasRunning = false;
  /** False until the first poll has recorded what the game was already doing. */
  private gameStartPrimed = false;
  private suppressSaves = false;
  private suppressHandle: unknown;
  private stopSettings: (() => void) | undefined;
  private moveListener: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: WindowTrackerOptions) {
    this.timers = options.timers ?? realTimers;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.attachPollMs = options.attachPollMs ?? DEFAULT_ATTACH_POLL_MS;
    this.attachTries = options.attachTries ?? DEFAULT_ATTACH_TRIES;
    this.gameStartPollMs = options.gameStartPollMs ?? DEFAULT_GAME_START_POLL_MS;
  }

  start(): void {
    if (this.disposed) return;
    this.stopSettings = this.options.settings.onChange((next, previous) => {
      if (next.window.alwaysOnTop !== previous.window.alwaysOnTop) this.applyAlwaysOnTop();
      if (next.window.showOnGameStart !== previous.window.showOnGameStart) this.syncGameStartPoll();
    });
    this.syncGameStartPoll();
    this.pollForWindow();
  }

  private pollForWindow(): void {
    if (this.disposed || this.window) return;
    const found = this.live();
    if (found) {
      this.attach(found);
      return;
    }
    if (this.attachAttempts >= this.attachTries) return;
    this.attachAttempts += 1;
    this.attachHandle = this.timers.setTimeout(() => {
      this.attachHandle = undefined;
      this.pollForWindow();
    }, this.attachPollMs);
  }

  private live(): MainWindowLike | undefined {
    const window = this.options.getWindow();
    if (!window) return undefined;
    try {
      return window.isDestroyed() ? undefined : window;
    } catch {
      return undefined;
    }
  }

  private attach(window: MainWindowLike): void {
    this.window = window;
    this.applyAlwaysOnTop();
    this.restoreBounds();
    const listener = (): void => this.scheduleSave();
    this.moveListener = listener;
    try {
      window.on("move", listener);
      window.on("resize", listener);
    } catch (error) {
      this.options.log?.("warn", "could not watch the window for moves", error);
    }
  }

  private restoreBounds(): void {
    const window = this.live();
    if (!window) return;
    const settings = this.options.settings.get().window;
    if (!settings.rememberBounds || !settings.bounds) return;
    try {
      if (window.isMaximized()) return;
      if (!boundsOnSomeDisplay(settings.bounds, this.options.displays())) {
        this.options.log?.("info", "saved window bounds are off-screen — keeping the default position");
        return;
      }
      window.setBounds(settings.bounds);
    } catch (error) {
      this.options.log?.("warn", "could not restore the window bounds", error);
    }
  }

  private scheduleSave(): void {
    if (this.disposed || this.suppressSaves) return;
    if (this.saveHandle !== undefined) this.timers.clearTimeout(this.saveHandle);
    this.saveHandle = this.timers.setTimeout(() => {
      this.saveHandle = undefined;
      this.saveBounds();
    }, this.debounceMs);
  }

  private saveBounds(): void {
    const window = this.live();
    if (!window) return;
    if (!this.options.settings.get().window.rememberBounds) return;
    try {
      if (window.isMaximized()) return;
      const bounds = window.getBounds();
      this.options.settings.set((current) => ({
        ...current,
        window: { ...current.window, bounds },
      }));
    } catch (error) {
      this.options.log?.("warn", "could not save the window bounds", error);
    }
  }

  applyAlwaysOnTop(): void {
    const window = this.live();
    if (!window) return;
    try {
      window.setAlwaysOnTop(this.options.settings.get().window.alwaysOnTop);
    } catch (error) {
      this.options.log?.("warn", "could not apply always-on-top", error);
    }
  }

  /**
   * Re-centres at the default size and forgets the saved rectangle.
   *
   * `setSize`/`center` make Electron emit `resize`/`move`, and our own
   * listener would then write the centred rectangle straight back — so
   * "forget where the window was" would never forget. Saves are suppressed
   * across the move and for one debounce window afterwards.
   */
  reset(): WindowBounds | null {
    this.beginSuppressingSaves();
    this.options.settings.set((current) => {
      const { bounds: _dropped, ...window } = current.window;
      return { ...current, window };
    });
    const window = this.live();
    if (!window) return null;
    try {
      if (window.isMaximized()) window.unmaximize();
      window.setSize(DEFAULT_MAIN_WINDOW_SIZE.width, DEFAULT_MAIN_WINDOW_SIZE.height);
      window.center();
      return window.getBounds();
    } catch (error) {
      this.options.log?.("warn", "could not reset the window position", error);
      return centredBounds(this.options.primary());
    }
  }

  private beginSuppressingSaves(): void {
    if (this.saveHandle !== undefined) {
      this.timers.clearTimeout(this.saveHandle);
      this.saveHandle = undefined;
    }
    if (this.suppressHandle !== undefined) this.timers.clearTimeout(this.suppressHandle);
    this.suppressSaves = true;
    this.suppressHandle = this.timers.setTimeout(() => {
      this.suppressHandle = undefined;
      this.suppressSaves = false;
    }, this.debounceMs * 2);
  }

  /** The `app.show-window` hotkey: front our own window, nothing else. */
  showAndFocus(): void {
    const window = this.live();
    if (!window) return;
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } catch (error) {
      this.options.log?.("warn", "could not front the window", error);
    }
  }

  private syncGameStartPoll(): void {
    const wanted = this.options.settings.get().window.showOnGameStart;
    if (!wanted) {
      if (this.gameStartHandle !== undefined) {
        this.timers.clearInterval(this.gameStartHandle);
        this.gameStartHandle = undefined;
      }
      this.gameWasRunning = false;
      this.gameStartPrimed = false;
      return;
    }
    if (this.gameStartHandle !== undefined) return;
    this.gameStartHandle = this.timers.setInterval(() => {
      void this.checkGameStart();
    }, this.gameStartPollMs);
  }

  /**
   * Edge-triggered on absent → present, and only while the window is out of
   * sight: the user asked for it to come back, not to be raised every 20 s.
   * `focus()` is deliberately NOT called — the game keeps keyboard focus.
   *
   * The FIRST poll only records what the game was already doing. Without that,
   * ticking the option (or starting the app) while the game is already running
   * reads as an absent → present edge and pops the window over the game.
   */
  private async checkGameStart(): Promise<void> {
    if (this.disposed) return;
    const window = this.live();
    if (!window) return;
    let hidden = false;
    try {
      hidden = window.isMinimized() || !window.isVisible();
    } catch {
      return;
    }
    let running = false;
    try {
      running = await this.options.poeRunning();
    } catch {
      return;
    }
    if (!this.gameStartPrimed) {
      this.gameStartPrimed = true;
      this.gameWasRunning = running;
      return;
    }
    const appeared = running && !this.gameWasRunning;
    this.gameWasRunning = running;
    if (!appeared || !hidden || this.disposed) return;
    try {
      if (window.isMinimized()) window.restore();
      window.show();
    } catch (error) {
      this.options.log?.("warn", "could not show the window on game start", error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopSettings?.();
    this.stopSettings = undefined;
    for (const handle of [this.attachHandle, this.saveHandle, this.suppressHandle]) {
      if (handle !== undefined) this.timers.clearTimeout(handle);
    }
    this.attachHandle = undefined;
    this.saveHandle = undefined;
    this.suppressHandle = undefined;
    if (this.gameStartHandle !== undefined) this.timers.clearInterval(this.gameStartHandle);
    this.gameStartHandle = undefined;
    const window = this.window;
    const listener = this.moveListener;
    if (window && listener) {
      try {
        window.removeListener("move", listener);
        window.removeListener("resize", listener);
      } catch {
        // A window mid-teardown must never break disposal.
      }
    }
    this.moveListener = undefined;
    this.window = undefined;
  }
}
