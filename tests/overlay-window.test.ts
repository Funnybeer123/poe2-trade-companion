import { describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createHotkeysModule } from "../src/main/features/hotkeys/index.js";
import { createOverlayModule } from "../src/main/features/overlay/index.js";
import {
  createOverlayWindowService,
  type OverlayDisplayLike,
  type OverlayScreenLike,
  type OverlayWindowLike,
} from "../src/main/overlayWindow.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import {
  DEFAULT_OVERLAY_SETTINGS,
  type OverlayPanelCommand,
  type OverlaySettings,
  type OverlayState,
} from "../src/shared/overlay.js";

const PRIMARY: OverlayDisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const SECOND: OverlayDisplayLike = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };

function fakeWindow() {
  const calls: string[] = [];
  const commands: OverlayPanelCommand[] = [];
  let visible = false;
  let destroyed = false;
  let bounds = { x: 0, y: 0, width: 800, height: 600 };
  let loading = true;
  const loadListeners: Array<() => void> = [];
  const closedListeners: Array<() => void> = [];
  const blurListeners: Array<() => void> = [];
  const win: OverlayWindowLike & {
    calls: string[];
    commands: OverlayPanelCommand[];
    finishLoad(): void;
    close(): void;
    blur(): void;
  } = {
    calls,
    commands,
    blur: () => {
      for (const listener of blurListeners) listener();
    },
    finishLoad: () => {
      loading = false;
      for (const listener of loadListeners.splice(0)) listener();
    },
    close: () => {
      destroyed = true;
      for (const listener of closedListeners.splice(0)) listener();
    },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getBounds: () => bounds,
    setBounds: (next) => {
      bounds = { ...next };
      calls.push(`setBounds ${next.x},${next.y} ${next.width}x${next.height}`);
    },
    show: () => {
      visible = true;
      calls.push("show");
    },
    showInactive: () => {
      visible = true;
      calls.push("showInactive");
    },
    hide: () => {
      visible = false;
      calls.push("hide");
    },
    focus: () => calls.push("focus"),
    setFocusable: (focusable) => calls.push(`setFocusable ${focusable}`),
    setIgnoreMouseEvents: (ignore, options) => calls.push(`ignoreMouse ${ignore}${options?.forward ? " forward" : ""}`),
    destroy: () => {
      destroyed = true;
      calls.push("destroy");
    },
    once: (_event, listener) => closedListeners.push(listener),
    on: (_event, listener) => blurListeners.push(listener),
    webContents: {
      send: (_channel, payload) => commands.push(payload as OverlayPanelCommand),
      isLoading: () => loading,
      once: (_event, listener) => loadListeners.push(listener),
    },
  };
  return win;
}

function fakeScreen(cursor = { x: 500, y: 400 }, displays = [PRIMARY, SECOND]): OverlayScreenLike & { cursor: { x: number; y: number } } {
  const state = { cursor };
  return {
    cursor: state.cursor,
    getCursorScreenPoint: () => state.cursor,
    getDisplayNearestPoint: (point) =>
      displays.find(
        (display) =>
          point.x >= display.bounds.x &&
          point.x < display.bounds.x + display.bounds.width &&
          point.y >= display.bounds.y &&
          point.y < display.bounds.y + display.bounds.height,
      ) ?? displays[0]!,
    getPrimaryDisplay: () => displays[0]!,
  };
}

function harness(settingsOverrides: Partial<OverlaySettings> = {}, options: { poe?: boolean; loaded?: boolean } = {}) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const settings = { ...DEFAULT_OVERLAY_SETTINGS, ...settingsOverrides };
  const screen = fakeScreen();
  const emitted: Array<[string, unknown]> = [];
  const registered: OverlayWindowLike[] = [];
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  let poe = options.poe ?? true;
  const service = createOverlayWindowService({
    createWindow: () => {
      const win = fakeWindow();
      if (options.loaded) win.finishLoad();
      windows.push(win);
      return win;
    },
    screen,
    settings: () => settings,
    emit: (channel, payload) => emitted.push([channel, payload]),
    registerWindow: (win) => registered.push(win),
    poeRunning: async () => poe,
    timers: {
      setInterval: (callback, ms) => {
        intervals.push({ callback, ms });
        return intervals.length;
      },
      clearInterval: (handle) => {
        intervals.splice((handle as number) - 1, 1);
      },
    },
  });
  return {
    service,
    windows,
    settings,
    screen,
    emitted,
    registered,
    intervals,
    setPoe: (value: boolean) => {
      poe = value;
    },
    win: () => windows[0]!,
  };
}

describe("OverlayWindowService", () => {
  it("creates the window lazily, waits for the load, and shows a panel at the cursor", async () => {
    const h = harness();
    expect(h.windows).toHaveLength(0);
    const shown = h.service.show("notice", { payload: { title: "Hi" }, width: 300, height: 100 });
    expect(h.windows).toHaveLength(1);
    expect(h.registered).toEqual([h.win()]);
    expect(h.win().commands).toHaveLength(0);
    h.win().finishLoad();
    await shown;
    expect(h.win().calls).toEqual(["setBounds 0,0 1920x1080", "showInactive", "ignoreMouse true forward"]);
    expect(h.win().commands).toEqual([
      {
        action: "show",
        panelId: "notice",
        payload: { title: "Hi" },
        anchor: "cursor",
        position: { x: 512, y: 412 },
        pinned: false,
        focus: false,
        size: { width: 300, height: 100 },
        style: { scale: 1, opacity: 0.96, closeOnClickOutside: true },
      },
    ]);
    expect(h.service.isVisible("notice")).toBe(true);
    expect(h.service.state()).toMatchObject({
      windowVisible: true,
      visiblePanels: ["notice"],
      pinnedPanels: [],
      display: { id: 1 },
    });
    expect(h.emitted.at(-1)?.[0]).toBe("overlay:state-changed");
    // A second show reuses the window; commands are sent right away.
    await h.service.show("notice", { anchor: "top-right" });
    expect(h.windows).toHaveLength(1);
    expect(h.win().commands.at(-1)).toMatchObject({ action: "show", position: { x: 1608, y: 12 } });
  });

  it("uses the display under the cursor, or the primary one when configured", async () => {
    const h = harness({}, { loaded: true });
    h.screen.cursor.x = 3000;
    h.screen.cursor.y = 700;
    await h.service.show("notice");
    expect(h.win().calls[0]).toBe("setBounds 1920,0 2560x1440");
    expect(h.win().commands[0]!.position).toEqual({ x: 1092, y: 712 });
    expect(h.service.state().display?.id).toBe(2);

    const p = harness({ primaryMonitorOnly: true }, { loaded: true });
    p.screen.cursor.x = 3000;
    await p.service.show("notice");
    expect(p.win().calls[0]).toBe("setBounds 0,0 1920x1080");
  });

  it("hides the window once the last panel is gone and keeps click-through otherwise", async () => {
    const h = harness({ closeOnClickOutside: false }, { loaded: true });
    await h.service.show("a");
    expect(h.win().calls).toContain("ignoreMouse true forward");
    await h.service.show("b");
    h.win().calls.length = 0;
    h.service.hide("a");
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide", panelId: "a" });
    expect(h.win().calls).toEqual(["setFocusable false", "ignoreMouse true forward"]);
    h.service.hide("b");
    expect(h.win().calls).toContain("hide");
    expect(h.service.state()).toMatchObject({ windowVisible: false, visiblePanels: [] });
    h.service.hide("b");
    expect(h.win().calls.filter((call) => call === "hide")).toHaveLength(1);
  });

  it("never takes the game's mouse for click-outside; focused panels close when the window loses focus", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("pinned", { pinned: true });
    expect(h.win().calls.at(-1)).toBe("ignoreMouse true forward");
    await h.service.show("loose");
    // Click-through stays on: every click that is not on a panel reaches the game.
    expect(h.win().calls.at(-1)).toBe("ignoreMouse true forward");
    // Only the renderer's pointer-over request takes the mouse, and only until it leaves.
    h.service.setIgnoreMouse(false);
    expect(h.win().calls.at(-1)).toBe("ignoreMouse false forward");
    h.service.setIgnoreMouse(true);
    expect(h.win().calls.at(-1)).toBe("ignoreMouse true forward");
    // A blur with only click-through panels open changes nothing (the window never had focus).
    h.win().blur();
    expect(h.service.state().visiblePanels).toEqual(["pinned", "loose"]);
    // A typing panel took focus; the user clicking the game blurs the window and closes the unpinned ones.
    await h.service.show("search", { focus: true });
    h.win().blur();
    expect(h.service.state().visiblePanels).toEqual(["pinned"]);
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide-all", pinned: false });
    // With the setting off, a typing panel survives the blur.
    h.settings.closeOnClickOutside = false;
    await h.service.show("search", { focus: true });
    h.win().blur();
    expect(h.service.state().visiblePanels).toEqual(["pinned", "search"]);
    h.service.handlePanelEvent({ panelId: "pinned", kind: "pointer-enter" });
    expect(h.service.state().pointerOverPanel).toBe(true);
    h.service.handlePanelEvent({ panelId: "pinned", kind: "pointer-leave" });
    expect(h.service.state().pointerOverPanel).toBe(false);
  });

  it("hideAll keeps pinned panels; toggle flips; focus panels make the window focusable", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("pinned", { pinned: true });
    await h.service.show("search", { focus: true });
    expect(h.win().calls).toEqual(expect.arrayContaining(["setFocusable true", "show", "focus"]));
    h.service.hideAll();
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide-all", pinned: false });
    expect(h.service.state().visiblePanels).toEqual(["pinned"]);
    expect(h.win().calls.at(-2)).toBe("setFocusable false");
    await h.service.toggle("pinned");
    expect(h.service.isVisible("pinned")).toBe(false);
    expect(h.service.state().windowVisible).toBe(false);
    await h.service.toggle("pinned", { anchor: "center" });
    expect(h.service.isVisible("pinned")).toBe(true);
  });

  it("update() pushes a payload to an open panel only, and settings changes push style live", async () => {
    const h = harness({}, { loaded: true });
    h.service.update("ghost", { n: 1 });
    await h.service.show("notice");
    h.service.update("ghost", { n: 1 });
    h.service.update("notice", { n: 2 });
    expect(h.win().commands.at(-1)).toMatchObject({ action: "update", panelId: "notice", payload: { n: 2 } });
    h.settings.scale = 1.5;
    h.settings.closeOnClickOutside = false;
    h.service.applySettings();
    expect(h.win().commands.at(-1)).toEqual({
      action: "update",
      style: { scale: 1.5, opacity: 0.96, closeOnClickOutside: false },
    });
    expect(h.win().calls.at(-1)).toBe("ignoreMouse true forward");
  });

  it("polls for the game every 5 s while panels are open and hides everything when it is gone", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("pinned", { pinned: true });
    expect(h.intervals).toEqual([{ callback: expect.any(Function), ms: 5000 }]);
    h.intervals[0]!.callback();
    await vi.waitFor(() => expect(h.service.state().poeDetected).toBe(true));
    expect(h.service.state().visiblePanels).toEqual(["pinned"]);
    h.setPoe(false);
    h.intervals[0]!.callback();
    await vi.waitFor(() => expect(h.service.state().visiblePanels).toEqual([]));
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide-all", pinned: true });
    expect(h.intervals).toHaveLength(0);
    // The user pressing a hotkey still shows a panel without the game.
    await h.service.show("notice");
    expect(h.service.state()).toMatchObject({ visiblePanels: ["notice"], poeDetected: false });
    // The check is off when the setting is off.
    const off = harness({ showOnlyWhilePoeRuns: false }, { loaded: true, poe: false });
    await off.service.show("notice");
    off.intervals[0]!.callback();
    await vi.waitFor(() => expect(off.service.state().poeDetected).toBe(false));
    expect(off.service.state().visiblePanels).toEqual(["notice"]);
  });

  it("setFocus takes keyboard focus without re-showing and hands it back without closing the panel", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("trade", { width: 380, height: 260 });
    const shownCommands = h.win().commands.length;
    h.win().calls.length = 0;
    const blurSpy = vi.fn(h.win().blur);
    h.win().blur = blurSpy;

    // Take focus: the window becomes focusable, no new "show" command.
    h.service.setFocus("trade", true);
    expect(h.win().calls).toEqual(["setFocusable true", "show", "focus"]);
    expect(h.win().commands).toHaveLength(shownCommands);
    expect(h.emitted.at(-1)?.[0]).toBe("overlay:state-changed");

    // Give it back: non-focusable + blur(), and that blur is NOT a click outside.
    h.win().calls.length = 0;
    h.service.setFocus("trade", false);
    expect(h.win().calls).toEqual(["setFocusable false"]);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(h.settings.closeOnClickOutside).toBe(true);
    expect(h.service.state().visiblePanels).toEqual(["trade"]);
    expect(h.win().commands).toHaveLength(shownCommands);

    // A real blur afterwards still closes a panel that holds focus.
    h.service.setFocus("trade", true);
    h.win().blur();
    expect(h.service.state().visiblePanels).toEqual([]);
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide-all", pinned: false });
  });

  it("setFocus only releases the window when no other panel holds focus, and ignores unknown panels", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("a", { focus: true });
    await h.service.show("b", { focus: true });
    const blurSpy = vi.fn(h.win().blur);
    h.win().blur = blurSpy;
    h.win().calls.length = 0;

    h.service.setFocus("b", false);
    expect(h.win().calls).toEqual([]);
    expect(blurSpy).not.toHaveBeenCalled();
    // "a" still types: a click on the game closes both, as before.
    h.service.setFocus("a", false);
    expect(h.win().calls).toEqual(["setFocusable false"]);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(h.service.state().visiblePanels).toEqual(["a", "b"]);

    h.service.setFocus("ghost", true);
    h.service.setFocus("ghost", false);
    expect(h.win().calls).toEqual(["setFocusable false"]);
    // Showing a focus panel re-arms click-outside even after a release.
    await h.service.show("c", { focus: true });
    h.win().blur();
    expect(h.service.state().visiblePanels).toEqual([]);
  });

  it("onStateChange mirrors overlay:state-changed until it is stopped", async () => {
    const h = harness({}, { loaded: true });
    const seen: OverlayState[] = [];
    const stop = h.service.onStateChange((state) => seen.push(state));
    await h.service.show("notice");
    expect(seen.at(-1)).toMatchObject({ visiblePanels: ["notice"], windowVisible: true });
    expect(seen).toHaveLength(h.emitted.filter(([channel]) => channel === "overlay:state-changed").length);
    h.service.hide("notice");
    expect(seen.at(-1)).toMatchObject({ visiblePanels: [], windowVisible: false });
    const before = seen.length;
    stop();
    await h.service.show("notice");
    expect(seen).toHaveLength(before);
    // A throwing listener never breaks the emit or the other listeners.
    const after: string[][] = [];
    h.service.onStateChange(() => {
      throw new Error("boom");
    });
    h.service.onStateChange((state) => after.push(state.visiblePanels));
    expect(() => h.service.hideAll()).not.toThrow();
    expect(after.at(-1)).toEqual([]);
  });

  it("hideAll(true) hides pinned panels too", async () => {
    const h = harness({}, { loaded: true });
    await h.service.show("pinned", { pinned: true });
    await h.service.show("loose");
    h.service.hideAll();
    expect(h.service.state().visiblePanels).toEqual(["pinned"]);
    h.service.hideAll(true);
    expect(h.win().commands.at(-1)).toMatchObject({ action: "hide-all", pinned: true });
    expect(h.service.state()).toMatchObject({ visiblePanels: [], windowVisible: false });
  });

  it("forgets a window that closed, notifies panel listeners, and destroys on dispose", async () => {
    const h = harness({}, { loaded: true });
    const seen: string[] = [];
    const stop = h.service.onPanelEvent((event) => seen.push(`${event.panelId}:${event.kind}`));
    await h.service.show("notice");
    h.service.handlePanelEvent({ panelId: "notice", kind: "resized", size: { width: 500, height: 300 } });
    stop();
    h.service.handlePanelEvent({ panelId: "notice", kind: "pointer-enter" });
    expect(seen).toEqual(["notice:resized"]);
    h.win().close();
    expect(h.service.state()).toMatchObject({ windowVisible: false, visiblePanels: [] });
    await h.service.show("notice");
    expect(h.windows).toHaveLength(2);
    h.service.dispose();
    expect(h.windows[1]!.calls).toContain("destroy");
    expect(h.intervals).toHaveLength(0);
  });
});

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return {
    ipc,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    },
  };
}

/** A runtime with just the hotkeys + overlay modules and a fake overlay window. */
async function moduleHarness() {
  const { ipc, invoke } = fakeIpc();
  const main = { isDestroyed: () => false, once: vi.fn(), webContents: { send: vi.fn() } };
  const files = new Map<string, string>();
  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: {} as never,
    settings: new SettingsStore({
      file: "settings.json",
      fs: { read: (file) => files.get(file), write: (file, text) => void files.set(file, text) },
    }),
    mainWindow: () => main as never,
    poeWindows: async () => [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    log: vi.fn(),
  });
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const result = await rt.register([
    createHotkeysModule({
      globalShortcut: { register: () => true, unregister: () => undefined, isRegistered: () => false },
      fs: { read: () => undefined, write: () => undefined },
      reserved: () => [],
    }),
    createOverlayModule({
      createWindow: () => {
        const win = fakeWindow();
        win.finishLoad();
        windows.push(win);
        return win;
      },
      screen: fakeScreen(),
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    }),
  ]);
  return { rt, invoke, windows, result, win: () => windows[0]! };
}

describe("overlay feature module", () => {
  it("handles overlay:set-focus and overlay:hide-all(includePinned), and provides onStateChange", async () => {
    const h = await moduleHarness();
    expect(h.result.failed).toEqual([]);
    expect(h.rt.ctx.channels()).toEqual(expect.arrayContaining(["overlay:set-focus", "overlay:hide-all"]));
    const service = h.rt.ctx.require("overlay");
    const seen: OverlayState[] = [];
    const stop = service.onStateChange((state) => seen.push(state));

    await h.invoke("overlay:show", "trade");
    expect(seen.at(-1)).toMatchObject({ visiblePanels: ["trade"] });
    h.win().calls.length = 0;
    await h.invoke("overlay:set-focus", "trade", true);
    expect(h.win().calls).toEqual(["setFocusable true", "show", "focus"]);
    await h.invoke("overlay:set-focus", "trade", false);
    expect(h.win().calls).toEqual(["setFocusable true", "show", "focus", "setFocusable false"]);
    // The blur the release caused did not close the panel.
    expect(await h.invoke("overlay:state")).toMatchObject({ visiblePanels: ["trade"] });

    await h.invoke("overlay:show", "pinned", { pinned: true });
    await h.invoke("overlay:hide-all");
    expect(await h.invoke("overlay:state")).toMatchObject({ visiblePanels: ["pinned"] });
    await h.invoke("overlay:hide-all", true);
    // (ctx.emit's state events land in the same fake channel, hence the filter)
    expect(h.win().commands.filter((command) => command.action === "hide-all").at(-1)).toMatchObject({
      action: "hide-all",
      pinned: true,
    });
    expect(await h.invoke("overlay:state")).toMatchObject({ visiblePanels: [], windowVisible: false });

    stop();
    const before = seen.length;
    await h.invoke("overlay:show", "trade");
    expect(seen).toHaveLength(before);
    await h.rt.dispose();
  });

  it("registers the overlay:* channels, the settings namespace, the service and the hide-all hotkey", async () => {
    const { ipc, invoke } = fakeIpc();
    const sent: Array<[string, unknown]> = [];
    const main = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    };
    const files = new Map<string, string>();
    const settings = new SettingsStore({
      file: "settings.json",
      fs: { read: (file) => files.get(file), write: (file, text) => void files.set(file, text) },
    });
    const rt = createFeatureRuntime({
      ipcMain: ipc,
      configDir: "C:/cfg",
      userDataDir: "C:/user",
      repoRoot: "C:/repo",
      buildMode: "authorized-qa",
      core: {} as never,
      settings,
      mainWindow: () => main as never,
      poeWindows: async () => [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }],
      killSwitchLatched: () => false,
      notify: vi.fn(),
      clipboard: { readText: () => "", writeText: vi.fn() },
      openExternal: vi.fn(async () => undefined),
      log: vi.fn(),
    });
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const shortcutRegistered = new Map<string, () => void>();
    const result = await rt.register([
      createHotkeysModule({
        globalShortcut: {
          register: (accelerator, callback) => {
            shortcutRegistered.set(accelerator, callback);
            return true;
          },
          unregister: (accelerator) => {
            shortcutRegistered.delete(accelerator);
          },
          isRegistered: (accelerator) => shortcutRegistered.has(accelerator),
        },
        fs: { read: () => undefined, write: () => undefined },
        reserved: () => [],
      }),
      createOverlayModule({
        createWindow: () => {
          const win = fakeWindow();
          win.finishLoad();
          windows.push(win);
          return win;
        },
        screen: fakeScreen(),
        timers: { setInterval: () => 1, clearInterval: () => undefined },
      }),
    ]);
    expect(result.failed).toEqual([]);
    expect(rt.ctx.channels()).toEqual(
      expect.arrayContaining([
        "overlay:state",
        "overlay:panel-event",
        "overlay:show",
        "overlay:hide",
        "overlay:hide-all",
        "overlay:set-ignore-mouse",
      ]),
    );
    expect((await invoke("settings:get")) as Record<string, unknown>).toMatchObject({ overlay: DEFAULT_OVERLAY_SETTINGS });
    expect(await invoke("hotkeys:list")).toEqual([
      expect.objectContaining({ id: "overlay.hide-all", group: "Overlay", accelerator: null, registered: false }),
    ]);

    await invoke("overlay:show", "notice", { payload: { title: "x" } });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.commands[0]).toMatchObject({ action: "show", panelId: "notice" });
    // ctx.emit reaches the overlay window too (registerWindow).
    rt.ctx.emit("demo:ping", 1);
    expect(windows[0]!.commands.at(-1)).toBe(1);
    expect(await invoke("overlay:state")).toMatchObject({ visiblePanels: ["notice"], windowVisible: true });
    await invoke("overlay:set-ignore-mouse", false);
    expect(windows[0]!.calls.at(-1)).toBe("ignoreMouse false forward");
    // Settings change → live style update.
    await invoke("settings:set", "overlay", { opacity: 0.5 });
    // (the settings:changed event reaches the overlay window too, after the style command)
    expect(windows[0]!.commands.at(-2)).toMatchObject({ action: "update", style: { opacity: 0.5 } });
    expect(windows[0]!.commands.at(-1)).toMatchObject({ id: "overlay", value: { opacity: 0.5 } });
    await invoke("overlay:panel-event", { panelId: "notice", kind: "closed-by-user" });
    expect(await invoke("overlay:state")).toMatchObject({ visiblePanels: [], windowVisible: false });
    await invoke("overlay:show", "notice");
    await invoke("hotkeys:trigger", "overlay.hide-all");
    expect(await invoke("overlay:state")).toMatchObject({ visiblePanels: [] });
    await invoke("overlay:show", "a");
    await invoke("overlay:hide", "a");
    await invoke("overlay:hide-all");
    expect(sent.some(([channel]) => channel === "overlay:state-changed")).toBe(true);
    // The overlay window dies with the main window so a hidden overlay never keeps the app alive.
    expect(main.once).toHaveBeenCalledWith("closed", expect.any(Function));
    (main.once.mock.calls[0]![1] as () => void)();
    expect(windows[0]!.calls).toContain("destroy");
    await invoke("overlay:show", "again");
    expect(windows).toHaveLength(2);
    await rt.dispose();
    expect(windows[1]!.calls).toContain("destroy");
    expect(rt.ctx.get("overlay")).toBeUndefined();
  });
});
