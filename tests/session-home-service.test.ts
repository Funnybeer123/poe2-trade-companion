import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent } from "../src/core/clientLog.js";
import type { TrendReport } from "../src/core/priceTrends.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createSessionModule } from "../src/main/features/session/index.js";
import type { SessionFs, SessionTimers } from "../src/main/features/session/service.js";
import type { FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { ClientLogStatus } from "../src/shared/clientLog.js";
import type {
  DeathCapture,
  HomeOverview,
  SessionOverview,
  SessionRecapPayload,
  SessionSummary,
} from "../src/shared/session.js";

const ROOT = path.resolve(__dirname, "..");
const USER_DATA = "C:/user";
const CONFIG = "C:/cfg";
const CURRENT_FILE = path.join(USER_DATA, "session-current.json");
const HISTORY_FILE = path.join(USER_DATA, "session-history.jsonl");

const fixture = (name: string): string =>
  readFileSync(path.join(ROOT, "fixtures", "session", name), "utf8");

const TRENDS = JSON.parse(fixture("price-trends-result.json")) as {
  ok: boolean;
  league: string;
  fetchedAt: string;
  stale: boolean;
  trends: TrendReport[];
};

/** The fixture lines carry LOCAL wall-clock times, so the fake clock uses them too. */
const local = (hour: number, minute: number): number =>
  new Date(2026, 8, 11, hour, minute, 0).getTime();

function logEvents(name: string): ClientLogEvent[] {
  const out: ClientLogEvent[] = [];
  for (const line of fixture(name).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseClientLogLine(line, areaInfo);
    if (event) out.push(event);
  }
  return out;
}

/** Let the service's own awaited work settle (real timers, not the fake ones). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function memoryFs(seed: Record<string, string> = {}) {
  const text = new Map<string, string>(Object.entries(seed));
  const binary = new Map<string, Buffer>();
  let clock = 1;
  const fs: SessionFs = {
    exists: (file) => text.has(file) || binary.has(file),
    read: (file) => text.get(file),
    stat: (file) => {
      const value = text.get(file) ?? binary.get(file);
      return value === undefined ? undefined : { size: value.length, mtimeMs: clock };
    },
    write: (file, value) => {
      clock += 1;
      text.set(file, value);
    },
    append: (file, value) => {
      clock += 1;
      text.set(file, (text.get(file) ?? "") + value);
    },
    remove: (file) => {
      text.delete(file);
      binary.delete(file);
    },
    mkdir: () => undefined,
    list: () => [...text.keys(), ...binary.keys()],
    writeBinary: (file, bytes) => {
      clock += 1;
      binary.set(file, bytes);
    },
    readBinary: (file) => binary.get(file),
  };
  return { fs, text, binary };
}

function fakeTimers() {
  interface Entry {
    id: number;
    at: number;
    every?: number;
    callback: () => void;
  }
  let nextId = 1;
  let now = 0;
  const entries = new Map<number, Entry>();
  const timers: SessionTimers = {
    setTimeout: (callback, ms) => {
      const id = nextId++;
      entries.set(id, { id, at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void entries.delete(handle as number),
    setInterval: (callback, ms) => {
      const id = nextId++;
      entries.set(id, { id, at: now + ms, every: ms, callback });
      return id;
    },
    clearInterval: (handle) => void entries.delete(handle as number),
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    let guard = 0;
    for (;;) {
      const due = [...entries.values()]
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due || guard++ > 500) break;
      now = due.at;
      if (due.every) due.at = now + due.every;
      else entries.delete(due.id);
      due.callback();
    }
    now = target;
  };
  return { timers, advance };
}

function fakeClientLog(status: Partial<ClientLogStatus> = {}) {
  const listeners: Array<(event: ClientLogEvent) => void> = [];
  return {
    service: {
      status: (): ClientLogStatus => ({
        source: "steam",
        watching: true,
        file: "C:/poe/Client.txt",
        ...status,
      }),
      recent: () => [] as ClientLogEvent[],
      on: (_kind: string, callback: (event: ClientLogEvent) => void) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      reloadGameSettings: () => undefined,
    },
    feed: (events: ClientLogEvent[]) => {
      for (const event of events) for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.length,
  };
}

function fakeOverlay() {
  const visible = new Set<string>();
  const panelListeners: Array<(event: { panelId: string; kind: string }) => void> = [];
  return {
    show: vi.fn(async (panelId: string, _options?: unknown) => {
      visible.add(panelId);
    }),
    update: vi.fn(),
    hide: vi.fn((panelId: string) => void visible.delete(panelId)),
    isVisible: (panelId: string) => visible.has(panelId),
    state: () => ({
      windowVisible: true,
      visiblePanels: [...visible],
      pinnedPanels: [] as string[],
      pointerOverPanel: false,
      poeDetected: true,
      display: { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
    }),
    onPanelEvent: (callback: (event: { panelId: string; kind: string }) => void) => {
      panelListeners.push(callback);
      return () => undefined;
    },
    closeByUser: (panelId: string) => {
      visible.delete(panelId);
      for (const listener of panelListeners) listener({ panelId, kind: "closed-by-user" });
    },
  };
}

function fakeCapturer(outcome: "ok" | "black") {
  const calls = { count: 0 };
  return {
    calls,
    capturer: {
      busy: false,
      capture: vi.fn(async () => {
        calls.count += 1;
        if (outcome === "black") return { ok: false as const, reason: "black-frame" as const };
        return {
          ok: true as const,
          image: {} as never,
          thumb: {} as never,
          sourceName: "Path of Exile 2",
          width: 1920,
          height: 1080,
          jpeg: Buffer.from("full-frame"),
          thumbJpeg: Buffer.from("thumb"),
        };
      }),
    },
  };
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

interface HarnessOptions {
  files?: Record<string, string>;
  poeRunning?: boolean;
  settings?: Record<string, unknown>;
  capture?: "ok" | "black";
  withOverlay?: boolean;
  now?: number;
  status?: Partial<ClientLogStatus>;
}

async function harness(options: HarnessOptions = {}) {
  const { ipc, invoke, handlers } = fakeIpc();
  const memory = memoryFs(options.files ?? {});
  const settingsFiles = new Map<string, string>();
  if (options.settings) {
    settingsFiles.set(
      "settings.json",
      JSON.stringify({ version: 1, namespaces: { session: options.settings } }),
    );
  }
  const settings = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => settingsFiles.get(file),
      write: (file, text) => void settingsFiles.set(file, text),
    },
  });
  const clock = { value: options.now ?? local(21, 0) };
  const timers = fakeTimers();
  const clientLog = fakeClientLog(options.status);
  const overlay = options.withOverlay === false ? undefined : fakeOverlay();
  const hotkeyActions: Array<{ id: string; group: string; label: string }> = [];
  const hotkeys = {
    contribute: (action: { id: string; group: string; label: string }) => {
      hotkeyActions.push(action);
      return () => {
        const index = hotkeyActions.findIndex((entry) => entry.id === action.id);
        if (index >= 0) hotkeyActions.splice(index, 1);
      };
    },
    list: () =>
      hotkeyActions.map((action) => ({
        ...action,
        accelerator: null,
        registered: false,
        defaultAccelerator: null,
      })),
  };
  const capture = fakeCapturer(options.capture ?? "ok");
  const logs: Array<{ level?: string; message?: string }> = [];
  const notify = vi.fn();
  const emitted: Array<[string, unknown]> = [];
  const mainWindow = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => void emitted.push([channel, payload]),
    },
  };
  const poe = { running: options.poeRunning ?? true };

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: CONFIG,
    userDataDir: USER_DATA,
    repoRoot: ROOT,
    buildMode: "authorized-qa",
    core: {
      priceFeed: {
        status: () => ({
          config: { league: "Rise of the Abyssal" },
          resolvedLeague: "Rise of the Abyssal",
          leagueAmbiguous: false,
          feedEntryCount: 900,
          feedAgeHours: 2,
        }),
        hasSession: () => true,
      },
      marketTrends: { getTrends: async () => TRENDS },
    } as never,
    settings,
    mainWindow: () => mainWindow as never,
    poeWindows: async () =>
      poe.running ? [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }] : [],
    killSwitchLatched: () => false,
    notify,
    clipboard: { readText: () => "", writeText: () => undefined },
    openExternal: async () => undefined,
    openPath: async () => "",
    log: (entry) => void logs.push(entry as { level?: string; message?: string }),
  });

  // The session module looks the foundations up loosely; publish the fakes.
  const provider: FeatureModule = {
    id: "fixtures",
    register(ctx) {
      const provide = ctx.provide as unknown as (id: string, service: unknown) => void;
      provide("clientLog", clientLog.service);
      if (overlay) provide("overlay", overlay);
      provide("hotkeys", hotkeys);
    },
  };

  const sessionModule = createSessionModule({
    fs: memory.fs,
    now: () => new Date(clock.value),
    timers: timers.timers,
    capturer: capture.capturer as never,
  });

  const result = await runtime.register([provider, sessionModule]);

  return {
    runtime,
    result,
    invoke,
    handlers,
    memory,
    clock,
    timers,
    clientLog,
    overlay,
    hotkeyActions,
    capture,
    logs,
    notify,
    emitted,
    poe,
    settings,
    setClock: (value: number) => {
      clock.value = value;
    },
    /** One 15-second process poll. */
    tick: async () => {
      timers.advance(15_000);
      await settle();
    },
  };
}

function emittedOf(entries: Array<[string, unknown]>, channel: string): unknown[] {
  return entries.filter(([name]) => name === channel).map(([, payload]) => payload);
}

// ---------------------------------------------------------------------------

describe("session module — registration", () => {
  it("registers exactly the session channels and the two hotkeys", async () => {
    const app = await harness();
    const channels = [...app.handlers.keys()].filter((name) => name.startsWith("session:")).sort();
    expect(channels).toEqual([
      "session:capture-now",
      "session:death-delete",
      "session:death-open",
      "session:death-thumbnail",
      "session:deaths",
      "session:deaths-open-folder",
      "session:end",
      "session:history",
      "session:history-delete",
      "session:history-get",
      "session:home",
      "session:overview",
      "session:recap-show",
    ]);
    expect(app.hotkeyActions.map((action) => action.id)).toEqual(["session.recap", "session.capture"]);
    expect(app.hotkeyActions.every((action) => action.group === "Session")).toBe(true);
    await app.runtime.dispose();
    expect(app.hotkeyActions).toHaveLength(0);
    expect(app.clientLog.listenerCount()).toBe(0);
  });

  it("still registers without the overlay and reports the recap cannot be shown", async () => {
    const app = await harness({ withOverlay: false });
    expect(app.result.failed).toEqual([]);
    expect(await app.invoke("session:recap-show", "full")).toBe(false);
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.overlayAvailable).toBe(false);
    await app.runtime.dispose();
  });
});

describe("session module — live events", () => {
  it("folds the worked mapping log into the overview", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.active).toBe(true);
    expect(overview.session?.runs).toHaveLength(2);
    expect(overview.session?.runs[0].tier).toBe(15);
    expect(overview.session?.runs[0].portals).toBe(1);
    expect(overview.session?.runs[0].subAreas).toEqual(["BreachDomain_01"]);
    expect(overview.metrics?.deathsInMaps).toBe(1);
    await app.runtime.dispose();
  });

  it("shows the recap panel centred on AFK and hides it when AFK ends", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    await settle();
    const shows = app.overlay!.show.mock.calls.filter(([id]) => id === "session-recap");
    expect(shows).toHaveLength(1);
    const options = shows[0][1] as { anchor: string; focus: boolean; payload: SessionRecapPayload };
    expect(options.anchor).toBe("center");
    expect(options.focus).toBe(false);
    expect(options.payload.mode).toBe("afk");
    expect(options.payload.metrics.mapsCompleted).toBeGreaterThanOrEqual(1);
    expect(app.overlay!.hide).toHaveBeenCalledWith("session-recap");
    expect(emittedOf(app.emitted, "session:recap")).toHaveLength(1);
    await app.runtime.dispose();
  });

  it("never opens the recap when the AFK setting is off", async () => {
    const app = await harness({ settings: { afkRecap: false } });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    await settle();
    expect(app.overlay!.show).not.toHaveBeenCalled();
    await app.runtime.dispose();
  });

  it("keeps a dismissed panel closed until AFK actually ends", async () => {
    const app = await harness();
    // Everything up to (and including) the first "AFK mode is now ON." line.
    const events = logEvents("client-log-mapping.txt");
    const afkOn = events.filter((event) => event.kind === "afk" && event.on)[0];
    app.clientLog.feed(events.slice(0, events.indexOf(afkOn) + 1));
    await settle();
    expect(app.overlay!.show.mock.calls).toHaveLength(1);

    app.overlay!.closeByUser("session-recap");

    // The game re-emits AFK ON whenever the autoreply text changes; the panel
    // the user dismissed must stay closed.
    app.clientLog.feed([afkOn]);
    await settle();
    expect(app.overlay!.show.mock.calls).toHaveLength(1);

    // AFK off then on again is a new AFK: the panel comes back.
    const afkOff = events.find((event) => event.kind === "afk" && !event.on)!;
    app.clientLog.feed([afkOff, afkOn]);
    await settle();
    expect(app.overlay!.show.mock.calls).toHaveLength(2);
    await app.runtime.dispose();
  });

  it("logs instead of rejecting when the overlay cannot show the panel", async () => {
    const app = await harness();
    app.overlay!.show.mockRejectedValueOnce(new Error("Object has been destroyed"));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      app.clientLog.feed(logEvents("client-log-mapping.txt"));
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(app.logs.some((entry) => entry.level === "warn" && entry.message === "AFK recap failed")).toBe(
      true,
    );
    // The module keeps working: the session is still being folded.
    expect(((await app.invoke("session:overview")) as SessionOverview).active).toBe(true);
    await app.runtime.dispose();
  });
});

describe("session module — the session lifecycle", () => {
  it("ends the session once the process is gone and the log went quiet", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.setClock(local(22, 5));
    // One poll that sees the game: only then is a later absence evidence.
    await app.tick();
    app.poe.running = false;
    for (let poll = 0; poll < 3; poll += 1) await app.tick();
    expect(((await app.invoke("session:overview")) as SessionOverview).active).toBe(true);
    await app.tick();
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.active).toBe(false);
    expect(overview.lastRecap?.mode).toBe("full");
    expect(app.notify).toHaveBeenCalledTimes(1);
    expect(String(app.notify.mock.calls[0][1])).toMatch(/maps/);
    const history = (await app.invoke("session:history")) as SessionSummary[];
    expect(history).toHaveLength(1);
    expect(history[0].endReason).toBe("game-exit");
    expect(history[0].mapsCompleted).toBe(2);
    expect(app.memory.text.has(CURRENT_FILE)).toBe(false);
    expect(emittedOf(app.emitted, "session:recap").length).toBeGreaterThanOrEqual(1);
    await app.runtime.dispose();
  });

  it("does not notify when the notification is turned off", async () => {
    const app = await harness({ settings: { postGameNotification: false } });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.setClock(local(22, 5));
    await app.tick();
    app.poe.running = false;
    for (let poll = 0; poll < 4; poll += 1) await app.tick();
    expect(((await app.invoke("session:overview")) as SessionOverview).active).toBe(false);
    expect(app.notify).not.toHaveBeenCalled();
    await app.runtime.dispose();
  });

  /**
   * `ctx.poeWindows()` swallows every failure of its PowerShell probe and
   * returns an empty list, so a broken probe is indistinguishable from a closed
   * game. A session the probe never once confirmed must not be archived,
   * notified about and split in two while the player is still mapping.
   */
  it("does not end the session when the process probe never sees the game", async () => {
    const app = await harness({ poeRunning: false });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.setClock(local(22, 5));
    for (let poll = 0; poll < 8; poll += 1) await app.tick();
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.active).toBe(true);
    expect(app.notify).not.toHaveBeenCalled();
    expect(await app.invoke("session:history")).toEqual([]);
    await app.runtime.dispose();
  });

  it("resumes a fresh current-session file", async () => {
    const app = await harness({
      files: { [CURRENT_FILE]: fixture("session-current-resumable.json") },
      now: Date.parse("2026-09-11T21:35:00.000Z"),
    });
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.session?.id).toBe("ses-2026-09-11T21-00-00-000Z");
    expect(overview.session?.runs[0].endedAt).toBeUndefined();
    await app.runtime.dispose();
  });

  it("archives a stale current-session file instead of resuming it", async () => {
    const app = await harness({
      files: { [CURRENT_FILE]: fixture("session-current-resumable.json") },
      now: Date.parse("2026-09-12T09:00:00.000Z"),
    });
    const history = (await app.invoke("session:history")) as SessionSummary[];
    expect(history).toHaveLength(1);
    expect(history[0].endReason).toBe("app-quit");
    expect(app.memory.text.has(CURRENT_FILE)).toBe(false);
    await app.runtime.dispose();
  });

  it("ends and archives on dispose", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    await app.runtime.dispose();
    expect(app.memory.text.get(HISTORY_FILE) ?? "").toContain('"endReason":"app-quit"');
  });

  it("ends the session by hand", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    const overview = (await app.invoke("session:end")) as SessionOverview;
    expect(overview.active).toBe(false);
    const history = (await app.invoke("session:history")) as SessionSummary[];
    expect(history[0].endReason).toBe("manual");
    const detail = (await app.invoke("session:history-get", history[0].id)) as { summary: SessionSummary };
    expect(detail.summary.id).toBe(history[0].id);
    const left = (await app.invoke("session:history-delete", history[0].id)) as SessionSummary[];
    expect(left).toHaveLength(0);
    await app.runtime.dispose();
  });

  it("snapshots the current session on the periodic tick", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-campaign.txt"));
    app.memory.text.delete(CURRENT_FILE);
    app.setClock(local(21, 5));
    await app.tick();
    expect(app.memory.text.has(CURRENT_FILE)).toBe(true);
    await app.runtime.dispose();
  });

  it("starts a session from the process alone when the log is silent", async () => {
    const app = await harness();
    await app.tick();
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    expect(overview.active).toBe(true);
    expect(overview.poeDetected).toBe(true);
    await app.runtime.dispose();
  });
});

describe("session module — death screenshots", () => {
  it("captures after the delay, writes the files and prunes the oldest", async () => {
    const app = await harness({ settings: { maxDeathScreenshots: 1 } });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    expect(app.capture.calls.count).toBe(0);
    app.timers.advance(900);
    await settle();
    expect(app.capture.calls.count).toBe(1);

    const captures = (await app.invoke("session:deaths")) as DeathCapture[];
    expect(captures).toHaveLength(1);
    expect(captures[0].areaId).toBe("MapSunTemple");
    expect(captures[0].file).toContain("MapSunTemple");
    expect(app.memory.binary.size).toBe(2);

    // A manual capture taken later than the death wins the prune.
    app.setClock(local(22, 30));
    const manual = (await app.invoke("session:capture-now")) as DeathCapture;
    expect(manual.kind).toBe("manual");
    const after = (await app.invoke("session:deaths")) as DeathCapture[];
    expect(after).toHaveLength(1);
    expect(after[0].kind).toBe("manual");
    expect(app.memory.binary.size).toBe(2);
    expect(emittedOf(app.emitted, "session:death")).toHaveLength(2);
    await app.runtime.dispose();
  });

  it("skips a black frame without writing anything", async () => {
    const app = await harness({ capture: "black" });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.timers.advance(900);
    await settle();
    expect(app.capture.calls.count).toBe(1);
    expect(app.memory.binary.size).toBe(0);
    const result = (await app.invoke("session:capture-now")) as { skipped: string };
    expect(result.skipped).toBe("black-frame");
    await app.runtime.dispose();
  });

  it("writes nothing when the module is disposed while a capture is in flight", async () => {
    const app = await harness();
    let release = (): void => undefined;
    app.capture.capturer.capture.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true as const,
              image: {} as never,
              thumb: {} as never,
              sourceName: "Path of Exile 2",
              width: 1920,
              height: 1080,
              jpeg: Buffer.from("full-frame"),
              thumbJpeg: Buffer.from("thumb"),
            });
        }),
    );
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.timers.advance(900);
    await settle();
    await app.runtime.dispose();
    release();
    await settle();
    // The shot resolved after teardown: no JPEG pair, no index rewrite.
    expect(app.memory.binary.size).toBe(0);
    expect(emittedOf(app.emitted, "session:death")).toHaveLength(0);
  });

  it("never captures on a death when the setting is off", async () => {
    const app = await harness({ settings: { deathScreenshots: false } });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.timers.advance(5_000);
    await settle();
    expect(app.capture.calls.count).toBe(0);
    await app.runtime.dispose();
  });

  it("serves a thumbnail, opens the file and deletes on request", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.timers.advance(900);
    await settle();
    const captures = (await app.invoke("session:deaths")) as DeathCapture[];
    const thumb = (await app.invoke("session:death-thumbnail", captures[0].id)) as string;
    expect(thumb.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(await app.invoke("session:death-open", captures[0].id)).toBe(true);
    expect(await app.invoke("session:death-open", "nope")).toBe(false);
    expect(await app.invoke("session:deaths-open-folder")).toBe(true);
    const left = (await app.invoke("session:death-delete", captures[0].id)) as DeathCapture[];
    expect(left).toHaveLength(0);
    expect(app.memory.binary.size).toBe(0);
    await app.runtime.dispose();
  });
});

describe("session module — Home", () => {
  it("composes stash, trade, market and recommendations", async () => {
    const app = await harness({
      files: {
        [path.join(USER_DATA, "stash-tracker", "summary.json")]: fixture("stash-tracker-summary.json"),
        [path.join(USER_DATA, "stash-tracker", "snapshots.jsonl")]: fixture("stash-snapshots.jsonl"),
        [path.join(USER_DATA, "trade-history.json")]: fixture("trade-history.json"),
      },
    });
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    const home = (await app.invoke("session:home")) as HomeOverview;
    expect(home.clientLog.watching).toBe(true);
    expect(home.stash.available).toBe(true);
    expect(home.stash.deltaExalted).toBe(810);
    expect(home.trade.available).toBe(true);
    // The exact sums are pinned in the sessionHome unit test; here the file
    // just has to be found and parsed.
    expect(home.trade.sales).toBeGreaterThanOrEqual(0);
    expect(home.market.available).toBe(true);
    expect(home.recentMaps.length).toBeGreaterThan(0);
    expect(home.xpPerHour).toEqual({ available: false, reason: "needs account link (not available)" });
    expect(home.goldPerMap.available).toBe(false);
    expect(home.timeToLevel.available).toBe(false);
    expect(home.recommendations.length).toBeGreaterThan(0);
    expect(home.recommendations.length).toBeLessThanOrEqual(5);
    expect(home.session.files.deathsDir).toContain("deaths");
    await app.runtime.dispose();
  });

  it("is honest when the other packages have written nothing", async () => {
    const app = await harness();
    const home = (await app.invoke("session:home")) as HomeOverview;
    expect(home.stash.available).toBe(false);
    expect(home.trade.available).toBe(false);
    expect(home.recommendations.some((entry) => entry.id === "stash-files")).toBe(true);
    await app.runtime.dispose();
  });

  it("shows the campaign hint from the campaign log", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-campaign.txt"));
    const home = (await app.invoke("session:home")) as HomeOverview;
    expect(home.character?.name).toBe("Himbo");
    expect(home.campaign?.act).toBe(2);
    expect(home.campaign?.tone).toBeDefined();
    expect(home.campaign?.hint ?? "").not.toMatch(/%|XP/i);
    await app.runtime.dispose();
  });
});

describe("session module — events and settings", () => {
  it("coalesces session:changed instead of emitting per log line", async () => {
    const app = await harness();
    const events = logEvents("client-log-mapping.txt");
    app.clientLog.feed(events);
    const emits = emittedOf(app.emitted, "session:changed").length;
    expect(emits).toBeGreaterThan(0);
    expect(emits).toBeLessThan(events.length);
    await app.runtime.dispose();
  });

  it("applies a settings change live", async () => {
    const app = await harness();
    app.clientLog.feed(logEvents("client-log-campaign.txt"));
    app.settings.setRaw("session", { characterOverride: { name: "Manual", level: 3 } });
    const overview = (await app.invoke("session:overview")) as SessionOverview;
    // A real level-up still wins over the override.
    expect(overview.character?.name).toBe("Himbo");
    expect(overview.session?.characters.some((entry) => entry.source === "override")).toBe(true);
    await app.runtime.dispose();
  });

  it("clamps a nonsense limit instead of failing", async () => {
    const app = await harness();
    // Seed one archived session and one screenshot, so an unclamped limit
    // would be observable instead of hidden by an empty store.
    app.clientLog.feed(logEvents("client-log-mapping.txt"));
    app.timers.advance(900);
    await settle();
    await app.invoke("session:end");

    expect((await app.invoke("session:history", "lots")) as SessionSummary[]).toHaveLength(1);
    expect((await app.invoke("session:history", 1)) as SessionSummary[]).toHaveLength(1);
    // -5 clamps to 1, it does not slice(0, -5) into an empty list.
    expect((await app.invoke("session:deaths", -5)) as DeathCapture[]).toHaveLength(1);
    expect((await app.invoke("session:deaths", Number.NaN)) as DeathCapture[]).toHaveLength(1);
    expect(await app.invoke("session:history-get", "")).toBeUndefined();
    expect(await app.invoke("session:history-delete", "")).toHaveLength(1);
    await app.runtime.dispose();
  });
});

describe("session module — a long history", () => {
  /** One minimal but valid archived session line. */
  const record = (index: number): string => {
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 3_600_000).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + 1_800_000).toISOString();
    return JSON.stringify({
      version: 1,
      savedAt: endedAt,
      state: {
        id: `ses-${index}`,
        startedAt,
        endedAt,
        endReason: "app-quit",
        characters: [{ name: "Himbo", className: "Disciple of Varashta", level: 80, seenAt: startedAt, source: "level-up" }],
        areas: [],
        areasDropped: 0,
        runs: [],
        runsDropped: 0,
        deaths: [],
        deathsDropped: 0,
        levelUps: [],
        afk: [],
        trades: { accepted: 0, cancelled: 0 },
        whispers: { in: 0, out: 0 },
        eventCount: 10,
        lastEventAt: endedAt,
      },
    });
  };

  it("lists every summary but reads an old record back off disk on demand", async () => {
    const lines = Array.from({ length: 200 }, (_unused, index) => record(index));
    const app = await harness({ files: { [HISTORY_FILE]: `${lines.join("\n")}\n` } });

    const all = (await app.invoke("session:history", 500)) as SessionSummary[];
    expect(all).toHaveLength(200);
    expect(all[0].id).toBe("ses-199");

    // The oldest record is far outside the resident window, so this proves the
    // lazy read path rather than an in-memory hit.
    const oldest = (await app.invoke("session:history-get", "ses-0")) as { summary: SessionSummary };
    expect(oldest.summary.id).toBe("ses-0");
    const newest = (await app.invoke("session:history-get", "ses-199")) as { summary: SessionSummary };
    expect(newest.summary.id).toBe("ses-199");
    expect(await app.invoke("session:history-get", "ses-nope")).toBeUndefined();

    // The delete answer is the default 50-row page; the store itself is 199.
    expect((await app.invoke("session:history-delete", "ses-0")) as SessionSummary[]).toHaveLength(50);
    expect((await app.invoke("session:history", 500)) as SessionSummary[]).toHaveLength(199);
    expect(await app.invoke("session:history-get", "ses-0")).toBeUndefined();
    await app.runtime.dispose();
  });
});
