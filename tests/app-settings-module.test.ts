import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { createAppSettingsModule } from "../src/main/features/appSettings/index.js";
import { DEFAULT_OVERLAY_SETTINGS } from "../src/shared/overlay.js";
import type { OverlayPanelEvent } from "../src/shared/overlay.js";
import type { HotkeyAction } from "../src/main/hotkeyService.js";
import type { AppInfo, ElevationReport, SetupChecklist } from "../src/shared/appSettings.js";

// ---------------------------------------------------------------------------
// Harness — the tests/features-scaffold.test.ts runtime, with the foundations
// this module requires provided by stub modules registered before it.
// ---------------------------------------------------------------------------

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      read: (file: string) => files.get(file),
      write: (file: string, text: string) => void files.set(file, text),
    },
  };
}

interface FakeTimer {
  cb: () => void;
  ms: number;
  repeat: boolean;
  at: number;
}

function fakeTimers() {
  const tasks = new Map<number, FakeTimer>();
  let seq = 0;
  let clock = 0;
  const api = {
    setTimeout(cb: () => void, ms: number): unknown {
      const id = ++seq;
      tasks.set(id, { cb, ms, repeat: false, at: clock + ms });
      return id;
    },
    clearTimeout(handle: unknown): void {
      tasks.delete(handle as number);
    },
    setInterval(cb: () => void, ms: number): unknown {
      const id = ++seq;
      tasks.set(id, { cb, ms, repeat: true, at: clock + ms });
      return id;
    },
    clearInterval(handle: unknown): void {
      tasks.delete(handle as number);
    },
  };
  return {
    api,
    intervals: (): number[] => [...tasks.values()].filter((task) => task.repeat).map((task) => task.ms),
    pending: (): number => tasks.size,
    async advance(ms: number): Promise<void> {
      clock += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at > clock) continue;
        if (task.repeat) task.at = clock + task.ms;
        else tasks.delete(id);
        task.cb();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function fakeWindow() {
  const state = {
    bounds: { x: 0, y: 0, width: 1120, height: 860 },
    minimized: false,
    maximized: false,
    visible: true,
    alwaysOnTop: false,
    destroyed: false,
  };
  const listeners = new Map<string, Array<() => void>>();
  const window = {
    state,
    sent: [] as Array<[string, unknown]>,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isVisible: () => state.visible,
    unmaximize: vi.fn(() => void (state.maximized = false)),
    getBounds: () => ({ ...state.bounds }),
    setBounds: vi.fn((bounds: typeof state.bounds) => void (state.bounds = { ...bounds })),
    // Electron emits `resize`/`move` for these, so the fake must too —
    // otherwise the reset path never exercises its own save listener.
    setSize: vi.fn((width: number, height: number) => {
      state.bounds = { ...state.bounds, width, height };
      window.emit("resize");
    }),
    center: vi.fn(() => {
      state.bounds = { ...state.bounds, x: 100, y: 50 };
      window.emit("move");
    }),
    setAlwaysOnTop: vi.fn((flag: boolean) => void (state.alwaysOnTop = flag)),
    show: vi.fn(() => void (state.visible = true)),
    focus: vi.fn(),
    restore: vi.fn(() => void (state.minimized = false)),
    on: (event: string, cb: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return window;
    },
    once: vi.fn(),
    removeListener: (event: string, cb: () => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== cb));
      return window;
    },
    emit: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    webContents: {
      send: (channel: string, payload: unknown) => void window.sent.push([channel, payload]),
    },
  };
  return window;
}

function fakeOverlay() {
  const panelListeners = new Set<(event: OverlayPanelEvent) => void>();
  return {
    show: vi.fn(async () => undefined),
    update: vi.fn(),
    hide: vi.fn(),
    hideAll: vi.fn(),
    toggle: vi.fn(async () => undefined),
    isVisible: vi.fn(() => false),
    setFocus: vi.fn(),
    state: vi.fn(() => ({
      windowVisible: true,
      visiblePanels: ["notice", "trade"],
      pinnedPanels: ["trade"],
      pointerOverPanel: false,
      poeDetected: true,
    })),
    onPanelEvent: (cb: (event: OverlayPanelEvent) => void) => {
      panelListeners.add(cb);
      return () => panelListeners.delete(cb);
    },
    onStateChange: () => () => undefined,
    emitPanel: (event: OverlayPanelEvent) => {
      for (const cb of panelListeners) cb(event);
    },
    listenerCount: () => panelListeners.size,
  };
}

function fakeHotkeys() {
  const actions = new Map<string, HotkeyAction>();
  const unContribute = vi.fn();
  return {
    actions,
    unContribute,
    contribute: vi.fn((action: HotkeyAction) => {
      actions.set(action.id, action);
      return unContribute;
    }),
    list: vi.fn(() => [
      { id: "overlay.hide-all", label: "Hide all", group: "Overlay", defaultAccelerator: null, accelerator: null, registered: true },
      {
        id: "evaluate",
        label: "Evaluate",
        group: "Overlay",
        defaultAccelerator: "Alt+E",
        accelerator: "Alt+E",
        registered: false,
        error: "Alt+E could not be registered",
      },
    ]),
    rebind: vi.fn(),
    validate: vi.fn(),
    trigger: vi.fn(),
  };
}

interface HarnessOptions {
  window?: ReturnType<typeof fakeWindow> | undefined;
  buildMode?: "public-companion" | "authorized-qa" | "assistive-access";
  packaged?: boolean;
  execResult?: { stdout: string; stderr: string; code: number; killed?: boolean };
  withChat?: boolean;
  /** False builds the module WITHOUT the `relaunch` seam, exercising the default. */
  withRelaunch?: boolean;
}

const NORMAL_PROBE = '{"appElevated":false,"processes":[{"name":"PathOfExileSteam","pid":7,"access":"ok"}]}';
const ELEVATED_PROBE =
  '{"appElevated":false,"processes":[{"name":"PathOfExileSteam","pid":7,"access":"denied"}]}';

function harness(options: HarnessOptions = {}) {
  const { ipc, invoke } = fakeIpc();
  const memory = memoryFs();
  const settings = new SettingsStore({ file: "settings.json", fs: memory.fs });
  const timers = fakeTimers();
  const overlay = fakeOverlay();
  const hotkeys = fakeHotkeys();
  const clock = { at: new Date("2026-09-12T10:00:00.000Z") };
  const window = { current: options.window };
  const events: Array<[string, unknown]> = [];
  /** Mutable so a test can drive the absent → present edge. */
  const poe = { running: true };

  const clientLog = {
    status: vi.fn(() => ({
      file: "C:/poe/logs/Client.txt",
      source: "steam",
      watching: true,
    })),
  };
  const chatCommands = { status: vi.fn(() => ({ enabled: true, dryRun: true })) };

  const priceFeed = {
    status: vi.fn(() => ({
      config: { league: "auto", autoRefreshDaily: true, poesessid: "" },
      resolvedLeague: "Runes of Aldur",
      leagueCandidates: [{ value: "Runes of Aldur" }],
      leagueAmbiguous: false,
      feedEntryCount: 412,
      feedAgeHours: 3,
      refreshing: false,
      tradeBudget: { lookups: 9 },
    })),
    hasSession: vi.fn(() => false),
  };

  const exec = vi.fn(async () => options.execResult ?? { stdout: NORMAL_PROBE, stderr: "", code: 0 });
  const relaunch = vi.fn<(command: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({
    ok: true,
  }));
  const quit = vi.fn();
  const openPath = vi.fn(async () => "");
  const changelog = new Map<string, string>();
  const fs = { readText: vi.fn((file: string) => changelog.get(file)) };

  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    appPath: "C:/repo",
    buildMode: options.buildMode ?? "authorized-qa",
    core: { priceFeed } as never,
    settings,
    mainWindow: () => window.current as never,
    poeWindows: async () =>
      poe.running ? [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }] : [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    openPath,
    log: vi.fn(),
  });

  // Capture emitted events without a window registered.
  const realEmit = rt.ctx.emit.bind(rt.ctx);
  (rt.ctx as { emit: (channel: string, payload: unknown) => void }).emit = (channel, payload) => {
    events.push([channel, payload]);
    realEmit(channel, payload);
  };

  const foundations: FeatureModule = {
    id: "fake-foundations",
    register(ctx) {
      ctx.provide("overlay", overlay as never);
      ctx.provide("hotkeys", hotkeys as never);
      ctx.provide("clientLog", clientLog as never);
      if (options.withChat !== false) ctx.provide("chatCommands", chatCommands as never);
      ctx.settings.namespace("overlay", (raw) => ({
        ...DEFAULT_OVERLAY_SETTINGS,
        ...(typeof raw === "object" && raw !== null ? (raw as object) : {}),
      }));
    },
  };

  const module = createAppSettingsModule({
    exec,
    fs,
    electron: {
      app: { getVersion: () => "0.1.0", isPackaged: options.packaged ?? false, quit },
      screen: {
        getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      },
    },
    ...(options.withRelaunch === false ? {} : { relaunch }),
    processInfo: () => ({
      execPath: "C:/app/companion.exe",
      argv: ["C:/app/companion.exe", "."],
      versions: { electron: "34.0.0", node: "20.18.0", chrome: "130.0" },
      platform: "win32",
      arch: "x64",
    }),
    now: () => clock.at,
    timers: timers.api,
  });

  return {
    rt,
    invoke,
    settings,
    timers,
    overlay,
    hotkeys,
    clientLog,
    chatCommands,
    priceFeed,
    exec,
    relaunch,
    quit,
    openPath,
    changelog,
    events,
    clock,
    window,
    poe,
    async start(): Promise<void> {
      const result = await rt.register([foundations, module]);
      expect(result.failed).toEqual([]);
    },
  };
}

describe("appSettings module", () => {
  let app: ReturnType<typeof harness>;

  beforeEach(() => {
    app = harness({ window: fakeWindow() });
  });

  it("registers exactly its ten app:* channels", async () => {
    await app.start();
    const channels = (await app.invoke("app:feature-channels")) as string[];
    const mine = channels.filter((channel) => channel.startsWith("app:") && channel !== "app:dry-run" && channel !== "app:set-dry-run" && channel !== "app:feature-channels");
    expect(mine.sort()).toEqual([
      "app:changelog",
      "app:dismiss-checklist",
      "app:elevation",
      "app:info",
      "app:open-folder",
      "app:relaunch-elevated",
      "app:reset-settings",
      "app:reset-windows",
      "app:setup-checklist",
      "app:test-overlay",
    ]);
  });

  it("reports version, build mode and the paths the docs promise", async () => {
    await app.start();
    const info = (await app.invoke("app:info")) as AppInfo;
    expect(info).toMatchObject({
      version: "0.1.0",
      buildMode: "authorized-qa",
      packaged: false,
      electron: "34.0.0",
      userDataDir: "C:/user",
      configDir: "C:/cfg",
      appPath: "C:/repo",
      settingsFile: "settings.json",
    });
    expect(info.changelogFile).toBe(path.join("C:/repo", "CHANGELOG.md"));
    expect(info.hotkeysFile).toBe(path.join("C:/user", "overlay-hotkeys.json"));
  });

  it("reads the changelog and reports a missing file instead of throwing", async () => {
    await app.start();
    expect(await app.invoke("app:changelog")).toMatchObject({ markdown: "", missing: true });
    app.changelog.set(path.join("C:/repo", "CHANGELOG.md"), "## [0.1.0]\n- hello\n");
    expect(await app.invoke("app:changelog")).toMatchObject({ missing: false, markdown: "## [0.1.0]\n- hello\n" });
  });

  it("composes the checklist from the foundations and never launches PowerShell", async () => {
    await app.start();
    const checklist = (await app.invoke("app:setup-checklist")) as SetupChecklist;
    expect(app.exec).not.toHaveBeenCalled();
    expect(checklist.required).toBe(5);
    const byId = Object.fromEntries(checklist.steps.map((step) => [step.id, step]));
    expect(byId["client-log"]?.state).toBe("ok");
    expect(byId.league?.detail).toBe("Runes of Aldur");
    expect(byId.hotkeys?.state).toBe("warn");
    expect(byId["admin-rights"]?.state).toBe("unknown");
    expect(byId["chat-commands"]?.detail).toContain("dry-run on");
  });

  it("dismisses and un-dismisses the checklist, announcing each change", async () => {
    await app.start();
    const dismissed = (await app.invoke("app:dismiss-checklist", true)) as SetupChecklist;
    expect(dismissed.dismissedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(app.events.some(([channel]) => channel === "app:checklist-changed")).toBe(true);
    const restored = (await app.invoke("app:dismiss-checklist", false)) as SetupChecklist;
    expect(restored.dismissedAt).toBeUndefined();
  });

  it("memoises the elevation probe and emits only when the verdict changes", async () => {
    await app.start();
    const first = (await app.invoke("app:elevation")) as ElevationReport;
    await app.invoke("app:elevation");
    expect(app.exec).toHaveBeenCalledTimes(1);
    expect(first.poeElevated).toBe("no");
    expect(app.events.filter(([channel]) => channel === "app:elevation-changed")).toHaveLength(1);

    app.exec.mockResolvedValueOnce({ stdout: ELEVATED_PROBE, stderr: "", code: 0 });
    const forced = (await app.invoke("app:elevation", true)) as ElevationReport;
    expect(app.exec).toHaveBeenCalledTimes(2);
    expect(forced.poeElevated).toBe("likely");
    expect(forced.hint).toContain("UIPI");
    expect(app.events.filter(([channel]) => channel === "app:elevation-changed")).toHaveLength(2);
  });

  it("runs the probe through powershell with no interpolation", async () => {
    await app.start();
    await app.invoke("app:elevation");
    const [file, args] = app.exec.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).not.toContain("${");
  });

  it("never probes on its own — nothing but app:elevation launches PowerShell", async () => {
    await app.start();
    await app.invoke("app:setup-checklist");
    await app.invoke("app:info");
    await app.invoke("app:reset-windows");
    await app.timers.advance(60_000);
    expect(app.exec).not.toHaveBeenCalled();
  });

  it("refuses the elevation probe in the public build without launching PowerShell", async () => {
    const publicApp = harness({ window: fakeWindow(), buildMode: "public-companion" });
    await publicApp.start();
    await expect(publicApp.invoke("app:elevation")).rejects.toThrow(/not available in this build/);
    expect(publicApp.exec).not.toHaveBeenCalled();
  });

  it("re-probes on force even while a probe is still in flight", async () => {
    await app.start();
    let release: ((value: { stdout: string; stderr: string; code: number }) => void) | undefined;
    app.exec.mockImplementationOnce(
      async () =>
        new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          release = resolve;
        }),
    );
    const slow = app.invoke("app:elevation");
    const forced = app.invoke("app:elevation", true) as Promise<ElevationReport>;
    release?.({ stdout: NORMAL_PROBE, stderr: "", code: 0 });
    await slow;
    expect(await forced).toBeDefined();
    expect(app.exec).toHaveBeenCalledTimes(2);
  });

  it("reports a failed probe as unknown rather than a confident verdict", async () => {
    const failing = harness({
      window: fakeWindow(),
      execResult: { stdout: "", stderr: "Get-Process is not recognized", code: 1 },
    });
    await failing.start();
    const report = (await failing.invoke("app:elevation")) as ElevationReport;
    expect(report.poeElevated).toBe("unknown");
    expect(report.appElevated).toBe("unknown");
    expect(report.error).toContain("not recognized");
  });

  it("stamps the overlay test only for the notice it asked for", async () => {
    await app.start();
    await app.invoke("app:test-overlay");
    const [panelId, options] = app.overlay.show.mock.calls[0] as unknown as [string, { anchor: string; payload: { title: string } }];
    expect(panelId).toBe("notice");
    expect(options.anchor).toBe("top-right");
    expect(options.payload.title).toBe("Overlay test");

    app.overlay.emitPanel({ panelId: "notice", kind: "shown" });
    expect(app.settings.snapshot().app).toMatchObject({
      setup: { overlayTestedAt: "2026-09-12T10:00:00.000Z" },
    });
  });

  it("ignores a notice shown outside the test window", async () => {
    await app.start();
    app.overlay.emitPanel({ panelId: "notice", kind: "shown" });
    expect((app.settings.snapshot().app as { setup: { overlayTestedAt?: string } }).setup.overlayTestedAt)
      .toBeUndefined();

    await app.invoke("app:test-overlay");
    app.clock.at = new Date("2026-09-12T10:00:30.000Z");
    app.overlay.emitPanel({ panelId: "notice", kind: "shown" });
    expect((app.settings.snapshot().app as { setup: { overlayTestedAt?: string } }).setup.overlayTestedAt)
      .toBeUndefined();
  });

  it("resets the windows, hiding pinned overlay panels too", async () => {
    await app.start();
    const result = (await app.invoke("app:reset-windows")) as { mainWindow: unknown; overlayPanelsHidden: number };
    expect(app.overlay.hideAll).toHaveBeenCalledTimes(1);
    expect(app.overlay.hideAll.mock.calls[0]).toEqual([true]);
    expect(result.overlayPanelsHidden).toBe(2);
    const window = app.window.current!;
    expect(window.setSize).toHaveBeenCalledWith(1120, 860);
    expect(window.center).toHaveBeenCalled();
    expect((app.settings.snapshot().app as { window: { bounds?: unknown } }).window.bounds).toBeUndefined();

    // The move/resize the reset itself caused must NOT write the centred
    // rectangle back — "forget where the window was" has to actually forget.
    await app.timers.advance(2_000);
    expect((app.settings.snapshot().app as { window: { bounds?: unknown } }).window.bounds).toBeUndefined();

    // …and a real move afterwards is saved again.
    window.state.bounds = { x: 12, y: 34, width: 900, height: 700 };
    window.emit("move");
    await app.timers.advance(400);
    expect((app.settings.snapshot().app as { window: { bounds?: unknown } }).window.bounds).toEqual({
      x: 12,
      y: 34,
      width: 900,
      height: 700,
    });
  });

  it("opens only the two folders it knows", async () => {
    await app.start();
    expect(await app.invoke("app:open-folder", "userData")).toEqual({ ok: true });
    expect(app.openPath).toHaveBeenLastCalledWith("C:/user");
    await app.invoke("app:open-folder", "configDir");
    expect(app.openPath).toHaveBeenLastCalledWith("C:/cfg");
    await app.invoke("app:open-folder", "settingsFile");
    expect(app.openPath).toHaveBeenLastCalledWith("C:/user");
    expect(await app.invoke("app:open-folder", "C:/Windows")).toEqual({ ok: false, error: "unknown-folder" });
    expect(app.openPath).toHaveBeenCalledTimes(3);

    app.openPath.mockResolvedValueOnce("boom");
    expect(await app.invoke("app:open-folder", "userData")).toEqual({ ok: false, error: "boom" });
  });

  it("resets app and overlay settings and refuses every other namespace", async () => {
    await app.start();
    const overlayChanged = vi.fn();
    app.settings.namespace("overlay", (raw) => ({ ...DEFAULT_OVERLAY_SETTINGS, ...(raw as object) })).onChange(overlayChanged);
    await app.invoke("settings:set", "overlay", { scale: 1.5 });
    await app.invoke("settings:set", "app", { window: { alwaysOnTop: false } });

    await app.invoke("app:reset-settings", ["app", "overlay"]);
    expect((app.settings.snapshot().overlay as { scale: number }).scale).toBe(1);
    expect((app.settings.snapshot().app as { window: { alwaysOnTop: boolean } }).window.alwaysOnTop).toBe(true);
    expect(overlayChanged).toHaveBeenCalled();

    await expect(app.invoke("app:reset-settings", ["trade"])).rejects.toThrow(/unknown or protected/);
  });

  it("resets nothing at all when the list holds a namespace it refuses", async () => {
    await app.start();
    await app.invoke("settings:set", "app", {
      window: { rememberBounds: false, alwaysOnTop: false, showOnGameStart: true },
      changelog: { lastSeenVersion: "9.9.9" },
    });
    const before = JSON.parse(JSON.stringify(app.settings.snapshot().app)) as unknown;

    await expect(app.invoke("app:reset-settings", ["app", "trade"])).rejects.toThrow(
      /unknown or protected/,
    );
    expect(app.settings.snapshot().app).toEqual(before);
  });

  it("contributes one Desktop hotkey that only fronts our own window", async () => {
    await app.start();
    const action = app.hotkeys.actions.get("app.show-window");
    expect(action).toBeDefined();
    expect(action?.group).toBe("Desktop");
    expect(action?.defaultAccelerator).toBeNull();

    const window = app.window.current!;
    window.state.minimized = true;
    await action?.run();
    expect(window.restore).toHaveBeenCalled();
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });

  it("disposes cleanly", async () => {
    await app.start();
    const window = app.window.current!;
    await app.rt.dispose();
    expect(app.hotkeys.unContribute).toHaveBeenCalled();
    expect(app.overlay.listenerCount()).toBe(0);
    expect(window.listenerCount("move")).toBe(0);
    expect(app.timers.pending()).toBe(0);
  });
});

describe("appSettings elevated relaunch", () => {
  it("refuses in the public build without touching PowerShell", async () => {
    const app = harness({ window: fakeWindow(), buildMode: "public-companion" });
    await app.start();
    expect(await app.invoke("app:relaunch-elevated")).toEqual({ ok: false, error: "public-companion" });
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.exec).not.toHaveBeenCalled();
  });

  it("refuses when the companion already runs elevated", async () => {
    const app = harness({
      window: fakeWindow(),
      execResult: { stdout: '{"appElevated":true,"processes":[]}', stderr: "", code: 0 },
    });
    await app.start();
    await app.invoke("app:elevation");
    expect(await app.invoke("app:relaunch-elevated")).toEqual({ ok: false, error: "already-elevated" });
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("keeps the build mode, raises UAC and quits", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    expect(await app.invoke("app:relaunch-elevated")).toEqual({ ok: true });
    const command = app.relaunch.mock.calls[0]?.[0] as unknown as string;
    expect(command).toContain("$env:POE2_BUILD_MODE = 'authorized-qa'");
    expect(command).toContain("-Verb RunAs");
    expect(command).toContain("'C:/app/companion.exe'");
    expect(command).not.toContain("${");
    await app.timers.advance(300);
    expect(app.quit).toHaveBeenCalled();
  });

  it("gives the dev path an absolute app path and a working directory, never a bare '.'", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    await app.invoke("app:relaunch-elevated");
    const command = app.relaunch.mock.calls[0]?.[0] as unknown as string;
    expect(command).toContain("-ArgumentList @('C:/repo')");
    expect(command).toContain("-WorkingDirectory 'C:/repo'");
    expect(command).not.toContain("@('.')");
  });

  it("passes no arguments and no working directory from a packaged build", async () => {
    const app = harness({ window: fakeWindow(), packaged: true });
    await app.start();
    await app.invoke("app:relaunch-elevated");
    const command = app.relaunch.mock.calls[0]?.[0] as unknown as string;
    expect(command).not.toContain("-ArgumentList");
    // `ctx.appPath` points inside app.asar there — Start-Process cannot chdir into it.
    expect(command).not.toContain("-WorkingDirectory");
  });

  it("runs the default relaunch through powershell.exe with a UAC-sized timeout", async () => {
    const app = harness({ window: fakeWindow(), withRelaunch: false });
    await app.start();
    expect(await app.invoke("app:relaunch-elevated")).toEqual({ ok: true });
    const [file, args, opts] = app.exec.mock.calls.at(-1) as unknown as [
      string,
      string[],
      { timeoutMs?: number } | undefined,
    ];
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toContain("-Verb RunAs");
    expect(args[3]).not.toContain("${");
    // Long enough that reading the UAC dialog is not a failure.
    expect(opts?.timeoutMs).toBeGreaterThanOrEqual(300_000);
    await app.timers.advance(300);
    expect(app.quit).toHaveBeenCalled();
  });

  it("reports a cancelled UAC prompt from the default path without quitting", async () => {
    const app = harness({
      window: fakeWindow(),
      withRelaunch: false,
      execResult: { stdout: "", stderr: "canceled", code: 1 },
    });
    await app.start();
    expect(await app.invoke("app:relaunch-elevated")).toEqual({ ok: false, error: "canceled" });
    await app.timers.advance(1_000);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("says the prompt went unanswered instead of blaming a PowerShell exit code", async () => {
    const app = harness({
      window: fakeWindow(),
      withRelaunch: false,
      execResult: { stdout: "", stderr: "", code: 1, killed: true },
    });
    await app.start();
    expect(await app.invoke("app:relaunch-elevated")).toEqual({
      ok: false,
      error: "the Windows prompt was not answered",
    });
    await app.timers.advance(1_000);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("stays running when the user cancels the UAC prompt", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    app.relaunch.mockResolvedValueOnce({ ok: false, error: "The operation was canceled by the user." });
    const result = (await app.invoke("app:relaunch-elevated")) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    await app.timers.advance(1_000);
    expect(app.quit).not.toHaveBeenCalled();
  });
});

describe("appSettings window tracker", () => {
  it("attaches once the window appears and restores usable bounds", async () => {
    const app = harness();
    const window = fakeWindow();
    await app.start();
    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: false, bounds: { x: 300, y: 120, width: 900, height: 700 } },
    });
    expect(window.setBounds).not.toHaveBeenCalled();

    app.window.current = window;
    await app.timers.advance(500);
    expect(window.setBounds).toHaveBeenCalledWith({ x: 300, y: 120, width: 900, height: 700 });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);
  });

  it("ignores bounds that no longer land on a display", async () => {
    const app = harness();
    const window = fakeWindow();
    await app.start();
    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: false, bounds: { x: 5000, y: 4000, width: 900, height: 700 } },
    });
    app.window.current = window;
    await app.timers.advance(500);
    expect(window.setBounds).not.toHaveBeenCalled();
  });

  it("saves a move once, after the debounce", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    const window = app.window.current!;
    window.state.bounds = { x: 40, y: 60, width: 1000, height: 800 };
    window.emit("move");
    window.emit("resize");
    expect((app.settings.snapshot().app as { window: { bounds?: unknown } }).window.bounds).toBeUndefined();
    await app.timers.advance(400);
    expect((app.settings.snapshot().app as { window: { bounds?: unknown } }).window.bounds).toEqual({
      x: 40,
      y: 60,
      width: 1000,
      height: 800,
    });
  });

  it("polls for the game every 20 s and shows the window once on the absent→present edge", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    app.poe.running = false;
    expect(app.timers.intervals()).toEqual([]);

    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: true },
    });
    expect(app.timers.intervals()).toEqual([20_000]);

    const window = app.window.current!;
    window.state.visible = false;
    // First tick only records that the game was absent.
    await app.timers.advance(20_000);
    expect(window.show).not.toHaveBeenCalled();

    app.poe.running = true;
    await app.timers.advance(20_000);
    expect(window.show).toHaveBeenCalledTimes(1);

    window.state.visible = false;
    await app.timers.advance(20_000);
    expect(window.show).toHaveBeenCalledTimes(1);

    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: false },
    });
    expect(app.timers.intervals()).toEqual([]);
  });

  it("does not pop up when the option is enabled while the game already runs", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    // The realistic case: playing already, minimise the companion, tick the box.
    app.poe.running = true;
    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: true },
    });
    const window = app.window.current!;
    window.state.minimized = true;
    window.state.visible = false;

    await app.timers.advance(20_000);
    await app.timers.advance(20_000);
    await app.timers.advance(20_000);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();

    // A genuine restart of the game still counts.
    app.poe.running = false;
    await app.timers.advance(20_000);
    app.poe.running = true;
    await app.timers.advance(20_000);
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it("leaves a visible window alone", async () => {
    const app = harness({ window: fakeWindow() });
    await app.start();
    await app.invoke("settings:set", "app", {
      window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: true },
    });
    const window = app.window.current!;
    await app.timers.advance(20_000);
    expect(window.show).not.toHaveBeenCalled();
  });
});

describe("appSettings without the chat-commands foundation", () => {
  it("marks the chat step unknown instead of failing", async () => {
    const app = harness({ window: fakeWindow(), withChat: false });
    await app.start();
    const checklist = (await app.invoke("app:setup-checklist")) as SetupChecklist;
    const step = checklist.steps.find((entry) => entry.id === "chat-commands");
    expect(step?.state).toBe("unknown");
  });
});
