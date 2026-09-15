import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { FeatureModule } from "../src/main/features/types.js";
import type { ClientLogService } from "../src/main/features/clientLog/index.js";
import type { ChatCommandService } from "../src/main/chatCommandService.js";
import type { OverlayService } from "../src/main/overlayWindow.js";
import type { HotkeyService } from "../src/main/hotkeyService.js";
import type { OverlayPanelEvent, OverlayShowOptions, OverlayState } from "../src/shared/overlay.js";
import type { ChatCommandOutcome } from "../src/shared/chatCommands.js";
import type { ClientLogEvent, ClientLogEventKind } from "../src/core/clientLog.js";
import { parseClientLogLine } from "../src/core/clientLog.js";
import { areaInfo } from "../src/core/areaCatalog.js";
import type { PriceTable } from "../src/core/priceTable.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { memoryTradeFs } from "../src/main/features/trade/fs.js";
import { createTradeModule, TRADE_PANEL_ID } from "../src/main/features/trade/index.js";
import type { TradeActionOutcome, TradeOffer, TradeStatus } from "../src/shared/trade.js";

const FIXTURE = readFileSync(path.join(process.cwd(), "fixtures", "trade", "session-en.txt"), "utf8");
const LEDGER = readFileSync(path.join(process.cwd(), "fixtures", "trade", "listings-sold.jsonl"), "utf8");
const SOURCE_DIR = path.join(process.cwd(), "src", "main", "features", "trade");
const NOW = new Date("2026-09-05T16:50:00.000Z");

const TABLE: PriceTable = {
  schemaVersion: 1,
  currency: "exalted",
  entries: [{ id: "divine", match: { name: "Divine Orb" }, value: 500 }],
};

function logEvents(): ClientLogEvent[] {
  return FIXTURE.split(/\r?\n/)
    .map((line) => parseClientLogLine(line, areaInfo))
    .filter((event): event is ClientLogEvent => Boolean(event));
}

function eventFor(predicate: (event: ClientLogEvent) => boolean): ClientLogEvent {
  const match = logEvents().find(predicate);
  if (!match) throw new Error("fixture event not found");
  return match;
}

const WHISPER = eventFor((event) => event.kind === "whisper" && event.player === "Buyerino" && Boolean(event.trade));
const BULK = eventFor((event) => event.kind === "whisper" && event.player === "Bulkbuyer");
const JOINED = eventFor((event) => event.kind === "area-join" && event.joined);
const ACCEPTED = eventFor((event) => event.kind === "trade" && event.result === "accepted");

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
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

function okOutcome(text: string, overrides: Partial<ChatCommandOutcome> = {}): ChatCommandOutcome {
  return { ok: true, dryRun: false, sent: text, at: NOW.toISOString(), ...overrides };
}

function harness(options: { poeRunning?: boolean; ledger?: boolean } = {}) {
  const { ipc, invoke } = fakeIpc();
  const emitted: Array<[string, unknown]> = [];
  const window = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => emitted.push([channel, payload]),
    },
  };

  const listeners = new Map<string, Array<(event: ClientLogEvent) => void>>();
  const clientLog: ClientLogService = {
    status: () => ({
      watching: true,
      source: "steam",
      file: "C:/logs/Client.txt",
      character: { name: "MyChar", className: "Witch", level: 88, seenAt: NOW.toISOString() },
      area: {
        kind: "area",
        at: NOW.toISOString(),
        areaId: "HideoutBeaconOfSalvation",
        level: 65,
        seed: 1,
        info: areaInfo("HideoutBeaconOfSalvation"),
      },
    }),
    on: (kind, callback) => {
      const list = listeners.get(kind as string) ?? [];
      list.push(callback as (event: ClientLogEvent) => void);
      listeners.set(kind as string, list);
      return () => {
        listeners.set(
          kind as string,
          (listeners.get(kind as string) ?? []).filter((entry) => entry !== callback),
        );
      };
    },
    recent: () => [],
    setFile: () => clientLog.status(),
    replayTail: async () => 0,
    reloadGameSettings: () => undefined,
  };
  async function feed(event: ClientLogEvent): Promise<void> {
    for (const listener of listeners.get(event.kind) ?? []) listener(event);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  const chatCalls: Array<{ kind: "send" | "stash-search"; text: string; focus?: boolean; reason: string }> = [];
  /**
   * ONE ordered log of everything that touches the game or the overlay, so a
   * refactor that typed the line BEFORE releasing the panel's focus (which is
   * exactly what §7.6 step 0 forbids) cannot pass by accident.
   */
  const trace: Array<{ kind: string; detail: string }> = [];
  let nextOutcome: ChatCommandOutcome | undefined;
  const chat: ChatCommandService = {
    send: async (request) => {
      chatCalls.push({ kind: "send", text: request.text, focus: request.focus, reason: request.reason });
      trace.push({ kind: "chat", detail: request.text });
      return nextOutcome ?? okOutcome(request.text);
    },
    stashSearch: async (text, reason, opts) => {
      chatCalls.push({ kind: "stash-search", text, focus: opts?.focus, reason });
      trace.push({ kind: "chat", detail: text });
      return nextOutcome ?? okOutcome(text);
    },
    copyHoveredItem: async () => ({ ok: false, dryRun: false, at: NOW.toISOString() }),
    status: () => ({ enabled: true, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false }),
    resolvePlaceholders: (template) => template,
  };

  const overlayCalls: Array<{ action: string; panelId: string; options?: OverlayShowOptions }> = [];
  /** Set to simulate an overlay window that died between the poll and the call. */
  let overlayBroken = "";
  const visible = new Set<string>();
  const pinned = new Set<string>();
  const focusFlags = new Map<string, boolean>();
  let panelEventCallback: ((event: OverlayPanelEvent) => void) | undefined;
  const overlay: OverlayService = {
    show: async (panelId, opts) => {
      overlayCalls.push({ action: "show", panelId, options: opts });
      visible.add(panelId);
      if (opts?.pinned) pinned.add(panelId);
    },
    update: (panelId) => {
      overlayCalls.push({ action: "update", panelId });
    },
    hide: (panelId) => {
      overlayCalls.push({ action: "hide", panelId });
      if (overlayBroken) throw new Error(overlayBroken);
      visible.delete(panelId);
      focusFlags.delete(panelId);
    },
    hideAll: () => {
      visible.clear();
    },
    toggle: async (panelId) => {
      if (visible.has(panelId)) visible.delete(panelId);
      else visible.add(panelId);
    },
    isVisible: (panelId) => visible.has(panelId),
    setFocus: (panelId, focus) => {
      overlayCalls.push({ action: `set-focus:${focus}`, panelId });
      trace.push({ kind: `set-focus:${focus}`, detail: panelId });
      // Mirrors the real service: the flag is cleared BEFORE the blur, so the
      // click-outside rule finds no focused panel and hides nothing.
      focusFlags.set(panelId, focus);
      if (!focus) {
        const stillFocused = [...focusFlags.entries()].some(([, value]) => value);
        if (stillFocused) return;
        for (const id of [...visible]) {
          if (focusFlags.get(id) === true && !pinned.has(id)) visible.delete(id);
        }
      }
    },
    state: (): OverlayState => ({
      windowVisible: visible.size > 0,
      visiblePanels: [...visible],
      pinnedPanels: [...pinned],
      pointerOverPanel: false,
      poeDetected: options.poeRunning !== false,
    }),
    onPanelEvent: (callback) => {
      panelEventCallback = callback;
      return () => {
        panelEventCallback = undefined;
      };
    },
    onStateChange: () => () => undefined,
  };

  const contributed: Array<{ id: string; accelerator: string | null; run: () => void | Promise<void> }> = [];
  const hotkeys: HotkeyService = {
    contribute: (action) => {
      contributed.push({ id: action.id, accelerator: action.defaultAccelerator, run: action.run });
      return () => {
        const index = contributed.findIndex((entry) => entry.id === action.id);
        if (index >= 0) contributed.splice(index, 1);
      };
    },
    list: () => [],
    rebind: () => [],
    validate: () => ({ ok: true }),
    trigger: async (id) => {
      const action = contributed.find((entry) => entry.id === id);
      if (!action) return false;
      await action.run();
      return true;
    },
  };

  const foundations: FeatureModule = {
    id: "test-foundations",
    register(ctx) {
      ctx.provide("clientLog", clientLog);
      ctx.provide("chatCommands", chat);
      ctx.provide("overlay", overlay);
      ctx.provide("hotkeys", hotkeys);
    },
  };

  const settingsFiles = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => settingsFiles.get(file),
      write: (file, text) => {
        settingsFiles.set(file, text);
      },
    },
  });

  const memory = memoryTradeFs(options.ledger === false ? {} : { "C:/cfg/listings.jsonl": LEDGER });
  /** Files whose write throws; the message is the store's `lastError` input. */
  const failedWrites = new Map<string, (text: string) => string>();
  const fs = {
    ...memory,
    write: (file: string, text: string) => {
      const message = failedWrites.get(file);
      if (message) throw new Error(message(text));
      memory.write(file, text);
    },
  };
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  const notify = vi.fn();
  const log = vi.fn();
  const clipboard = { readText: vi.fn(() => ""), writeText: vi.fn() };
  const dialog = {
    showSaveDialog: vi.fn<
      (options: { title?: string; defaultPath?: string }) => Promise<{ canceled: boolean; filePath?: string }>
    >(async () => ({ canceled: true })),
  };
  let tickCallback: (() => void) | undefined;

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: {
      itemIntelligence: { getPriceTable: () => TABLE },
      priceFeed: { status: () => ({ resolvedLeague: "Forbidden Rites", feedAgeHours: 3.2 }) },
    } as never,
    settings,
    mainWindow: () => window as never,
    poeWindows: async () =>
      options.poeRunning === false ? [] : [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }],
    killSwitchLatched: () => false,
    notify,
    clipboard,
    openExternal: async () => undefined,
    openPath: async () => "",
    log,
  });
  runtime.ctx.registerWindow(window as never);

  const trade = createTradeModule({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    fs,
    dialog,
    documentsDir: "C:/docs",
    rand: () => "abcd",
    timers: {
      setInterval: (cb) => {
        tickCallback = cb;
        return 1;
      },
      clearInterval: vi.fn(),
    },
  });

  return {
    runtime,
    invoke,
    emitted,
    feed,
    chatCalls,
    overlayCalls,
    trace,
    failWrite: (file: string, message: (text: string) => string) => {
      failedWrites.set(file, message);
    },
    breakOverlay: (message: string) => {
      overlayBroken = message;
    },
    contributed,
    hotkeys,
    notify,
    log,
    clipboard,
    dialog,
    fetchImpl,
    fs,
    settings,
    settingsFiles,
    visible,
    pinned,
    register: () => runtime.register([foundations, trade]),
    setOutcome: (outcome: ChatCommandOutcome | undefined) => {
      nextOutcome = outcome;
    },
    panelEvent: (event: OverlayPanelEvent) => panelEventCallback?.(event),
    tick: async () => {
      tickCallback?.();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    },
    emittedOf: (channel: string) => emitted.filter(([name]) => name === channel).map(([, payload]) => payload),
  };
}

type Harness = ReturnType<typeof harness>;

async function started(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = harness(options);
  const result = await h.register();
  expect(result.failed).toEqual([]);
  await Promise.resolve();
  return h;
}

describe("trade module registration", () => {
  it("registers exactly its channels, hotkeys and settings namespace", async () => {
    const h = await started();
    expect(h.runtime.ctx.channels().filter((channel) => channel.startsWith("trade:"))).toEqual(
      [
        "trade:dismiss-all",
        "trade:history",
        "trade:history-delete",
        "trade:history-export",
        "trade:history-save",
        "trade:offer-action",
        "trade:offers",
        "trade:panel",
        "trade:panel-focus",
        "trade:status",
        "trade:webhooks",
        "trade:webhooks-set",
        "trade:webhooks-test",
      ].sort(),
    );
    expect(h.contributed.map((entry) => [entry.id, entry.accelerator])).toEqual([
      ["trade.panel", "Alt+T"],
      ["trade.invite-latest", null],
      ["trade.trade-latest", null],
    ]);
    expect(Object.keys(h.settings.snapshot())).toContain("trade");
    await h.runtime.dispose();
  });
});

describe("whispers become cards", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await started();
  });

  it("shows the panel once, notifies once and does not repeat itself", async () => {
    await h.feed(WHISPER);
    const offers = (await h.invoke("trade:offers")) as TradeOffer[];
    expect(offers).toHaveLength(1);
    expect(offers[0].player).toBe("Buyerino");

    const shows = h.overlayCalls.filter((call) => call.action === "show" && call.panelId === TRADE_PANEL_ID);
    expect(shows).toHaveLength(1);
    expect(shows[0].options?.anchor).toBe("top-right");
    expect(h.notify).toHaveBeenCalledTimes(1);

    const announced = h.emittedOf("trade:offer") as Array<{ reason: string; playSoundIn?: string }>;
    expect(announced[0]).toMatchObject({ reason: "new", playSoundIn: "overlay" });

    await h.feed(WHISPER);
    expect(h.overlayCalls.filter((call) => call.action === "show" && call.panelId === TRADE_PANEL_ID)).toHaveLength(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const after = (await h.invoke("trade:offers")) as TradeOffer[];
    expect(after[0].repeats).toBe(2);
  });

  it("updates instead of re-showing an open panel, so a dragged panel keeps its place", async () => {
    await h.feed(WHISPER);
    await h.invoke("trade:panel", "show");
    const shows = h.overlayCalls.filter((call) => call.action === "show" && call.panelId === TRADE_PANEL_ID);
    expect(shows).toHaveLength(1);
    expect(h.overlayCalls.some((call) => call.action === "update" && call.panelId === TRADE_PANEL_ID)).toBe(true);
  });
});

describe("the panel stays closed when the game is not running", () => {
  it("toasts instead and asks the main window for the sound", async () => {
    const h = await started({ poeRunning: false });
    await h.feed(WHISPER);
    expect(h.overlayCalls.filter((call) => call.panelId === TRADE_PANEL_ID && call.action === "show")).toHaveLength(0);
    expect(h.overlayCalls.some((call) => call.panelId === "notice")).toBe(true);
    const announced = h.emittedOf("trade:offer") as Array<{ playSoundIn?: string }>;
    expect(announced[0].playSoundIn).toBe("main");
  });
});

describe("actions type exactly one line", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await started();
    await h.feed(WHISPER);
  });

  async function offerId(): Promise<string> {
    const offers = (await h.invoke("trade:offers")) as TradeOffer[];
    return offers[0].id;
  }

  it("brings the game forward from the desktop and not from the game", async () => {
    const id = await offerId();
    const outcome = (await h.invoke("trade:offer-action", id, { kind: "invite" }, "desktop")) as TradeActionOutcome;
    expect(h.chatCalls.at(-1)).toMatchObject({ kind: "send", text: "/invite Buyerino", focus: true });
    expect(outcome.offer?.state).toBe("invited");

    await h.invoke("trade:offer-action", id, { kind: "trade" }, "overlay");
    expect(h.chatCalls.at(-1)).toMatchObject({ kind: "send", text: "/tradewith Buyerino", focus: false });

    await h.invoke("trade:offer-action", id, { kind: "kick" }, "hotkey");
    expect(h.chatCalls.at(-1)).toMatchObject({ focus: false });
  });

  it("fills the stash search with the right focus per origin", async () => {
    const id = await offerId();
    await h.invoke("trade:offer-action", id, { kind: "highlight" }, "desktop");
    expect(h.chatCalls.at(-1)).toMatchObject({ kind: "stash-search", text: "Ghoul Lash", focus: true });
    await h.invoke("trade:offer-action", id, { kind: "highlight" }, "overlay");
    expect(h.chatCalls.at(-1)).toMatchObject({ kind: "stash-search", focus: false });
  });

  it("does not advance the card in dry-run or when the line is blocked", async () => {
    const id = await offerId();
    h.setOutcome({ ok: true, dryRun: true, sent: "/invite Buyerino", at: NOW.toISOString() });
    const dry = (await h.invoke("trade:offer-action", id, { kind: "invite" }, "desktop")) as TradeActionOutcome;
    expect(dry.offer?.state).toBe("new");

    h.setOutcome({ ok: false, dryRun: false, blockedBy: "not-foreground", at: NOW.toISOString() });
    const blocked = (await h.invoke("trade:offer-action", id, { kind: "invite" }, "desktop")) as TradeActionOutcome;
    expect(blocked.ok).toBe(false);
    expect(blocked.chat?.blockedBy).toBe("not-foreground");
    expect(blocked.offer?.state).toBe("new");

    h.setOutcome({ ok: false, dryRun: false, blockedBy: "not-foreground", at: NOW.toISOString() });
    const highlight = (await h.invoke("trade:offer-action", id, { kind: "highlight" }, "desktop")) as TradeActionOutcome;
    expect(highlight.ok).toBe(false);
    expect(highlight.offer?.state).toBe("new");
  });

  it("copies a whisper line without touching the game", async () => {
    const id = await offerId();
    const before = h.chatCalls.length;
    const outcome = (await h.invoke(
      "trade:offer-action",
      id,
      { kind: "copy-whisper", text: "@Buyerino ty" },
      "desktop",
    )) as TradeActionOutcome;
    expect(outcome.copied).toBe("@Buyerino ty");
    expect(h.clipboard.writeText).toHaveBeenCalledWith("@Buyerino ty");
    expect(h.chatCalls).toHaveLength(before);
  });

  it("refuses an unknown action shape", async () => {
    const id = await offerId();
    await expect(h.invoke("trade:offer-action", id, { kind: "explode" }, "desktop")).rejects.toThrow(
      "trade-action-invalid",
    );
    await expect(h.invoke("trade:offer-action", "", { kind: "invite" })).rejects.toThrow("trade-offer-id-required");
  });

  it("dismisses every active card on request", async () => {
    await h.feed(BULK);
    const dismissed = (await h.invoke("trade:dismiss-all")) as TradeOffer[];
    expect(dismissed.every((offer) => offer.state === "dismissed")).toBe(true);
  });
});

describe("the overlay focus hand-off", () => {
  it("releases focus BEFORE the line is typed and never closes the panel", async () => {
    const h = await started();
    await h.feed(WHISPER);
    const offers = (await h.invoke("trade:offers")) as TradeOffer[];
    const id = offers[0].id;

    const focused = (await h.invoke("trade:panel-focus", true)) as TradeStatus;
    expect(focused.panelFocused).toBe(true);
    expect(h.overlayCalls.at(-1)).toMatchObject({ action: "set-focus:true", panelId: TRADE_PANEL_ID });

    await h.invoke("trade:offer-action", id, { kind: "custom-whisper", text: "ty" }, "overlay");
    // One ordered trace, not two arrays: the release must come BEFORE the
    // line, or F3's foreground gate refuses it as "not-foreground".
    const release = h.trace.findIndex((entry) => entry.kind === "set-focus:false");
    const typed = h.trace.findIndex((entry) => entry.kind === "chat");
    expect(release).toBeGreaterThanOrEqual(0);
    expect(typed).toBeGreaterThanOrEqual(0);
    expect(release).toBeLessThan(typed);
    expect(h.chatCalls.at(-1)).toMatchObject({ text: "@Buyerino ty", focus: true });
    expect(h.overlayCalls.some((call) => call.action === "hide" && call.panelId === TRADE_PANEL_ID)).toBe(false);
    expect(h.visible.has(TRADE_PANEL_ID)).toBe(true);

    const after = (await h.invoke("trade:status")) as TradeStatus;
    expect(after.panelFocused).toBe(false);

    await h.invoke("trade:offer-action", id, { kind: "trade" }, "overlay");
    expect(h.chatCalls.at(-1)?.focus).toBe(false);

    await h.invoke("trade:panel-focus", true);
    h.panelEvent({ panelId: TRADE_PANEL_ID, kind: "closed-by-user" });
    expect(((await h.invoke("trade:status")) as TradeStatus).panelFocused).toBe(false);
  });
});

describe("completed trades and history", () => {
  it("records the sale, announces it and hides the idle panel", async () => {
    const h = await started();
    await h.feed(WHISPER);
    await h.feed(JOINED);
    await h.feed(ACCEPTED);

    const history = h.emittedOf("trade:history-changed").at(-1) as { entries: Array<{ kind: string; player: string }> };
    expect(history.entries[0]).toMatchObject({ kind: "sale", player: "Buyerino" });
    expect(h.overlayCalls.some((call) => call.action === "hide" && call.panelId === TRADE_PANEL_ID)).toBe(true);
  });

  it("keeps a pinned or explicitly shown panel open when it goes idle", async () => {
    const h = await started();
    await h.invoke("trade:panel", "show");
    await h.feed(WHISPER);
    await h.feed(ACCEPTED);
    expect(h.overlayCalls.some((call) => call.action === "hide" && call.panelId === TRADE_PANEL_ID)).toBe(false);
  });

  it("exports the CSV to the clipboard and asks for a path for a file", async () => {
    const h = await started();
    await h.feed(WHISPER);
    await h.feed(ACCEPTED);

    const copied = (await h.invoke("trade:history-export", "clipboard")) as { ok: boolean; rows: number };
    expect(copied.ok).toBe(true);
    expect(h.clipboard.writeText).toHaveBeenCalled();

    const canceled = (await h.invoke("trade:history-export", "file")) as { reason?: string };
    expect(canceled.reason).toBe("canceled");
    expect(h.dialog.showSaveDialog.mock.calls[0]?.[0]?.defaultPath).toContain("C:/docs/poe2-trade-history-");

    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "C:/docs/out.csv" });
    const saved = (await h.invoke("trade:history-export", "file")) as { ok: boolean; path?: string };
    expect(saved.ok).toBe(true);
    expect(h.fs.files.get("C:/docs/out.csv")).toContain("at,kind,player,item");

    await expect(h.invoke("trade:history-export", "nowhere")).rejects.toThrow("trade-export-target-invalid");
  });

  it("reports an empty export without opening a dialog", async () => {
    const h = await started({ ledger: false });
    const result = (await h.invoke("trade:history-export", "file")) as { ok: boolean; reason?: string };
    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(h.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it("edits and deletes a row", async () => {
    const h = await started();
    const view = (await h.invoke("trade:history")) as { entries: Array<{ id: string }> };
    expect(view.entries.length).toBeGreaterThan(0);
    const saved = (await h.invoke("trade:history-save", { id: view.entries[0].id, note: "checked" })) as {
      entries: Array<{ note?: string }>;
    };
    expect(saved.entries[0].note).toBe("checked");
    const deleted = (await h.invoke("trade:history-delete", view.entries[0].id)) as { entries: unknown[] };
    expect(deleted.entries).toHaveLength(0);
    await expect(h.invoke("trade:history-save", "nope")).rejects.toThrow("trade-history-edit-object-required");
  });
});

describe("hotkeys, ticks and settings", () => {
  it("invites the newest buyer or explains that there is none", async () => {
    const h = await started();
    await h.hotkeys.trigger("trade.invite-latest");
    expect(h.overlayCalls.some((call) => call.panelId === "notice")).toBe(true);
    expect(h.chatCalls).toHaveLength(0);

    await h.feed(WHISPER);
    await h.hotkeys.trigger("trade.invite-latest");
    expect(h.chatCalls.at(-1)).toMatchObject({ text: "/invite Buyerino", focus: false });
  });

  it("toggles the panel from the hotkey", async () => {
    const h = await started();
    await h.hotkeys.trigger("trade.panel");
    expect(h.visible.has(TRADE_PANEL_ID)).toBe(true);
    await h.hotkeys.trigger("trade.panel");
    expect(h.visible.has(TRADE_PANEL_ID)).toBe(false);
  });

  it("times a stale card out on the tick", async () => {
    const h = await started();
    await h.feed({ ...WHISPER, at: "2026-09-05T10:00:00.000Z" } as ClientLogEvent);
    await h.tick();
    const offers = (await h.invoke("trade:offers")) as TradeOffer[];
    expect(offers[0].state).toBe("dismissed");
    expect(offers[0].transitions.at(-1)?.via).toBe("timeout");
  });

  it("never persists a webhook secret into the settings document", async () => {
    const h = await started();
    await h.invoke("settings:set", "trade", {
      webhooks: { discord: true, discordUrl: "https://discord.com/api/webhooks/1/abc" },
    });
    const document = h.settingsFiles.get("settings.json") ?? "";
    expect(document).not.toContain("webhooks/1/abc");
    expect(h.log.mock.calls.some(([entry]) => entry.level === "warn" && entry.feature === "trade")).toBe(true);
  });

  it("keeps the webhook status free of the values it holds", async () => {
    const h = await started();
    const url = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";
    const status = (await h.invoke("trade:webhooks-set", { discordWebhookUrl: url })) as {
      discord: { configured: boolean };
    };
    expect(status.discord.configured).toBe(true);
    expect(JSON.stringify(await h.invoke("trade:webhooks"))).not.toContain("abcdefghij");
    await expect(h.invoke("trade:webhooks-set", "nope")).rejects.toThrow("trade-webhooks-object-required");
    await expect(h.invoke("trade:webhooks-test", "sms")).rejects.toThrow("trade-webhooks-target-invalid");
  });
});

describe("privacy and the input boundary", () => {
  it("never writes a player name, whisper text or secret into the log", async () => {
    const h = await started();
    const url = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";

    // The module must actually LOG for this assertion to mean anything, so
    // every logging path is forced: the settings sanitizer, the offer store
    // and the secrets file. The secrets write throws with the whole payload in
    // its message — that is the control case: the URL is in the string handed
    // to the log wrapper, and must come out redacted.
    h.failWrite("C:/user/trade-offers.json", () => "EPERM: trade-offers.json is read-only");
    h.failWrite("C:/user/trade-webhooks.secret.json", (text) => `EPERM writing ${text}`);
    await h.invoke("settings:set", "trade", { offerTtlMinutes: "soon", quickWhispers: [{ template: "hello" }] });
    for (const event of logEvents()) await h.feed(event);
    await h.invoke("trade:webhooks-set", { discordWebhookUrl: url });
    await h.runtime.dispose(); // flushes the offer store, whose write throws

    const entries = h.log.mock.calls.map(([entry]) => entry as { message: unknown; detail?: unknown });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => String(entry.message).includes("secrets could not be saved"))).toBe(true);
    expect(entries.some((entry) => String(entry.message).includes("offers could not be saved"))).toBe(true);

    const logged = entries.map((entry) => `${String(entry.message)} ${JSON.stringify(entry.detail ?? "")}`).join(" | ");
    expect(logged).toContain("[redacted]");
    for (const secret of ["Buyerino", "Sellerino", "Otherguy", "Ghoul Lash", "abcdefghij", url]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("keeps a throw inside the 60 s tick out of the process's unhandled rejections", async () => {
    const h = await started();
    await h.feed({ ...WHISPER, at: "2026-09-05T10:00:00.000Z" } as ClientLogEvent);
    h.breakOverlay("overlay window is gone");
    await h.tick();
    const offers = (await h.invoke("trade:offers")) as TradeOffer[];
    expect(offers[0].state).toBe("dismissed");
    expect(
      h.log.mock.calls.some(
        ([entry]) => entry.level === "error" && String(entry.message).includes("trade tick failed"),
      ),
    ).toBe(true);
  });

  it("contains no direct input-host usage anywhere in the feature", () => {
    for (const file of ["index.ts", "notifier.ts", "offerStore.ts", "historyStore.ts", "fs.ts"]) {
      const source = readFileSync(path.join(SOURCE_DIR, file), "utf8");
      expect(source).not.toContain("startWinHost");
      expect(source).not.toContain("host.send");
      expect(source).not.toContain("GameInputController");
    }
  });

  it("unsubscribes, flushes and clears its timers on dispose", async () => {
    const h = await started();
    await h.feed(WHISPER);
    await h.runtime.dispose();
    expect(h.contributed).toHaveLength(0);
    expect(h.fs.files.has("C:/user/trade-offers.json")).toBe(true);
  });
});
