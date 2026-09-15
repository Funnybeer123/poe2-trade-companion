/**
 * The overlay window service (brief D2): one transparent, always-on-top,
 * click-through window that shows feature panels above the game.
 *
 * Electron is injected (window factory, screen) so the service is exercised
 * in tests with fakes. Mouse handling is the subtle part:
 *  - by default the window ignores the mouse (`setIgnoreMouseEvents(true,
 *    { forward: true })`) so the game keeps every click;
 *  - the renderer flips that off while the pointer is over a panel
 *    ("overlay:set-ignore-mouse");
 *  - "close on click outside" cannot be implemented from a click-through
 *    window (the click never reaches us and Electron has no global-click
 *    signal), so while a NON-pinned panel is open and the setting is on, the
 *    whole window captures the mouse and the renderer's root click handler
 *    closes the unpinned panels. Trade-off, documented here on purpose: the
 *    game does not receive clicks while such a panel is open — exactly like
 *    a modal tooltip — and pinned panels never trigger the capture.
 */
import {
  DEFAULT_PANEL_SIZE,
  resolvePanelPosition,
  type OverlayAnchor,
  type OverlayPanelCommand,
  type OverlayPanelEvent,
  type OverlaySettings,
  type OverlayShowOptions,
  type OverlayState,
  type OverlayStyle,
} from "../shared/overlay.js";

export interface OverlayService {
  show(panelId: string, options?: OverlayShowOptions): Promise<void>;
  update(panelId: string, payload: unknown): void;
  hide(panelId: string): void;
  /** Hides every non-pinned panel; `includePinned` (default false) hides those too. */
  hideAll(includePinned?: boolean): void;
  toggle(panelId: string, options?: OverlayShowOptions): Promise<void>;
  isVisible(panelId: string): boolean;
  /** An open panel takes keyboard focus, or gives it back to the game. */
  setFocus(panelId: string, focus: boolean): void;
  state(): OverlayState;
  onPanelEvent(callback: (event: OverlayPanelEvent) => void): () => void;
  /** Main-side mirror of the "overlay:state-changed" event. */
  onStateChange(callback: (state: OverlayState) => void): () => void;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of BrowserWindow the service drives (fakeable). */
export interface OverlayWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
  show(): void;
  showInactive(): void;
  hide(): void;
  focus(): void;
  /** Optional on fakes: hands keyboard focus back to the game (setFocus(id, false)). */
  blur?(): void;
  setFocusable(focusable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  destroy(): void;
  once(event: "closed", listener: () => void): unknown;
  /** Optional on fakes: focus loss closes the unpinned typing panels (click-outside). */
  on?(event: "blur", listener: () => void): unknown;
  webContents: {
    send(channel: string, payload: unknown): void;
    isLoading(): boolean;
    once(event: "did-finish-load", listener: () => void): unknown;
  };
}

export interface OverlayDisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

export interface OverlayScreenLike {
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): OverlayDisplayLike;
  getPrimaryDisplay(): OverlayDisplayLike;
}

export interface OverlayWindowOptions {
  /** Creates the (hidden) window and starts loading the renderer at #/overlay. */
  createWindow(): OverlayWindowLike;
  screen: OverlayScreenLike;
  settings: () => OverlaySettings;
  /** Reaches every app window ("overlay:state-changed"). */
  emit(channel: string, payload: unknown): void;
  /** ctx.registerWindow, so ctx.emit reaches the overlay too. */
  registerWindow(window: OverlayWindowLike): void;
  /** Whether a Path of Exile process is running (ctx.poeWindows). */
  poeRunning: () => Promise<boolean>;
  /** Injected for tests. */
  timers?: {
    setInterval: (callback: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** How often to re-check the game process while panels are open (default 5 s). */
  pollMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

interface PanelRecord {
  pinned: boolean;
  focus: boolean;
  anchor: OverlayAnchor;
  size: { width: number; height: number };
  position: { x: number; y: number };
}

export const OVERLAY_POLL_MS = 5_000;

export class OverlayWindowService implements OverlayService {
  private window: OverlayWindowLike | undefined;
  private ready: Promise<OverlayWindowLike> | undefined;
  private readonly panels = new Map<string, PanelRecord>();
  private readonly listeners = new Set<(event: OverlayPanelEvent) => void>();
  private readonly stateListeners = new Set<(state: OverlayState) => void>();
  private pointerOverPanel = false;
  /** Set while a setFocus(id, false) hands focus back to the game (see onBlur). */
  private focusReleasePending = false;
  /** The renderer's last wish (true = click-through; false only while the pointer is over a panel). */
  private ignoreRequested = true;
  private display: OverlayDisplayLike | undefined;
  private poeDetected = false;
  private poll: unknown;
  private polling = false;

  constructor(private readonly options: OverlayWindowOptions) {}

  async show(panelId: string, options: OverlayShowOptions = {}): Promise<void> {
    const id = String(panelId);
    const settings = this.options.settings();
    const win = await this.ensureWindow();
    if (win.isDestroyed()) return;
    const cursor = this.options.screen.getCursorScreenPoint();
    const display = settings.primaryMonitorOnly
      ? this.options.screen.getPrimaryDisplay()
      : this.options.screen.getDisplayNearestPoint(cursor);
    // Re-place the window only when nothing is on it: moving it under an
    // open panel would yank that panel to another monitor.
    if (this.panels.size === 0 || this.display?.id !== display.id) {
      win.setBounds(display.bounds);
      this.display = display;
    }
    const bounds = this.display?.bounds ?? display.bounds;
    const existing = this.panels.get(id);
    const size = {
      width: options.width ?? existing?.size.width ?? DEFAULT_PANEL_SIZE.width,
      height: options.height ?? existing?.size.height ?? DEFAULT_PANEL_SIZE.height,
    };
    const anchor = options.anchor ?? existing?.anchor ?? "cursor";
    const position = resolvePanelPosition({
      anchor,
      window: { width: bounds.width, height: bounds.height },
      cursor: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
      size,
      ultrawideMode: settings.ultrawideMode,
    });
    const record: PanelRecord = {
      pinned: options.pinned ?? existing?.pinned ?? false,
      focus: options.focus ?? existing?.focus ?? false,
      anchor,
      size,
      position,
    };
    this.panels.set(id, record);
    this.send(win, {
      action: "show",
      panelId: id,
      payload: options.payload,
      anchor,
      position,
      pinned: record.pinned,
      focus: record.focus,
      size,
      style: this.style(settings),
    });
    if (record.focus) {
      // A panel taking focus again: the next blur is a real click outside.
      this.focusReleasePending = false;
      win.setFocusable(true);
      win.show();
      win.focus();
    } else if (!win.isVisible()) {
      win.showInactive();
    }
    this.applyMouseMode(win);
    this.startPoll();
    this.emitState();
  }

  update(panelId: string, payload: unknown): void {
    const win = this.liveWindow();
    if (!win || !this.panels.has(panelId)) return;
    this.send(win, { action: "update", panelId, payload, style: this.style(this.options.settings()) });
  }

  hide(panelId: string): void {
    if (!this.panels.delete(panelId)) return;
    const win = this.liveWindow();
    if (win) this.send(win, { action: "hide", panelId, style: this.style(this.options.settings()) });
    this.afterPanelsChanged();
  }

  /**
   * Hides every non-pinned panel; pinned ones survive until hidden
   * explicitly, or with `includePinned` (reset-windows, the game is gone).
   */
  hideAll(includePinned = false): void {
    this.hidePanels(Boolean(includePinned));
  }

  /**
   * "overlay:set-focus" from the renderer: an open panel takes keyboard focus
   * (a field got focus) or gives it back — without a re-show, so the panel
   * keeps its position, payload and scroll.
   *
   * Releasing it only returns the window to non-focusable once NO open panel
   * holds focus any more, and then blurs it so the game gets the keyboard
   * back. That blur must not read as a click outside: the panel's focus flag
   * is already false when it arrives, and `focusReleasePending` swallows it
   * even if another panel still holds one (see onBlur).
   */
  setFocus(panelId: string, focus: boolean): void {
    const id = String(panelId);
    const panel = this.panels.get(id);
    if (!panel) return;
    const wanted = Boolean(focus);
    panel.focus = wanted;
    const win = this.liveWindow();
    if (wanted) {
      this.focusReleasePending = false;
      if (win) {
        win.setFocusable(true);
        win.show();
        win.focus();
      }
    } else if (win && ![...this.panels.values()].some((open) => open.focus)) {
      win.setFocusable(false);
      this.focusReleasePending = true;
      try {
        win.blur?.();
      } catch (error) {
        this.options.log?.("warn", "overlay blur failed", error);
      }
    }
    this.emitState();
  }

  async toggle(panelId: string, options?: OverlayShowOptions): Promise<void> {
    if (this.isVisible(panelId)) this.hide(panelId);
    else await this.show(panelId, options);
  }

  isVisible(panelId: string): boolean {
    return this.panels.has(panelId);
  }

  state(): OverlayState {
    const win = this.liveWindow();
    return {
      windowVisible: Boolean(win?.isVisible()),
      visiblePanels: [...this.panels.keys()],
      pinnedPanels: [...this.panels.entries()].filter(([, panel]) => panel.pinned).map(([id]) => id),
      pointerOverPanel: this.pointerOverPanel,
      ...(this.display
        ? { display: { id: this.display.id, bounds: { ...this.display.bounds }, scaleFactor: this.display.scaleFactor } }
        : {}),
      poeDetected: this.poeDetected,
    };
  }

  onPanelEvent(callback: (event: OverlayPanelEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Main-side mirror of the "overlay:state-changed" event (same payload, same
   * moments) for features that follow the overlay without a renderer round
   * trip. Returns the unsubscribe.
   */
  onStateChange(callback: (state: OverlayState) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /** "overlay:set-ignore-mouse" from the renderer (pointer over / left a panel). */
  setIgnoreMouse(ignore: boolean): void {
    this.ignoreRequested = Boolean(ignore);
    const win = this.liveWindow();
    if (win) this.applyMouseMode(win);
  }

  /** "overlay:panel-event" from the renderer. */
  handlePanelEvent(event: OverlayPanelEvent): void {
    const id = String(event?.panelId ?? "");
    switch (event?.kind) {
      case "closed-by-user":
      case "hidden":
        if (this.panels.delete(id)) this.afterPanelsChanged();
        break;
      case "pointer-enter":
        this.pointerOverPanel = true;
        break;
      case "pointer-leave":
        this.pointerOverPanel = false;
        break;
      case "resized": {
        const panel = this.panels.get(id);
        if (panel && event.size) panel.size = { width: event.size.width, height: event.size.height };
        break;
      }
      default:
        break;
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.log?.("warn", "overlay panel listener failed", error);
      }
    }
  }

  /** Settings changed: push the presentation values and re-evaluate mouse capture. */
  applySettings(): void {
    const win = this.liveWindow();
    if (!win) return;
    this.send(win, { action: "update", style: this.style(this.options.settings()) });
    this.applyMouseMode(win);
  }

  dispose(): void {
    this.stopPoll();
    this.panels.clear();
    const win = this.window;
    this.window = undefined;
    this.ready = undefined;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // Already closing.
      }
    }
  }

  private hidePanels(includePinned: boolean): void {
    let changed = false;
    for (const [id, panel] of [...this.panels.entries()]) {
      if (includePinned || !panel.pinned) {
        this.panels.delete(id);
        changed = true;
      }
    }
    const win = this.liveWindow();
    if (win) this.send(win, { action: "hide-all", pinned: includePinned, style: this.style(this.options.settings()) });
    if (changed) this.afterPanelsChanged();
  }

  private afterPanelsChanged(): void {
    const win = this.liveWindow();
    if (win) {
      if (this.panels.size === 0) {
        win.setFocusable(false);
        win.hide();
        this.pointerOverPanel = false;
        this.ignoreRequested = true;
        this.stopPoll();
      } else if (![...this.panels.values()].some((panel) => panel.focus)) {
        win.setFocusable(false);
      }
      this.applyMouseMode(win);
    }
    this.emitState();
  }

  /** The overlay lost focus (the user clicked the game): close the unpinned panels that held it. */
  private onBlur(win: OverlayWindowLike): void {
    if (this.window !== win) return;
    // The blur we asked for in setFocus(id, false): the user gave the
    // keyboard back to the game from inside the panel, not by clicking away.
    if (this.focusReleasePending) {
      this.focusReleasePending = false;
      return;
    }
    if (!this.options.settings().closeOnClickOutside) return;
    if (![...this.panels.values()].some((panel) => panel.focus && !panel.pinned)) return;
    this.hidePanels(false);
  }

  private applyMouseMode(win: OverlayWindowLike): void {
    // Never take the whole screen's mouse: every click that is not on a panel
    // must reach the game. Click-outside is detected through focus loss
    // (onBlur) for the panels that took focus, and not at all for the rest.
    const ignore = this.ignoreRequested;
    try {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    } catch (error) {
      this.options.log?.("warn", "setIgnoreMouseEvents failed", error);
    }
  }

  private style(settings: OverlaySettings): OverlayStyle {
    return {
      scale: settings.scale,
      opacity: settings.opacity,
      closeOnClickOutside: settings.closeOnClickOutside,
    };
  }

  private send(win: OverlayWindowLike, command: OverlayPanelCommand): void {
    try {
      win.webContents.send("overlay:panel", command);
    } catch (error) {
      this.options.log?.("warn", "overlay command failed", error);
    }
  }

  private emitState(): void {
    const state = this.state();
    try {
      this.options.emit("overlay:state-changed", state);
    } catch (error) {
      this.options.log?.("warn", "overlay state emit failed", error);
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (error) {
        this.options.log?.("warn", "overlay state listener failed", error);
      }
    }
  }

  private liveWindow(): OverlayWindowLike | undefined {
    if (!this.window) return undefined;
    if (this.window.isDestroyed()) {
      this.window = undefined;
      this.ready = undefined;
      return undefined;
    }
    return this.window;
  }

  /** Lazily creates the window on first show and waits for the renderer to load. */
  private ensureWindow(): Promise<OverlayWindowLike> {
    const live = this.liveWindow();
    if (live && this.ready) return this.ready;
    const win = this.options.createWindow();
    this.window = win;
    win.once("closed", () => {
      if (this.window === win) {
        this.window = undefined;
        this.ready = undefined;
        this.panels.clear();
        this.stopPoll();
        this.emitState();
      }
    });
    this.options.registerWindow(win);
    // Click-outside for typing panels: the window only ever holds focus while
    // a focus panel is open, so losing it means the user clicked the game.
    // The game's clicks are never captured to detect this (see applyMouseMode).
    try {
      win.on?.("blur", () => this.onBlur(win));
    } catch (error) {
      this.options.log?.("warn", "overlay blur hook failed", error);
    }
    this.ready = new Promise<OverlayWindowLike>((resolve) => {
      if (!win.webContents.isLoading()) {
        resolve(win);
        return;
      }
      win.webContents.once("did-finish-load", () => resolve(win));
    });
    return this.ready;
  }

  private timers(): NonNullable<OverlayWindowOptions["timers"]> {
    return (
      this.options.timers ?? {
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      }
    );
  }

  private startPoll(): void {
    if (this.poll !== undefined) return;
    this.poll = this.timers().setInterval(() => void this.pollPoe(), this.options.pollMs ?? OVERLAY_POLL_MS);
  }

  private stopPoll(): void {
    if (this.poll === undefined) return;
    this.timers().clearInterval(this.poll);
    this.poll = undefined;
  }

  /**
   * Every 5 s while panels are open: with showOnlyWhilePoeRuns, hide
   * everything (pinned included) once no Path of Exile process is left. An
   * explicit hotkey press still shows a panel — the user asked for it — so
   * the check never blocks show().
   */
  private async pollPoe(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.poeDetected = await this.options.poeRunning();
    } catch {
      this.poeDetected = false;
    } finally {
      this.polling = false;
    }
    if (!this.poeDetected && this.options.settings().showOnlyWhilePoeRuns && this.panels.size > 0) {
      this.hidePanels(true);
    }
  }
}

export function createOverlayWindowService(options: OverlayWindowOptions): OverlayWindowService {
  return new OverlayWindowService(options);
}
