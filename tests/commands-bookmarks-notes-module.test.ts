import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { resolvePlaceholders } from "../src/core/chatCommands.js";
import { parseClientLogLine } from "../src/core/clientLog.js";
import { toDataUri } from "../src/core/commandsBookmarksNotes.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createCommandsBookmarksNotesModule } from "../src/main/features/commandsBookmarksNotes/index.js";
import type { NoteImageFs } from "../src/main/features/commandsBookmarksNotes/noteImages.js";
import {
  createBookmarkWebWindow,
  type BookmarkWebWindow,
  type BookmarkWindowBounds,
  type BookmarkWindowLike,
} from "../src/main/features/commandsBookmarksNotes/webWindow.js";
import type { FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { ChatCommandOutcome } from "../src/shared/chatCommands.js";
import type { HotkeyBindingView } from "../src/shared/hotkeys.js";
import type { OverlayPanelEvent, OverlayShowOptions } from "../src/shared/overlay.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;
const TRADE_WHISPER =
  '@From Himbothlice: Hi, I would like to buy your Ghoul Lash, Long Belt listed for 1 exalted in Forbidden Rites (stash tab "~price 1 exalted"; position: left 10, top 10)';

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

interface HotkeyEntry {
  id: string;
  label: string;
  detail?: string;
  group: string;
  defaultAccelerator: string | null;
  run: () => void | Promise<void>;
}

function fakeHotkeys() {
  const entries = new Map<string, HotkeyEntry>();
  const contributed: string[] = [];
  const uncontributed: string[] = [];
  const service = {
    contribute(action: HotkeyEntry) {
      if (entries.has(action.id)) throw new Error(`hotkey action "${action.id}" is already contributed`);
      entries.set(action.id, { ...action, defaultAccelerator: action.defaultAccelerator ?? null });
      contributed.push(action.id);
      return () => {
        entries.delete(action.id);
        uncontributed.push(action.id);
      };
    },
    list(): HotkeyBindingView[] {
      return [...entries.values()].map((entry) => ({
        id: entry.id,
        label: entry.label,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        group: entry.group,
        defaultAccelerator: entry.defaultAccelerator,
        accelerator: entry.defaultAccelerator,
        registered: entry.defaultAccelerator !== null,
      }));
    },
    rebind: () => service.list(),
    validate: () => ({ ok: true }),
    trigger: async (id: string) => {
      const entry = entries.get(id);
      if (!entry) return false;
      await entry.run();
      return true;
    },
  };
  return { service, entries, contributed, uncontributed };
}

function fakeOverlay() {
  const shown: Array<{ panelId: string; options?: OverlayShowOptions }> = [];
  const updated: Array<{ panelId: string; payload: unknown }> = [];
  const hidden: string[] = [];
  const focusCalls: Array<{ panelId: string; focus: boolean }> = [];
  const visible = new Set<string>();
  let panelListener: ((event: OverlayPanelEvent) => void) | undefined;
  let showError: Error | undefined;
  const service = {
    show: async (panelId: string, options?: OverlayShowOptions) => {
      if (showError) throw showError;
      shown.push({ panelId, options });
      visible.add(panelId);
    },
    update: (panelId: string, payload: unknown) => {
      updated.push({ panelId, payload });
    },
    hide: (panelId: string) => {
      hidden.push(panelId);
      visible.delete(panelId);
    },
    hideAll: () => visible.clear(),
    toggle: async (panelId: string, options?: OverlayShowOptions) => {
      if (visible.has(panelId)) visible.delete(panelId);
      else await service.show(panelId, options);
    },
    isVisible: (panelId: string) => visible.has(panelId),
    setFocus: (panelId: string, focus: boolean) => {
      focusCalls.push({ panelId, focus });
    },
    state: () => ({
      windowVisible: visible.size > 0,
      visiblePanels: [...visible],
      pinnedPanels: [],
      pointerOverPanel: false,
      display: { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
      poeDetected: true,
    }),
    onPanelEvent: (callback: (event: OverlayPanelEvent) => void) => {
      panelListener = callback;
      return () => {
        panelListener = undefined;
      };
    },
    onStateChange: () => () => undefined,
  };
  return {
    service,
    shown,
    updated,
    hidden,
    focusCalls,
    visible,
    emit: (event: OverlayPanelEvent) => panelListener?.(event),
    /** The overlay window cannot be created (no display, app shutting down). */
    failShow: (error: Error | undefined) => {
      showError = error;
    },
  };
}

function fakeChat() {
  const sent: Array<Record<string, unknown>> = [];
  const searched: Array<{ text: string; reason: string; options?: { focus?: boolean } }> = [];
  const order: string[] = [];
  let outcome: ChatCommandOutcome = { ok: true, dryRun: false, at: "2026-09-14T00:00:00.000Z", sent: "" };
  let gate: Promise<void> | undefined;
  const service = {
    send: async (request: { text: string; reason: string; source: string; focus?: boolean }) => {
      if (gate) await gate;
      sent.push(request);
      order.push("send");
      return { ...outcome, sent: outcome.sent === "" ? request.text : outcome.sent };
    },
    stashSearch: async (text: string, reason: string, options?: { focus?: boolean }) => {
      searched.push({ text, reason, ...(options ? { options } : {}) });
      order.push("stashSearch");
      return { ...outcome, sent: outcome.sent === "" ? text : outcome.sent };
    },
    copyHoveredItem: async () => outcome,
    status: () => ({ enabled: true, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false }),
    resolvePlaceholders,
  };
  return {
    service,
    sent,
    searched,
    order,
    setOutcome: (next: ChatCommandOutcome) => {
      outcome = next;
    },
    /** Holds `send` open so a test can watch what the hotkey promise does. */
    hold: () => {
      let release = (): void => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}

function fakeClientLog(lines: string[] = [TRADE_WHISPER, "@From Bob: ty"]) {
  const prefix = "2026/09/11 20:52:15 40206281 2caa229f [INFO Client 23032] ";
  const events = lines.map((line) => parseClientLogLine(prefix + line, areaInfo)).filter(Boolean);
  return {
    status: () => ({ character: { name: "Xan", className: "Deadeye", level: 88, seenAt: "" } }),
    recent: () => events,
    on: () => () => undefined,
    setFile: () => ({ source: "none", watching: false }),
    replayTail: async () => 0,
    reloadGameSettings: () => undefined,
  };
}

function fakeWebWindow() {
  const calls: Array<{ kind: string; url?: string; bounds?: BookmarkWindowBounds }> = [];
  let open = false;
  let visible = false;
  let boundsListener: ((bounds: BookmarkWindowBounds) => void) | undefined;
  const window: BookmarkWebWindow = {
    open: async (url, _title, bounds) => {
      calls.push({ kind: "open", url, bounds });
      open = true;
      visible = true;
    },
    toggle: async (url, _title, bounds) => {
      calls.push({ kind: "toggle", url, bounds });
      open = true;
      visible = !visible;
      return visible;
    },
    close: () => {
      calls.push({ kind: "close" });
      const was = open;
      open = false;
      visible = false;
      return was;
    },
    isOpen: () => open,
    isVisible: () => visible,
    currentUrl: () => undefined,
    onBoundsChanged: (callback) => {
      boundsListener = callback;
      return () => {
        boundsListener = undefined;
      };
    },
  };
  return {
    window,
    calls,
    moveTo: (bounds: BookmarkWindowBounds) => boundsListener?.(bounds),
    /** The window the user hid with its own toggle hotkey: alive but off screen. */
    hide: () => {
      visible = false;
    },
  };
}

function memoryImageFs(seed: Record<string, Uint8Array> = {}): { fs: NoteImageFs; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const norm = (file: string): string => file.replace(/\\/g, "/");
  return {
    files,
    fs: {
      exists: (file) => files.has(norm(file)),
      read: (file) => files.get(norm(file)),
      write: (file, bytes) => {
        files.set(norm(file), bytes);
      },
      remove: (file) => {
        files.delete(norm(file));
      },
      list: (dir) =>
        [...files.keys()].filter((file) => file.startsWith(`${norm(dir)}/`)).map((file) => file.slice(norm(dir).length + 1)),
      mkdir: () => undefined,
    },
  };
}

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  channels: string[];
  events: Array<[string, unknown]>;
  hotkeys: ReturnType<typeof fakeHotkeys>;
  overlay: ReturnType<typeof fakeOverlay>;
  chat: ReturnType<typeof fakeChat>;
  web: ReturnType<typeof fakeWebWindow>;
  images: ReturnType<typeof memoryImageFs>;
  settings: SettingsStore;
  settingsFiles: Map<string, string>;
  dispose: () => Promise<void>;
  setClock: (ms: number) => void;
  openExternal: ReturnType<typeof vi.fn>;
}

async function harness(
  options: {
    document?: unknown;
    withClientLog?: boolean;
    imageSeed?: Record<string, Uint8Array>;
  } = {},
): Promise<Harness> {
  const { ipc, invoke, handlers } = fakeIpc();
  const files = new Map<string, string>();
  if (options.document !== undefined) {
    files.set("settings.json", JSON.stringify({ version: 1, namespaces: options.document }));
  }
  const settings = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => files.get(file),
      write: (file, text) => {
        files.set(file, text);
      },
    },
  });
  const hotkeys = fakeHotkeys();
  const overlay = fakeOverlay();
  const chat = fakeChat();
  const web = fakeWebWindow();
  const images = memoryImageFs(options.imageSeed);
  const events: Array<[string, unknown]> = [];
  const openExternal = vi.fn(async (_url: string) => undefined);
  let clock = 1_757_000_000_000;

  const window = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => {
        events.push([channel, payload]);
      },
    },
  };

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: { priceFeed: { status: () => ({ resolvedLeague: "Runes of Aldur" }) } } as never,
    settings,
    mainWindow: () => window as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: () => undefined },
    openExternal,
    log: vi.fn(),
  });

  const foundations: FeatureModule = {
    id: "fake-foundations",
    register(ctx) {
      ctx.provide("hotkeys", hotkeys.service as never);
      ctx.provide("overlay", overlay.service as never);
      ctx.provide("chatCommands", chat.service as never);
      if (options.withClientLog !== false) ctx.provide("clientLog", fakeClientLog() as never);
    },
  };

  const result = await runtime.register([
    foundations,
    createCommandsBookmarksNotesModule({ webWindow: () => web.window, imageFs: images.fs, now: () => clock }),
  ]);
  expect(result.failed).toEqual([]);

  return {
    invoke,
    channels: [...handlers.keys()],
    events,
    hotkeys,
    overlay,
    chat,
    web,
    images,
    settings,
    settingsFiles: files,
    dispose: () => runtime.dispose(),
    setClock: (ms: number) => {
      clock = ms;
    },
    openExternal,
  };
}

const CMD = { id: "cmd_a1b2c3_0001", label: "Invite", template: "/invite {player}", enabled: true };
const SEARCH = { id: "srch_a1b2c3_0001", label: "T15+", text: '"tier: 1[5-6]"', enabled: true };
const NOTE = { id: "note_a1b2c3_0001", title: "Ritual", icon: "🩸", markdown: "# Ritual", enabled: true };

type CommandsView = Awaited<ReturnType<typeof harness>> extends never ? never : any;

afterEach(() => {
  vi.useRealTimers();
});

describe("module registration", () => {
  it("registers every documented channel and defaults the namespaces", async () => {
    const app = await harness();
    for (const channel of [
      "commands:list",
      "commands:save",
      "commands:preview",
      "commands:run",
      "commands:run-search",
      "commands:search-text",
      "commands:placeholders",
      "commands:show-search-panel",
      "bookmarks:list",
      "bookmarks:save",
      "bookmarks:open",
      "bookmarks:open-url",
      "bookmarks:close-window",
      "notes:list",
      "notes:get",
      "notes:save",
      "notes:set-image",
      "notes:show",
      "notes:hide",
    ]) {
      expect(app.channels).toContain(channel);
    }
    const snapshot = app.settings.snapshot();
    expect(snapshot.commands).toEqual({ commands: [], searches: [], feedbackNotices: true });
    expect(snapshot.bookmarks).toEqual({ bookmarks: [], window: { width: 960, height: 720, alwaysOnTop: true } });
    expect(snapshot.notes).toEqual({ notes: [], panel: { anchor: "left", width: 440, height: 380 } });
    await app.dispose();
  });

  it("shows the starter examples until something is saved", async () => {
    const app = await harness();
    const view = (await app.invoke("commands:list")) as CommandsView;
    expect(view.commands.map((item: { template: string }) => item.template)).toEqual([
      "/hideout",
      "/invite {player}",
      "/tradewith {player}",
      "/kick {player}",
      "@{player} thanks, enjoy!",
    ]);
    expect(view.issues).toContain("showing example commands — save to keep them");
    expect(view.commands[0].hotkey.actionId).toBe("commands.cmd_starter_hide");
    const saved = (await app.invoke("commands:save", { commands: [CMD] })) as CommandsView;
    expect(saved.issues).toEqual([]);
    expect(saved.commands).toHaveLength(1);
    await app.dispose();
  });

  it("keeps the examples of the list a first save did not carry", async () => {
    const app = await harness();
    // The user edits the stash searches first; the five example COMMANDS the
    // notice promised must not vanish with that save.
    const saved = (await app.invoke("commands:save", { searches: [SEARCH] })) as CommandsView;
    expect(saved.commands.map((item: { template: string }) => item.template)).toEqual([
      "/hideout",
      "/invite {player}",
      "/tradewith {player}",
      "/kick {player}",
      "@{player} thanks, enjoy!",
    ]);
    expect(saved.searches).toHaveLength(1);
    expect(saved.issues).toEqual([]);
    await app.dispose();
  });

  it("keeps both example lists when only the notices switch is saved", async () => {
    const app = await harness();
    const saved = (await app.invoke("commands:save", { feedbackNotices: false })) as CommandsView;
    expect(saved.commands).toHaveLength(5);
    expect(saved.searches).toHaveLength(3);
    expect(saved.feedbackNotices).toBe(false);
    await app.dispose();
  });

  it("contributes the two fixed panel hotkeys with their defaults", async () => {
    const app = await harness();
    const notes = app.hotkeys.entries.get("notes.panel");
    const search = app.hotkeys.entries.get("stash-search.panel");
    expect(notes?.defaultAccelerator).toBe("Alt+N");
    expect(notes?.group).toBe("Overlay");
    expect(search?.defaultAccelerator).toBe("Alt+F");
    await app.dispose();
  });
});

describe("hotkey contributions follow the lists", () => {
  it("adds enabled items, skips disabled ones and re-contributes a rename", async () => {
    const app = await harness();
    await app.invoke("commands:save", {
      commands: [CMD, { ...CMD, id: "cmd_a1b2c3_0002", label: "Off", enabled: false }],
      searches: [SEARCH],
    });
    expect(app.hotkeys.entries.has("commands.cmd_a1b2c3_0001")).toBe(true);
    expect(app.hotkeys.entries.has("commands.cmd_a1b2c3_0002")).toBe(false);
    const search = app.hotkeys.entries.get("stash-searches.srch_a1b2c3_0001");
    expect(search?.group).toBe("Stash searches");
    expect(search?.detail).toBe('"tier: 1[5-6]"');

    await app.invoke("commands:save", { commands: [{ ...CMD, label: "Invite buyer" }], searches: [SEARCH] });
    expect(app.hotkeys.uncontributed).toContain("commands.cmd_a1b2c3_0001");
    expect(app.hotkeys.entries.get("commands.cmd_a1b2c3_0001")?.label).toBe("Invite buyer");

    await app.invoke("commands:save", { commands: [], searches: [] });
    expect(app.hotkeys.entries.has("commands.cmd_a1b2c3_0001")).toBe(false);
    expect(app.events.some(([channel]) => channel === "commands:changed")).toBe(true);
    await app.dispose();
  });

  it("re-syncs when settings are written through the generic settings:set", async () => {
    const app = await harness();
    await app.invoke("settings:set", "notes", { notes: [NOTE] });
    expect(app.hotkeys.entries.get("notes.note_a1b2c3_0001")?.label).toBe("🩸 Ritual");
    expect(app.hotkeys.entries.get("notes.note_a1b2c3_0001")?.group).toBe("Notes");
    await app.dispose();
  });
});

describe("running a command", () => {
  it("sends one line with the resolved placeholder and shows a notice", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    expect(app.chat.sent).toEqual([
      { text: "/invite Bob", reason: 'command "Invite"', source: "command", focus: false },
    ]);
    const notice = app.overlay.shown.at(-1);
    expect(notice?.panelId).toBe("notice");
    expect(notice?.options?.payload).toMatchObject({ title: "Sent", tone: "ok", ttlMs: 2500 });
    expect(app.events.some(([channel]) => channel === "commands:ran")).toBe(true);
    await app.dispose();
  });

  it("uses the desktop hand-off and no notice when the button is clicked", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    const before = app.overlay.shown.length;
    const outcome = (await app.invoke("commands:run", "cmd_a1b2c3_0001", { focus: true })) as {
      ok: boolean;
      resolved: string;
    };
    expect(app.chat.sent[0]).toMatchObject({ focus: true });
    expect(outcome.resolved).toBe("/invite Bob");
    expect(app.overlay.shown.length).toBe(before);
    await app.dispose();
  });

  it("labels a dry-run and a block, and stays silent when notices are off", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    app.chat.setOutcome({ ok: true, dryRun: true, at: "2026-09-14T00:00:00.000Z", sent: "/invite Bob" });
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    expect(app.overlay.shown.at(-1)?.options?.payload).toMatchObject({ title: "Dry-run", tone: "info" });

    app.setClock(1_757_000_100_000);
    app.chat.setOutcome({
      ok: false,
      dryRun: false,
      at: "2026-09-14T00:00:00.000Z",
      blockedBy: "empty",
      error: "unresolved placeholder(s): {player}",
    });
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    expect(app.overlay.shown.at(-1)?.options?.payload).toMatchObject({
      title: "Blocked: empty",
      tone: "danger",
      body: "unresolved placeholder(s): {player}",
    });

    await app.invoke("commands:save", { feedbackNotices: false });
    app.setClock(1_757_000_200_000);
    const before = app.overlay.shown.length;
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    expect(app.overlay.shown.length).toBe(before);
    await app.dispose();
  });

  it("ignores a repeated key press inside the debounce window", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    app.setClock(1_757_000_000_100);
    await app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001");
    expect(app.chat.sent).toHaveLength(1);
    const ran = app.events.filter(([channel]) => channel === "commands:ran").at(-1);
    expect((ran?.[1] as { outcome: { blockedBy: string } }).outcome.blockedBy).toBe("debounced");
    await app.dispose();
  });

  it("hands the registry the real promise instead of a fire-and-forget wrapper", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    const release = app.chat.hold();
    let settled = false;
    const running = app.hotkeys.service.trigger("commands.cmd_a1b2c3_0001").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(app.chat.sent).toEqual([]);
    release();
    await running;
    expect(settled).toBe(true);
    expect(app.chat.sent).toHaveLength(1);
    await app.dispose();
  });

  it("lets a failure inside a hotkey run reach the registry's own catch", async () => {
    const app = await harness();
    app.overlay.failShow(new Error("no display for the overlay window"));
    // The fake registry does what HotkeyServiceImpl.trigger does — await the
    // action — so a rejection surfaces here instead of becoming an unhandled
    // rejection in the main process.
    await expect(app.hotkeys.service.trigger("notes.panel")).rejects.toThrow("no display");
    app.overlay.failShow(undefined);
    await app.dispose();
  });

  it("records the refusals it makes itself as the item's last run", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [{ ...CMD, enabled: false }] });
    await app.invoke("commands:run", "cmd_a1b2c3_0001");
    const view = (await app.invoke("commands:list")) as CommandsView;
    expect(view.commands[0].lastRun).toMatchObject({ ok: false, blockedBy: "disabled" });
    await app.dispose();
  });

  it("previews a line against the live placeholders through its own channel", async () => {
    const app = await harness();
    const preview = (await app.invoke("commands:preview", "@{player} thanks {missing}")) as {
      resolved: string;
      unresolved: string[];
      ok: boolean;
    };
    expect(preview.resolved).toBe("@Bob thanks {missing}");
    expect(preview.unresolved).toEqual(["missing"]);
    expect(preview.ok).toBe(false);
    await app.dispose();
  });

  it("refuses an unknown or disabled command without calling the chat service", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [{ ...CMD, enabled: false }] });
    const disabled = (await app.invoke("commands:run", "cmd_a1b2c3_0001")) as { blockedBy: string };
    expect(disabled.blockedBy).toBe("disabled");
    const unknown = (await app.invoke("commands:run", "cmd_zzzzzz_0009")) as { blockedBy: string };
    expect(unknown.blockedBy).toBe("unknown-item");
    expect(app.chat.sent).toEqual([]);
    await app.dispose();
  });
});

describe("stash searches", () => {
  it("fills the box once for a saved search", async () => {
    const app = await harness();
    await app.invoke("commands:save", { searches: [SEARCH] });
    await app.invoke("commands:run-search", "srch_a1b2c3_0001", { focus: true });
    expect(app.chat.searched).toEqual([
      { text: '"tier: 1[5-6]"', reason: 'stash search "T15+"', options: { focus: true } },
    ]);
    await app.dispose();
  });

  it("refuses untypable text locally", async () => {
    const app = await harness();
    const outcome = (await app.invoke("commands:search-text", "tier → 15")) as {
      blockedBy: string;
      error: string;
    };
    expect(outcome.blockedBy).toBe("empty");
    expect(outcome.error).toContain("cannot type");
    expect(app.chat.searched).toEqual([]);
    await app.dispose();
  });

  it("hands keyboard focus back to the game before typing from the Alt+F panel", async () => {
    const app = await harness();
    await app.invoke("commands:search-text", '"^Waystone"', { fromPanel: true });
    expect(app.overlay.focusCalls).toEqual([{ panelId: "stash-search", focus: false }]);
    expect(app.chat.searched[0]).toMatchObject({ text: '"^Waystone"', options: { focus: true } });
    await app.dispose();
  });

  it("opens the Alt+F panel focused, at the cursor", async () => {
    const app = await harness();
    await app.hotkeys.service.trigger("stash-search.panel");
    const shown = app.overlay.shown.at(-1);
    expect(shown?.panelId).toBe("stash-search");
    expect(shown?.options).toMatchObject({ anchor: "cursor", focus: true, width: 380, height: 220 });
    await app.hotkeys.service.trigger("stash-search.panel");
    expect(app.overlay.hidden).toContain("stash-search");
    await app.dispose();
  });
});

describe("notes panel", () => {
  it("shows the note with the panel's anchor and size, then updates in place", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE, { ...NOTE, id: "note_a1b2c3_0002", title: "Maps" }] });
    await app.hotkeys.service.trigger("notes.panel");
    expect(app.overlay.shown.at(-1)).toMatchObject({
      panelId: "notes",
      options: { anchor: "left", width: 440, height: 380, payload: { noteId: "note_a1b2c3_0001" } },
    });
    await app.hotkeys.service.trigger("notes.note_a1b2c3_0002");
    expect(app.overlay.updated.at(-1)).toEqual({ panelId: "notes", payload: { noteId: "note_a1b2c3_0002" } });
    expect((app.settings.snapshot().notes as { lastNoteId?: string }).lastNoteId).toBe("note_a1b2c3_0002");
    await app.hotkeys.service.trigger("notes.panel");
    expect(app.overlay.hidden).toContain("notes");
    await app.dispose();
  });

  it("re-emits the view when the user closes the panel", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE] });
    app.overlay.emit({ panelId: "notes", kind: "closed-by-user" });
    expect(app.events.some(([channel]) => channel === "notes:changed")).toBe(true);
    await app.dispose();
  });
});

describe("note images", () => {
  it("stores the bytes beside the settings file and serves them back as a data URI", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE] });
    const view = (await app.invoke("notes:set-image", "note_a1b2c3_0001", PNG_DATA_URI)) as {
      image: { mime: string; bytes: number; width: number; height: number };
    };
    expect(view.image).toEqual({ mime: "image/png", bytes: 70, width: 1, height: 1 });
    expect(app.images.files.has("C:/user/notes-images/note_a1b2c3_0001.png")).toBe(true);
    const detail = (await app.invoke("notes:get", "note_a1b2c3_0001")) as { imageDataUri: string };
    expect(detail.imageDataUri).toBe(PNG_DATA_URI);

    await app.invoke("notes:set-image", "note_a1b2c3_0001", null);
    expect(app.images.files.size).toBe(0);
    await app.dispose();
  });

  it("refuses an image that is too large or of the wrong type", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE] });
    await expect(
      app.invoke("notes:set-image", "note_a1b2c3_0001", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    ).rejects.toThrow(/not supported/);
    const big = toDataUri("image/png", new Uint8Array(2 * 1024 * 1024 + 8));
    await expect(app.invoke("notes:set-image", "note_a1b2c3_0001", big)).rejects.toThrow(/limit 2 MB/);
    await app.dispose();
  });

  it("keeps the bytes of a row the sanitizer dropped, not only of the ones it kept", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE] });
    await app.invoke("notes:set-image", NOTE.id, PNG_DATA_URI);
    // 41 rows with the imaged one last: the 40-note cap drops it, but the user
    // never asked for it to go, so its image must survive the save.
    const filler = Array.from({ length: 40 }, (_, index) => ({
      ...NOTE,
      id: `note_b1b2c3_${String(index).padStart(4, "0")}`,
      title: `Filler ${index}`,
    }));
    const view = (await app.invoke("notes:save", { notes: [...filler, NOTE] })) as { notes: unknown[] };
    expect(view.notes).toHaveLength(40);
    expect(app.images.files.has(`C:/user/notes-images/${NOTE.id}.png`)).toBe(true);
    await app.dispose();
  });

  it("removes the file when the note is deleted and sweeps orphans at start-up", async () => {
    const app = await harness();
    await app.invoke("notes:save", { notes: [NOTE] });
    await app.invoke("notes:set-image", "note_a1b2c3_0001", PNG_DATA_URI);
    await app.invoke("notes:save", { notes: [] });
    expect(app.images.files.size).toBe(0);
    await app.dispose();

    const orphan = await harness({
      imageSeed: {
        "C:/user/notes-images/note_dead0001_0001.png": new Uint8Array([1]),
        "C:/user/notes-images/holiday.png": new Uint8Array([2]),
      },
    });
    expect(orphan.images.files.has("C:/user/notes-images/note_dead0001_0001.png")).toBe(false);
    expect(orphan.images.files.has("C:/user/notes-images/holiday.png")).toBe(true);
    await orphan.dispose();
  });
});

describe("bookmarks", () => {
  const EXTERNAL = {
    id: "bm_a1b2c3_0001",
    label: "poe2db",
    url: "https://poe2db.tw/us/",
    mode: "external",
    enabled: true,
  };
  const WINDOWED = { ...EXTERNAL, id: "bm_a1b2c3_0002", label: "Wiki", mode: "window" };

  it("opens an external bookmark in the OS browser", async () => {
    const app = await harness();
    await app.invoke("bookmarks:save", { bookmarks: [EXTERNAL] });
    const outcome = (await app.invoke("bookmarks:open", "bm_a1b2c3_0001")) as { ok: boolean; mode: string };
    expect(outcome).toMatchObject({ ok: true, mode: "external" });
    expect(app.openExternal).toHaveBeenCalledWith("https://poe2db.tw/us/");
    expect(app.web.calls).toEqual([]);
    await app.dispose();
  });

  it("places the always-on-top window against the display's right edge", async () => {
    const app = await harness();
    await app.invoke("bookmarks:save", { bookmarks: [WINDOWED] });
    await app.invoke("bookmarks:open", "bm_a1b2c3_0002");
    expect(app.web.calls.at(-1)).toEqual({
      kind: "toggle",
      url: "https://poe2db.tw/us/",
      bounds: { width: 960, height: 720, x: 1600, y: 360 },
    });
    expect((await app.invoke("bookmarks:list")) as { windowOpen: boolean }).toMatchObject({
      windowOpen: true,
      windowVisible: true,
    });
    expect(await app.invoke("bookmarks:close-window")).toBe(true);
    await app.dispose();
  });

  it("still reports a hidden window as open so it can be closed", async () => {
    const app = await harness();
    await app.invoke("bookmarks:save", { bookmarks: [WINDOWED] });
    await app.invoke("bookmarks:open", "bm_a1b2c3_0002");
    app.web.hide();
    expect(await app.invoke("bookmarks:list")).toMatchObject({ windowOpen: true, windowVisible: false });
    expect(await app.invoke("bookmarks:close-window")).toBe(true);
    expect(await app.invoke("bookmarks:list")).toMatchObject({ windowOpen: false, windowVisible: false });
    await app.dispose();
  });

  it("never opens an address the sanitizer would refuse", async () => {
    const app = await harness();
    const saved = (await app.invoke("bookmarks:save", {
      bookmarks: [{ ...EXTERNAL, url: "javascript:alert(1)" }],
    })) as { bookmarks: unknown[] };
    expect(saved.bookmarks).toEqual([]);
    const outcome = (await app.invoke("bookmarks:open-url", "file:///c:/windows/system32")) as {
      ok: boolean;
      error: string;
    };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("http");
    expect(app.openExternal).not.toHaveBeenCalled();
    await app.dispose();
  });

  it("persists the window bounds the user dragged, debounced", async () => {
    vi.useFakeTimers();
    const app = await harness();
    app.web.moveTo({ width: 1000, height: 800, x: 12, y: 24 });
    expect((app.settings.snapshot().bookmarks as { window: { width: number } }).window.width).toBe(960);
    vi.advanceTimersByTime(600);
    expect((app.settings.snapshot().bookmarks as { window: unknown }).window).toEqual({
      width: 1000,
      height: 800,
      x: 12,
      y: 24,
      alwaysOnTop: true,
    });
    await app.dispose();
  });
});

describe("without the client log", () => {
  it("still registers and resolves only what the price feed knows", async () => {
    const app = await harness({ withClientLog: false });
    const snapshot = (await app.invoke("commands:placeholders")) as {
      context: Record<string, unknown>;
    };
    expect(snapshot.context).toEqual({ league: "Runes of Aldur" });
    await app.dispose();
  });
});

describe("dispose", () => {
  it("removes every hotkey and closes the bookmark window", async () => {
    const app = await harness();
    await app.invoke("commands:save", { commands: [CMD] });
    await app.dispose();
    expect(app.hotkeys.entries.size).toBe(0);
    expect(app.hotkeys.uncontributed).toContain("notes.panel");
    expect(app.hotkeys.uncontributed).toContain("commands.cmd_a1b2c3_0001");
    expect(app.web.calls.some((call) => call.kind === "close")).toBe(true);
  });
});

describe("bookmark window state machine", () => {
  function fakeBrowserWindow() {
    const state = { visible: false, destroyed: false, loaded: [] as string[], shows: 0, created: 0 };
    let fail = false;
    const make = async (): Promise<BookmarkWindowLike> => {
      state.created += 1;
      return {
        isDestroyed: () => state.destroyed,
        isVisible: () => state.visible,
        setAlwaysOnTop: () => undefined,
        setBounds: () => undefined,
        getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        setTitle: () => undefined,
        loadURL: async (url: string) => {
          state.loaded.push(url);
          if (fail) throw new Error("ERR_ABORTED (-3) loading 'https://poe2db.tw/us/'");
        },
        show: () => {
          state.visible = true;
          state.shows += 1;
        },
        hide: () => {
          state.visible = false;
        },
        close: () => {
          state.destroyed = true;
          state.visible = false;
        },
        on: () => undefined,
        webContents: { setWindowOpenHandler: () => undefined, on: () => undefined },
      };
    };
    return {
      state,
      make,
      breakLoading: (value: boolean) => {
        fail = value;
      },
    };
  }

  const BOUNDS = { width: 800, height: 600 };
  const hooks = { openExternal: async () => undefined, log: vi.fn() };

  it("shows the window and remembers the address it really loaded", async () => {
    const fake = fakeBrowserWindow();
    const web = createBookmarkWebWindow(hooks, fake.make);
    await web.open("https://poe2db.tw/us/", "poe2db", BOUNDS, true);
    expect(fake.state.loaded).toEqual(["https://poe2db.tw/us/"]);
    expect(web.currentUrl()).toBe("https://poe2db.tw/us/");
    expect(web.isOpen()).toBe(true);
    expect(web.isVisible()).toBe(true);

    // Pressing the same bookmark again hides it; the window stays alive, and
    // the page is not loaded a second time when it comes back.
    expect(await web.toggle("https://poe2db.tw/us/", "poe2db", BOUNDS, true)).toBe(false);
    expect(web.isOpen()).toBe(true);
    expect(web.isVisible()).toBe(false);
    expect(await web.toggle("https://poe2db.tw/us/", "poe2db", BOUNDS, true)).toBe(true);
    expect(fake.state.loaded).toHaveLength(1);
    expect(fake.state.created).toBe(1);

    expect(web.close()).toBe(true);
    expect(web.isOpen()).toBe(false);
  });

  it("still shows the window after a refused load, and loads again next time", async () => {
    const fake = fakeBrowserWindow();
    fake.breakLoading(true);
    const web = createBookmarkWebWindow(hooks, fake.make);
    await web.open("https://poe2db.tw/us/", "poe2db", BOUNDS, true);
    expect(fake.state.shows).toBe(1);
    expect(web.currentUrl()).toBeUndefined();
    fake.breakLoading(false);
    await web.open("https://poe2db.tw/us/", "poe2db", BOUNDS, true);
    expect(fake.state.loaded).toHaveLength(2);
    expect(web.currentUrl()).toBe("https://poe2db.tw/us/");
  });

  it("refuses anything that is not http(s) before a window exists", async () => {
    const fake = fakeBrowserWindow();
    const web = createBookmarkWebWindow(hooks, fake.make);
    await expect(web.open("file:///c:/windows", "local", BOUNDS, true)).rejects.toThrow(/http/);
    expect(fake.state.created).toBe(0);
  });
});

describe("bookmark window hardening (compliance §4.2)", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src", "main", "features", "commandsBookmarksNotes", "webWindow.ts"),
    "utf8",
  );

  it("keeps the sandbox, the separate partition and the navigation guards", () => {
    expect(source).toContain("sandbox: true");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("webSecurity: true");
    expect(source).toContain("webviewTag: false");
    expect(source).toContain('partition: BOOKMARK_PARTITION');
    expect(source).toContain("setPermissionRequestHandler");
    expect(source).toContain('"will-attach-webview"');
    expect(source).toContain('"will-navigate"');
    expect(source).toContain('"will-redirect"');
    expect(source).not.toContain("preload:");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
