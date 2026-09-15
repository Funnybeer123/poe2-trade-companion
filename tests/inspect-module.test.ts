import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { createInspectModule } from "../src/main/features/inspect/index.js";
import { parseLearnedTiers } from "../src/core/tierLearning.js";
import { DANGEROUS_MAP_MODS } from "../src/data/inspect/dangerousMapMods.js";
import type { InspectReport, InspectShowOutcome } from "../src/shared/inspect.js";
import type { OverlayShowOptions } from "../src/shared/overlay.js";

const RING = readFileSync(new URL("../fixtures/inspect/plain-rare-ring.txt", import.meta.url), "utf8");
const ARMOUR = readFileSync(new URL("../fixtures/inspect/armour-quality-12.txt", import.meta.url), "utf8");
const LEARNED = parseLearnedTiers(
  JSON.parse(readFileSync(new URL("../fixtures/inspect/learned-tiers-sample.json", import.meta.url), "utf8")),
);

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
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

interface ShowCall {
  panelId: string;
  options?: OverlayShowOptions;
}

function fakeOverlay() {
  const shows: ShowCall[] = [];
  const updates: Array<{ panelId: string; payload: unknown }> = [];
  const hides: string[] = [];
  const visible = new Set<string>();
  const pinned: string[] = [];
  let panelListener: ((event: { panelId: string; kind: string }) => void) | undefined;
  const service = {
    show: async (panelId: string, options?: OverlayShowOptions) => {
      shows.push({ panelId, ...(options ? { options } : {}) });
      visible.add(panelId);
    },
    update: (panelId: string, payload: unknown) => {
      updates.push({ panelId, payload });
    },
    hide: (panelId: string) => {
      hides.push(panelId);
      visible.delete(panelId);
    },
    hideAll: () => visible.clear(),
    toggle: async () => undefined,
    isVisible: (panelId: string) => visible.has(panelId),
    setFocus: () => undefined,
    state: () => ({
      windowVisible: true,
      visiblePanels: [...visible],
      pinnedPanels: [...pinned],
      pointerOverPanel: false,
      poeDetected: true,
    }),
    onPanelEvent: (callback: (event: { panelId: string; kind: string }) => void) => {
      panelListener = callback;
      return () => {
        panelListener = undefined;
      };
    },
    onStateChange: () => () => undefined,
  };
  return {
    service,
    shows,
    updates,
    hides,
    pinned,
    emitPanel: (panelId: string, kind: string) => panelListener?.({ panelId, kind }),
    hasListener: () => panelListener !== undefined,
  };
}

function fakeHotkeys() {
  const actions = new Map<string, { id: string; group: string; defaultAccelerator: string | null; run: () => void | Promise<void> }>();
  const removed: string[] = [];
  return {
    actions,
    removed,
    service: {
      contribute: (action: { id: string; group: string; defaultAccelerator: string | null; run: () => void | Promise<void> }) => {
        actions.set(action.id, action);
        return () => {
          removed.push(action.id);
          actions.delete(action.id);
        };
      },
      list: () => [],
      rebind: () => [],
      validate: () => ({ ok: true }),
      trigger: async () => true,
    },
    press: async (id: string) => {
      const action = actions.get(id);
      if (!action) throw new Error(`no hotkey ${id}`);
      await action.run();
    },
  };
}

function manualTimers() {
  const ticks: Array<{ callback: () => void; ms: number; live: boolean }> = [];
  return {
    ticks,
    timers: {
      setInterval: (callback: () => void, ms: number) => {
        const entry = { callback, ms, live: true };
        ticks.push(entry);
        return entry;
      },
      clearInterval: (handle: unknown) => {
        (handle as { live: boolean }).live = false;
      },
    },
    tick: () => {
      for (const entry of ticks) if (entry.live) entry.callback();
    },
    liveCount: () => ticks.filter((entry) => entry.live).length,
  };
}

function harness(
  options: {
    clipboard?: string;
    copyHovered?: ReturnType<typeof vi.fn>;
    /** Make the analysis throw, to exercise the "could not read it" path. */
    breakAnalysis?: boolean;
    /** Controllable clock for the copy-gesture guard. */
    monotonic?: () => number;
  } = {},
) {
  const { ipc, invoke, handlers } = fakeIpc();
  const files = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: { read: (file) => files.get(file), write: (file, text) => void files.set(file, text) },
  });
  const sent: Array<[string, unknown]> = [];
  const window = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { send: (channel: string, payload: unknown) => void sent.push([channel, payload]) },
  };
  const overlay = fakeOverlay();
  const hotkeys = fakeHotkeys();
  const timers = manualTimers();
  const clipboard = { readText: vi.fn(() => options.clipboard ?? ""), writeText: vi.fn() };
  const openExternal = vi.fn(async () => undefined);
  const clientLog = {
    status: () => ({
      area: {
        areaId: "HideoutCanal",
        level: 68,
        info: { id: "HideoutCanal", name: "Canal Hideout", category: "hideout" },
      },
    }),
    on: () => () => undefined,
  };
  const chatCommands = {
    copyHoveredItem: options.copyHovered ?? vi.fn(async () => ({ ok: false as const })),
  };

  const foundations: FeatureModule = {
    id: "test-foundations",
    register(ctx) {
      ctx.provide("overlay", overlay.service as never);
      ctx.provide("hotkeys", hotkeys.service as never);
      ctx.provide("clientLog", clientLog as never);
      ctx.provide("chatCommands", chatCommands as never);
    },
  };

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: {
      priceFeed: {
        learnedTiers: () => LEARNED,
        statsPayloadCached: () => undefined,
      },
      itemIntelligence: { getPriceTable: () => undefined },
    } as never,
    settings,
    mainWindow: () => window as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard,
    openExternal,
    log: vi.fn(),
  });

  const module = createInspectModule({
    timers: timers.timers,
    followPollMs: 1_000,
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    ...(options.breakAnalysis
      ? {
          statCatalogue: () => {
            throw new Error("the stat catalogue exploded");
          },
        }
      : {}),
    ...(options.monotonic ? { monotonic: options.monotonic } : {}),
  });

  return {
    runtime,
    invoke,
    handlers,
    settings,
    sent,
    overlay,
    hotkeys,
    timers,
    clipboard,
    openExternal,
    chatCommands,
    register: () => runtime.register([foundations, module]),
  };
}

describe("the inspect feature module", () => {
  let rig: ReturnType<typeof harness>;

  beforeEach(async () => {
    rig = harness({ clipboard: RING });
    await rig.register();
  });

  it("registers exactly its own channels and contributes the hotkey", () => {
    const channels = [...rig.handlers.keys()].filter((channel) => channel.startsWith("inspect:")).sort();
    expect(channels).toEqual([
      "inspect:analyze",
      "inspect:hide",
      "inspect:last",
      "inspect:map-mods",
      "inspect:open-link",
      "inspect:show",
    ]);
    expect(rig.hotkeys.actions.get("inspect.show")).toMatchObject({
      group: "Overlay",
      defaultAccelerator: "Alt+I",
    });
  });

  it("analyses the clipboard text through the channel with main's learned tiers", async () => {
    const report = (await rig.invoke("inspect:analyze", RING)) as InspectReport;
    expect(report.item.baseType).toBe("Sapphire Ring");
    expect(report.knowledge.learnedTiers).toBe(true);
    expect(report.context?.areaName).toBe("Canal Hideout");
    expect(await rig.invoke("inspect:analyze", "not an item")).toBeNull();
  });

  it("drops the 20 % quality rows when the user turned them off", async () => {
    const withRows = (await rig.invoke("inspect:analyze", ARMOUR)) as InspectReport;
    expect(withRows.defences?.entries[0]!.atQuality20).toBe(441.4);

    rig.settings.setRaw("inspect", { showQualityNormalised: false });
    const withoutRows = (await rig.invoke("inspect:analyze", ARMOUR)) as InspectReport;
    expect(withoutRows.defences?.entries[0]!.atQuality20).toBeUndefined();
    expect(withoutRows.defences?.entries[0]!.value).toBe(412);
  });

  it("shows a notice and no panel when the clipboard holds no item text", async () => {
    const rigEmpty = harness({ clipboard: "" });
    await rigEmpty.register();
    await rigEmpty.hotkeys.press("inspect.show");
    expect(rigEmpty.overlay.shows.map((call) => call.panelId)).toEqual(["notice"]);
    expect(rigEmpty.overlay.shows[0]!.options?.payload).toMatchObject({ tone: "info" });
    const outcome = (await rigEmpty.invoke("inspect:show")) as InspectShowOutcome;
    expect(outcome).toEqual({ shown: false, reason: "no-item-text" });
  });

  it("opens the panel on the hotkey and emits the report", async () => {
    await rig.hotkeys.press("inspect.show");
    expect(rig.overlay.shows).toHaveLength(1);
    expect(rig.overlay.shows[0]!.panelId).toBe("inspect");
    expect(rig.overlay.shows[0]!.options).toMatchObject({ anchor: "cursor", width: 440, height: 560 });
    const payload = rig.overlay.shows[0]!.options!.payload as InspectReport;
    expect(payload.item.baseType).toBe("Sapphire Ring");
    expect(rig.sent.filter(([channel]) => channel === "inspect:report")).toHaveLength(1);
    expect(await rig.invoke("inspect:last")).toMatchObject({ fingerprint: payload.fingerprint });
  });

  it("closes the panel when the same item is inspected twice", async () => {
    await rig.hotkeys.press("inspect.show");
    await rig.hotkeys.press("inspect.show");
    expect(rig.overlay.hides).toEqual(["inspect"]);
    expect(rig.overlay.shows).toHaveLength(1);
  });

  it("swaps the payload of a panel that is already on screen instead of re-anchoring it", async () => {
    await rig.hotkeys.press("inspect.show");
    const outcome = (await rig.invoke("inspect:show", ARMOUR)) as InspectShowOutcome;
    expect(outcome.shown).toBe(true);
    expect(rig.overlay.hides).toEqual([]);
    // A second `show` would recompute the position from the anchor and yank
    // a pinned panel back over the cursor.
    expect(rig.overlay.shows).toHaveLength(1);
    expect(rig.overlay.updates).toHaveLength(1);
    expect((rig.overlay.updates[0]!.payload as InspectReport).item.baseType).toBe("Advanced Vaal Cuirass");
  });

  it("tells item text it could not read apart from an empty clipboard", async () => {
    // An analyser that throws: the user just copied a real item, so "hover
    // an item and press Ctrl+C first" would send them the wrong way.
    const exploding = harness({ clipboard: RING, breakAnalysis: true });
    await exploding.register();
    const outcome = (await exploding.invoke("inspect:show")) as InspectShowOutcome;
    expect(outcome).toEqual({ shown: false, reason: "analysis-failed" });
    expect(exploding.overlay.shows.map((call) => call.panelId)).toEqual(["notice"]);
    expect(exploding.overlay.shows[0]!.options?.payload).toMatchObject({ tone: "warning" });
    expect((exploding.overlay.shows[0]!.options?.payload as { body: string }).body).toContain("could not read");
  });

  it("refuses a paste far too large to be an item, with its own notice", async () => {
    const huge = `${RING}\n${"+1 to maximum Life\n".repeat(20_000)}`;
    const outcome = (await rig.invoke("inspect:show", huge)) as InspectShowOutcome;
    expect(outcome).toEqual({ shown: false, reason: "text-too-large" });
    expect(rig.overlay.shows.map((call) => call.panelId)).toEqual(["notice"]);
    expect((rig.overlay.shows[0]!.options?.payload as { body: string }).body).toContain("too large");
    expect(await rig.invoke("inspect:analyze", huge)).toBeNull();
  });

  it("uses the anchor from settings for the next show", async () => {
    rig.settings.setRaw("inspect", { anchor: "top-right" });
    await rig.hotkeys.press("inspect.show");
    expect(rig.overlay.shows[0]!.options).toMatchObject({ anchor: "top-right" });
  });

  it("opens only allowlisted links", async () => {
    await expect(rig.invoke("inspect:open-link", "https://poe2db.tw/us/Sapphire_Ring")).resolves.toEqual({ ok: true });
    expect(rig.openExternal).toHaveBeenCalledWith("https://poe2db.tw/us/Sapphire_Ring");
    await expect(rig.invoke("inspect:open-link", "https://evil.example/steal")).resolves.toEqual({
      ok: false,
      reason: "not-allowed",
    });
    expect(rig.openExternal).toHaveBeenCalledTimes(1);
  });

  it("reports a link that could not be opened instead of throwing", async () => {
    rig.openExternal.mockRejectedValueOnce(new Error("no browser"));
    await expect(rig.invoke("inspect:open-link", "https://poe2db.tw/us/Ring")).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("merges the user's overrides into the map modifier table", async () => {
    rig.settings.setRaw("inspect", { mapModOverrides: { "no-regen": "ignore" } });
    const rows = (await rig.invoke("inspect:map-mods")) as Array<{ id: string; effectiveSeverity: string }>;
    expect(rows).toHaveLength(DANGEROUS_MAP_MODS.length);
    expect(rows.find((row) => row.id === "no-regen")?.effectiveSeverity).toBe("ignore");
    expect(rows.find((row) => row.id === "players-minus-max-res")?.effectiveSeverity).toBe("deadly");
  });
});

describe("follow the clipboard while the panel is pinned", () => {
  it("updates the panel when the clipboard changes, and only while pinned", async () => {
    const rig = harness({ clipboard: RING });
    await rig.register();
    await rig.hotkeys.press("inspect.show");
    expect(rig.timers.liveCount()).toBe(1);

    // Not pinned yet: the first tick stops the poll and changes nothing.
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(0);
    expect(rig.timers.liveCount()).toBe(0);

    rig.overlay.pinned.push("inspect");
    rig.overlay.emitPanel("inspect", "shown");
    rig.clipboard.readText.mockReturnValue(ARMOUR);
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(1);
    expect((rig.overlay.updates[0]!.payload as InspectReport).item.baseType).toBe("Advanced Vaal Cuirass");

    // The same clipboard text again is not a new report.
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(1);

    // Non-item text on the clipboard is ignored, never cleared.
    rig.clipboard.readText.mockReturnValue("just some chat text");
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(1);
  });

  it("stops polling when the panel closes or the setting is turned off", async () => {
    const rig = harness({ clipboard: RING });
    await rig.register();
    await rig.hotkeys.press("inspect.show");
    rig.overlay.emitPanel("inspect", "closed-by-user");
    expect(rig.timers.liveCount()).toBe(0);

    rig.overlay.pinned.push("inspect");
    rig.overlay.emitPanel("inspect", "shown");
    expect(rig.timers.liveCount()).toBe(1);
    rig.settings.setRaw("inspect", { followClipboardWhilePinned: false });
    expect(rig.timers.liveCount()).toBe(0);

    // …and turning it back on while the panel is still pinned restarts it,
    // instead of leaving the setting looking broken until the next Alt+I.
    rig.settings.setRaw("inspect", { followClipboardWhilePinned: true });
    expect(rig.timers.liveCount()).toBe(1);
    rig.clipboard.readText.mockReturnValue(ARMOUR);
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(1);
  });

  it("keeps the poll alive when one tick throws", async () => {
    const rig = harness({ clipboard: RING });
    await rig.register();
    rig.overlay.pinned.push("inspect");
    await rig.hotkeys.press("inspect.show");
    rig.clipboard.readText.mockImplementationOnce(() => {
      throw new Error("the clipboard is busy");
    });
    expect(() => rig.timers.tick()).not.toThrow();
    expect(rig.timers.liveCount()).toBe(1);
    rig.clipboard.readText.mockReturnValue(ARMOUR);
    rig.timers.tick();
    expect(rig.overlay.updates).toHaveLength(1);
  });

  it("never starts a poll at all when following is off", async () => {
    const rig = harness({ clipboard: RING });
    await rig.register();
    rig.settings.setRaw("inspect", { followClipboardWhilePinned: false });
    await rig.hotkeys.press("inspect.show");
    expect(rig.timers.liveCount()).toBe(0);
    expect(rig.overlay.shows).toHaveLength(1);
  });
});

describe("copy-on-hotkey", () => {
  it("stays off by default: the clipboard is read as it is", async () => {
    const copyHovered = vi.fn(async () => ({ ok: true, text: ARMOUR }));
    const rig = harness({ clipboard: RING, copyHovered });
    await rig.register();
    await rig.hotkeys.press("inspect.show");
    expect(copyHovered).not.toHaveBeenCalled();
    expect((rig.overlay.shows[0]!.options!.payload as InspectReport).item.baseType).toBe("Sapphire Ring");
  });

  it("asks the audited chat-command path for one Ctrl+C when the user turned it on", async () => {
    const copyHovered = vi.fn(async () => ({ ok: true, text: ARMOUR }));
    const rig = harness({ clipboard: RING, copyHovered });
    await rig.register();
    rig.settings.setRaw("inspect", { copyOnHotkey: true });
    await rig.hotkeys.press("inspect.show");
    expect(copyHovered).toHaveBeenCalledWith({ reason: "inspect", source: "inspect" });
    expect((rig.overlay.shows[0]!.options!.payload as InspectReport).item.baseType).toBe("Advanced Vaal Cuirass");
  });

  it("turns a held hotkey into one Ctrl+C, not a burst", async () => {
    // Electron's globalShortcut repeats while the accelerator is held; one
    // gesture must stay one audited input (compliance R1).
    let clock = 1_000;
    const copyHovered = vi.fn(async () => ({ ok: true, text: ARMOUR }));
    const rig = harness({ clipboard: RING, copyHovered, monotonic: () => clock });
    await rig.register();
    rig.settings.setRaw("inspect", { copyOnHotkey: true });

    await rig.hotkeys.press("inspect.show");
    clock += 100;
    await rig.hotkeys.press("inspect.show");
    clock += 100;
    await rig.hotkeys.press("inspect.show");
    expect(copyHovered).toHaveBeenCalledTimes(1);

    // Past the guard, a fresh gesture is honoured again.
    clock += 500;
    await rig.hotkeys.press("inspect.show");
    expect(copyHovered).toHaveBeenCalledTimes(2);
  });

  it("falls back to the clipboard when the copy is blocked", async () => {
    const copyHovered = vi.fn(async () => ({ ok: false, blockedBy: "timeout" }));
    const rig = harness({ clipboard: RING, copyHovered });
    await rig.register();
    rig.settings.setRaw("inspect", { copyOnHotkey: true });
    await rig.hotkeys.press("inspect.show");
    expect((rig.overlay.shows[0]!.options!.payload as InspectReport).item.baseType).toBe("Sapphire Ring");
  });
});

describe("disposing the inspect module", () => {
  it("un-contributes the hotkey, drops the panel subscription and clears the poll", async () => {
    const rig = harness({ clipboard: RING });
    await rig.register();
    rig.overlay.pinned.push("inspect");
    await rig.hotkeys.press("inspect.show");
    expect(rig.timers.liveCount()).toBe(1);
    await rig.runtime.dispose();
    expect(rig.hotkeys.removed).toEqual(["inspect.show"]);
    expect(rig.hotkeys.actions.size).toBe(0);
    expect(rig.overlay.hasListener()).toBe(false);
    expect(rig.timers.liveCount()).toBe(0);
    expect([...rig.handlers.keys()].filter((channel) => channel.startsWith("inspect:"))).toEqual([]);
  });
});
