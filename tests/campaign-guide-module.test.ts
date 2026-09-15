import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent } from "../src/core/clientLog.js";
import { CAMPAIGN_IMPORT_MAX_BYTES } from "../src/core/campaignGuide.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createCampaignGuideModule } from "../src/main/features/campaignGuide/index.js";
import { routeCandidates } from "../src/main/features/campaignGuide/routeStore.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { ClientLogService } from "../src/main/features/clientLog/index.js";
import type { HotkeyAction, HotkeyService } from "../src/main/hotkeyService.js";
import type { OverlayService } from "../src/main/overlayWindow.js";
import type { ClientLogStatus } from "../src/shared/clientLog.js";
import type { OverlayPanelEvent } from "../src/shared/overlay.js";
import type { CampaignRouteView, CampaignStateView } from "../src/shared/campaignGuide.js";
import type { FeatureContext, FeatureModule } from "../src/main/features/types.js";

const MINI_ROUTE = readFileSync(
  path.join(process.cwd(), "fixtures", "campaign-guide", "route-mini.json"),
  "utf8",
);
const LOG_LINES = readFileSync(
  path.join(process.cwd(), "fixtures", "campaign-guide", "client-log-campaign.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .filter(Boolean);

type AreaEvent = Extract<ClientLogEvent, { kind: "area" }>;

function eventFromFixture(match: string): ClientLogEvent {
  const line = LOG_LINES.find((entry) => entry.includes(match));
  if (!line) throw new Error(`no fixture line for ${match}`);
  const event = parseClientLogLine(line, areaInfo);
  if (!event) throw new Error(`fixture line did not parse: ${line}`);
  return event;
}

function areaEvent(areaId: string, level: number, at = "2026-09-12T18:00:00.000Z"): AreaEvent {
  return { kind: "area", at, areaId, level, seed: 1, info: areaInfo(areaId) };
}

function fakeClientLog() {
  const listeners = new Map<string, Set<(event: ClientLogEvent) => void>>();
  const ring: ClientLogEvent[] = [];
  let status: ClientLogStatus = { source: "steam", watching: true };
  const replayTail = vi.fn(async () => 0);
  const service: ClientLogService = {
    status: () => status,
    on: (kind, callback) => {
      const set = listeners.get(kind) ?? new Set();
      set.add(callback as (event: ClientLogEvent) => void);
      listeners.set(kind, set);
      return () => set.delete(callback as (event: ClientLogEvent) => void);
    },
    recent: (kind, limit) => {
      const filtered = kind ? ring.filter((event) => event.kind === kind) : [...ring];
      return typeof limit === "number" ? filtered.slice(-limit) : filtered;
    },
    setFile: () => status,
    replayTail,
    reloadGameSettings: () => undefined,
  };
  return {
    service,
    replayTail,
    ring,
    setStatus(next: Partial<ClientLogStatus>) {
      status = { ...status, ...next };
    },
    emit(event: ClientLogEvent) {
      if (event.kind === "area") status = { ...status, area: event };
      for (const callback of listeners.get(event.kind) ?? []) callback(event);
      for (const callback of listeners.get("*") ?? []) callback(event);
    },
  };
}

function fakeOverlay() {
  const visible = new Set<string>();
  const panelListeners = new Set<(event: OverlayPanelEvent) => void>();
  const show = vi.fn(async (panelId: string, _options?: unknown) => {
    visible.add(panelId);
  });
  const update = vi.fn();
  const hide = vi.fn((panelId: string) => {
    visible.delete(panelId);
  });
  const service: OverlayService = {
    show,
    update,
    hide,
    hideAll: vi.fn(),
    toggle: vi.fn(async () => undefined),
    isVisible: (panelId: string) => visible.has(panelId),
    setFocus: vi.fn(),
    state: () => ({
      windowVisible: visible.size > 0,
      visiblePanels: [...visible],
      pinnedPanels: [...visible],
      pointerOverPanel: false,
      poeDetected: true,
    }),
    onPanelEvent: (callback) => {
      panelListeners.add(callback);
      return () => panelListeners.delete(callback);
    },
    onStateChange: () => () => undefined,
  };
  return {
    service,
    show,
    update,
    hide,
    visible,
    /** The PoE-exit sweep removes records WITHOUT a panel event. */
    silentSweep: () => visible.clear(),
    panelEvent: (event: OverlayPanelEvent) => {
      for (const callback of panelListeners) callback(event);
    },
  };
}

function fakeHotkeys() {
  const unContribute = vi.fn();
  const actions: HotkeyAction[] = [];
  const contribute = vi.fn((action: HotkeyAction) => {
    actions.push(action);
    return unContribute;
  });
  const service = {
    contribute,
    list: () => [],
    rebind: () => [],
    validate: () => ({ ok: true }),
    trigger: async () => true,
  } as unknown as HotkeyService;
  return { service, contribute, unContribute, actions };
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

interface BootOptions {
  overlay?: boolean;
  appPath?: string;
  routeText?: string | undefined;
  settingsJson?: string;
  /** Events already in the tailer's ring when the module registers (game before app). */
  seedEvents?: ClientLogEvent[];
  status?: Partial<ClientLogStatus>;
}

async function boot(options: BootOptions = {}) {
  const withOverlay = options.overlay !== false;
  const { ipc, invoke, handlers } = fakeIpc();
  const memory = new Map<string, string>();
  if (options.settingsJson) memory.set("settings.json", options.settingsJson);
  const settings = new SettingsStore({
    file: "settings.json",
    fs: { read: (file) => memory.get(file), write: (file, text) => void memory.set(file, text) },
  });
  const clientLog = fakeClientLog();
  const overlay = fakeOverlay();
  const hotkeys = fakeHotkeys();
  const emitted: Array<[string, unknown]> = [];
  const window = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => void emitted.push([channel, payload]),
    },
  };
  const clipboard = { readText: () => "", writeText: vi.fn() };
  const openExternal = vi.fn(async () => undefined);
  const log = vi.fn();

  const foundations: FeatureModule = {
    id: "fakeFoundations",
    register(ctx: FeatureContext) {
      ctx.provide("clientLog", clientLog.service);
      ctx.provide("hotkeys", hotkeys.service);
      if (withOverlay) ctx.provide("overlay", overlay.service);
    },
  };

  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    ...(options.appPath ? { appPath: options.appPath } : {}),
    buildMode: "authorized-qa",
    core: {} as never,
    settings,
    mainWindow: () => window as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard,
    openExternal,
    log,
  });
  rt.ctx.registerWindow(window as never);

  for (const event of options.seedEvents ?? []) {
    clientLog.ring.push(event);
    if (event.kind === "area") clientLog.setStatus({ area: event });
  }
  if (options.status) clientLog.setStatus(options.status);

  const routeText = "routeText" in options ? options.routeText : MINI_ROUTE;
  const result = await rt.register([
    foundations,
    createCampaignGuideModule({
      routeSource: () => ({ text: routeText, path: "fixtures/campaign-guide/route-mini.json" }),
      now: () => new Date("2026-09-12T21:00:00.000Z"),
    }),
  ]);
  expect(result.failed).toEqual([]);

  const events = (channel: string) =>
    emitted.filter(([name]) => name === channel).map(([, payload]) => payload);

  return {
    rt,
    invoke,
    handlers,
    settings,
    memory,
    clientLog,
    overlay,
    hotkeys,
    clipboard,
    openExternal,
    log,
    emitted,
    events,
    states: () => events("campaign:state") as CampaignStateView[],
    routeChanges: () => events("campaign:route-changed") as CampaignRouteView[],
  };
}

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of teardown.splice(0)) await stop();
});

async function bootAndTrack(options: BootOptions = {}) {
  const harness = await boot(options);
  teardown.push(() => harness.rt.dispose());
  return harness;
}

describe("registration", () => {
  it("registers the eleven campaign channels and contributes Alt+G", async () => {
    const h = await bootAndTrack();
    const channels = h.rt.ctx.channels().filter((channel) => channel.startsWith("campaign:")).sort();
    expect(channels).toEqual([
      "campaign:customise",
      "campaign:export",
      "campaign:hide-overlay",
      "campaign:import",
      "campaign:open-wiki",
      "campaign:rescan-level",
      "campaign:route",
      "campaign:set-character-level",
      "campaign:show-overlay",
      "campaign:state",
      "campaign:toggle-overlay",
    ]);
    const action = h.hotkeys.actions[0];
    expect(action).toMatchObject({
      id: "campaign.toggle",
      label: "Campaign guide",
      group: "Overlay",
      defaultAccelerator: "Alt+G",
    });
    // HotkeyAction.run must resolve to void, not to the state view.
    await expect(action.run()).resolves.toBeUndefined();
  });

  it("registers without ctx.appPath and with it (no Electron import anywhere)", async () => {
    const withoutAppPath = await bootAndTrack();
    expect(withoutAppPath.rt.ctx.appPath).toBe("C:/repo");
    const withAppPath = await bootAndTrack({ appPath: "C:/app" });
    expect(withAppPath.rt.ctx.appPath).toBe("C:/app");
    expect(routeCandidates("C:/repo", "C:/app")).toHaveLength(2);
    expect(routeCandidates("C:/repo", "c:/REPO")).toHaveLength(1);
  });

  it("disposes the hotkey and both log subscriptions", async () => {
    const h = await boot();
    await h.rt.dispose();
    expect(h.hotkeys.unContribute).toHaveBeenCalledTimes(1);
    h.clientLog.emit(areaEvent("G1_2", 2));
    expect(h.overlay.show).not.toHaveBeenCalled();
  });

  it("serves a view with an issue when the bundled file is missing", async () => {
    const h = await bootAndTrack({ routeText: undefined });
    const view = (await h.invoke("campaign:route")) as CampaignRouteView;
    expect(view.bundled.source).toBe("missing");
    expect(view.bundled.issues.length).toBe(1);
    expect(view.merged.acts).toEqual([]);
    const after = (await h.invoke("campaign:customise", {
      op: "add-area",
      area: { id: "G9_1", name: "Mine", part: 1, act: 1, level: 5, exits: [] },
    })) as CampaignRouteView;
    expect(after.merged.areaIndex.G9_1).toBeDefined();
  });
});

describe("start-up state", () => {
  it("seeds visited areas and the current area from the backfilled ring", async () => {
    const seedEvents = [eventFromFixture('"G1_1"'), eventFromFixture('"G1_2"')];
    const h = await bootAndTrack({ seedEvents, status: { watching: true } });
    const view = (await h.invoke("campaign:route")) as CampaignRouteView;
    expect(Object.keys(view.settings.progress.visited).sort()).toEqual(["G1_1", "G1_2"]);
    // One write only, and the reach objective it completes comes with it.
    expect(view.settings.progress.done["G1_1.reach-G1_2"]).toBeDefined();
    expect(view.progressRevision).toBe(2);

    const state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.current?.normalizedId).toBe("G1_2");
    expect(state.clientLog.watching).toBe(true);
  });

  it("reads the character from the status at launch", async () => {
    const h = await bootAndTrack({
      status: { character: { name: "Tester", className: "Warrior", level: 9, seenAt: "2026-09-12T18:04:12.000Z" } },
    });
    const state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.character).toMatchObject({ level: 9, source: "log" });
  });
});

describe("area events and the overlay", () => {
  it("shows the panel pinned and non-focus, then updates it", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    expect(h.overlay.show.mock.calls[0]).toEqual([
      "campaign",
      {
        anchor: "right",
        payload: { areaId: "G1_2", compact: false, reason: "auto" },
        pinned: true,
        focus: false,
        width: 380,
        height: 520,
      },
    ]);
    const state = h.states().at(-1);
    expect(state?.current?.kind).toBe("known");
    expect(state?.overlay.visible).toBe(true);
    expect(state?.overlay.autoShown).toBe(true);

    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:10:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    expect(h.overlay.update).toHaveBeenCalledWith("campaign", {
      areaId: "G1_3",
      compact: false,
      reason: "auto",
    });
  });

  it("hides the auto-shown panel when the player leaves the campaign", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit(eventFromFixture("HideoutBeaconOfSalvation"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.hide).toHaveBeenCalledWith("campaign");
    expect(h.states().at(-1)?.overlay.visible).toBe(false);
  });

  it("keeps the panel when hideOutsideCampaign is off", async () => {
    const h = await bootAndTrack();
    await h.invoke("settings:set", "campaign-guide", { hideOutsideCampaign: false });
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit(eventFromFixture("HideoutBeaconOfSalvation"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.hide).not.toHaveBeenCalled();
  });

  it("does not re-show a panel the user closed until the area changes", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    h.overlay.visible.delete("campaign");
    h.overlay.panelEvent({ panelId: "campaign", kind: "closed-by-user" });

    h.clientLog.emit(areaEvent("G1_2", 2, "2026-09-12T18:20:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(1);

    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:30:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(2);
  });

  it("never auto-hides a panel the hotkey opened", async () => {
    const h = await bootAndTrack();
    await h.invoke("campaign:toggle-overlay");
    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    expect(h.overlay.show.mock.calls[0][1]).toMatchObject({ payload: { reason: "hotkey" } });
    h.clientLog.emit(eventFromFixture("HideoutBeaconOfSalvation"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.hide).not.toHaveBeenCalled();
  });

  it("recovers from the silent PoE-exit sweep", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(1);

    h.overlay.silentSweep(); // no panel event at all
    const state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.overlay.visible).toBe(false);
    expect(state.overlay.autoShown).toBe(false);

    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:40:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(2);
  });

  it("resolves overlapping events in order", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 2, "2026-09-12T18:00:00.000Z"));
    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:01:00.000Z"));
    h.clientLog.emit(areaEvent("G1_town", 15, "2026-09-12T18:02:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    expect(h.overlay.update.mock.calls.map((call) => (call[1] as { areaId: string }).areaId)).toEqual([
      "G1_3",
      "G1_town",
    ]);
  });

  it("records no progress and no XP estimate for a hideout", async () => {
    const h = await bootAndTrack();
    const before = h.memory.get("settings.json");
    const revisionBefore = ((await h.invoke("campaign:state")) as CampaignStateView).progressRevision;

    h.clientLog.emit({
      kind: "level-up",
      at: "2026-09-12T17:00:00.000Z",
      character: "Tester",
      className: "Warrior",
      level: 20,
    });
    h.clientLog.emit(eventFromFixture("HideoutBeaconOfSalvation"));
    await new Promise((resolve) => setImmediate(resolve));

    const state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.current?.kind).toBe("outside");
    // A hideout's instance level must not be compared with the character level.
    expect(state.experience).toBeUndefined();
    expect(state.progressRevision).toBe(revisionBefore);
    expect(h.memory.get("settings.json")).toBe(before);
    const view = (await h.invoke("campaign:route")) as CampaignRouteView;
    expect(Object.keys(view.settings.progress.visited)).toEqual([]);
  });

  it("never issues two show() calls for overlapping overlay commands", async () => {
    const h = await bootAndTrack();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.overlay.show.mockImplementation(async (panelId: string) => {
      // The real service awaits the window BEFORE it records the panel, so
      // isVisible() stays false for this whole window.
      await gate;
      h.overlay.visible.add(panelId);
    });

    const first = h.invoke("campaign:toggle-overlay");
    const second = h.invoke("campaign:toggle-overlay");
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    // The second toggle ran after the first finished, so it hid the panel.
    expect(h.overlay.hide).toHaveBeenCalledTimes(1);
  });

  it("acts on nothing once disposed, even for an event queued behind a pending show", async () => {
    const h = await boot();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.overlay.show.mockImplementation(async (panelId: string) => {
      await gate;
      h.overlay.visible.add(panelId);
    });

    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:10:00.000Z"));
    await h.rt.dispose();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.overlay.show).toHaveBeenCalledTimes(1);
    expect(h.overlay.update).not.toHaveBeenCalled();
    // No settings write during teardown either.
    expect(h.memory.get("settings.json") ?? "").not.toContain("G1_3");
  });

  it("keeps working without an overlay service", async () => {
    const h = await bootAndTrack({ overlay: false });
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    const state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.current?.normalizedId).toBe("G1_2");
    expect(state.overlay.visible).toBe(false);
  });

  it("shows nothing once autoShowInCampaign is off", async () => {
    const h = await bootAndTrack();
    await h.invoke("settings:set", "campaign-guide", { autoShowInCampaign: false });
    h.clientLog.emit(areaEvent("G1_2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.overlay.show).not.toHaveBeenCalled();
  });
});

describe("event economy", () => {
  it("pushes one small state per visit and no route push", async () => {
    const h = await bootAndTrack();
    const before = h.states().length;
    h.clientLog.emit(areaEvent("G1_1", 1, "2026-09-12T18:00:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit(areaEvent("G1_2", 2, "2026-09-12T18:01:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit(areaEvent("G1_3", 3, "2026-09-12T18:02:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));

    const states = h.states().slice(before);
    expect(states).toHaveLength(3);
    expect(states.map((state) => state.progressRevision)).toEqual([2, 3, 4]);
    expect(h.routeChanges()).toHaveLength(0);
  });

  it("pushes a route change for a filter or preference write", async () => {
    const h = await bootAndTrack();
    await h.invoke("settings:set", "campaign-guide", {
      rewardFilters: { gems: false, passives: true, stats: true, currency: true, unlocks: true, ascendancy: true, league: true },
    });
    expect(h.routeChanges()).toHaveLength(1);
    await h.invoke("settings:set", "campaign-guide", { characterLevelOverride: 40 });
    expect(h.routeChanges()).toHaveLength(2);
    expect(h.states().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the route out of a write that changes nothing route-affecting", async () => {
    const h = await bootAndTrack();
    const statesBefore = h.states().length;
    // Same value back: nothing to re-render, so nothing to push.
    await h.invoke("settings:set", "campaign-guide", { overlayAnchor: "right" });
    expect(h.routeChanges()).toHaveLength(0);

    // A progress-shaped write from somewhere else bumps the revision instead,
    // so a consumer pulls the route itself rather than being pushed ~150 KB.
    await h.invoke("settings:set", "campaign-guide", {
      progress: { visited: { G1_1: "2026-09-12T18:00:00.000Z" }, done: {}, undone: [] },
    });
    expect(h.routeChanges()).toHaveLength(0);
    const states = h.states().slice(statesBefore);
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.at(-1)?.progressRevision).toBe(2);
  });
});

describe("channels", () => {
  it("refuses a patch that is not a known op and one the core rejects", async () => {
    const h = await bootAndTrack();
    await expect(h.invoke("campaign:customise", "nope")).rejects.toThrow(
      /campaign-patch-object-required/,
    );
    await expect(h.invoke("campaign:customise", { op: "wat" })).rejects.toThrow(
      /campaign-patch-object-required/,
    );
    await expect(
      h.invoke("campaign:customise", { op: "delete-objective", id: "G1_1.miller" }),
    ).rejects.toThrow(/campaign-patch-rejected:/);
  });

  it("persists a valid patch and announces the route change", async () => {
    const h = await bootAndTrack();
    const view = (await h.invoke("campaign:customise", {
      op: "hide-objective",
      id: "G1_1.miller",
    })) as CampaignRouteView;
    expect(view.merged.areaIndex.G1_1.objectives[0].hidden).toBe(true);
    expect(h.routeChanges()).toHaveLength(1);
    expect(h.memory.get("settings.json")).toContain("G1_1.miller");
  });

  it("keeps a tick out of the route-changed channel", async () => {
    const h = await bootAndTrack();
    await h.invoke("campaign:customise", {
      op: "set-done",
      id: "G1_1.miller",
      done: true,
      at: "2026-09-12T21:00:00.000Z",
    });
    expect(h.routeChanges()).toHaveLength(0);
    expect(h.states().at(-1)?.progressRevision).toBe(2);
  });

  it("overrides the character level and rescans the log", async () => {
    const h = await bootAndTrack();
    h.clientLog.emit(areaEvent("G1_2", 20));
    await new Promise((resolve) => setImmediate(resolve));
    h.clientLog.emit({
      kind: "level-up",
      at: "2026-09-12T18:00:00.000Z",
      character: "Tester",
      className: "Warrior",
      level: 12,
    });
    let state = (await h.invoke("campaign:state")) as CampaignStateView;
    expect(state.character).toMatchObject({ level: 12, source: "log" });
    expect(state.experience?.percent).toBeLessThanOrEqual(100);

    state = (await h.invoke("campaign:set-character-level", 40)) as CampaignStateView;
    expect(state.character).toMatchObject({ level: 40, source: "override" });
    expect(state.experience?.band).toBe("over-levelled");

    await h.invoke("campaign:rescan-level");
    expect(h.clientLog.replayTail).toHaveBeenCalledWith(16 * 1024 * 1024);
  });

  it("exports to the clipboard and imports back as customisations", async () => {
    const h = await bootAndTrack();
    const exported = (await h.invoke("campaign:export")) as { json: string; copied: boolean };
    expect(exported.copied).toBe(true);
    expect(h.clipboard.writeText).toHaveBeenCalledWith(exported.json);

    const edited = JSON.parse(exported.json) as {
      acts: Array<{ areas: Array<{ id: string; name: string }> }>;
    };
    edited.acts[0].areas[0].name = "The Riverbank (fixed)";
    const view = (await h.invoke(
      "campaign:import",
      JSON.stringify(edited),
      "replace-customisations",
    )) as CampaignRouteView;
    expect(view.merged.areaIndex.G1_1.name).toBe("The Riverbank (fixed)");
    expect(view.settings.customisations.areaOverrides.G1_1).toMatchObject({
      name: "The Riverbank (fixed)",
    });
  });

  it("refuses an import over 2 MiB before parsing anything", async () => {
    const h = await bootAndTrack();
    const huge = "x".repeat(CAMPAIGN_IMPORT_MAX_BYTES + 1);
    await expect(h.invoke("campaign:import", huge, "merge")).rejects.toThrow(
      /campaign-import-too-large/,
    );
    const view = (await h.invoke("campaign:route")) as CampaignRouteView;
    expect(view.importIssues).toBeUndefined();
  });

  it("refuses an import whose mode is missing or unknown", async () => {
    const h = await bootAndTrack();
    await h.invoke("campaign:customise", { op: "set-note", areaId: "G1_1", note: "mine" });
    const json = ((await h.invoke("campaign:export")) as { json: string }).json;

    // "replace-customisations" destroys every note and custom area, so it can
    // never be what a missing or mistyped argument means.
    await expect(h.invoke("campaign:import", json)).rejects.toThrow(/campaign-import-bad-mode/);
    await expect(h.invoke("campaign:import", json, "REPLACE")).rejects.toThrow(
      /campaign-import-bad-mode/,
    );
    const view = (await h.invoke("campaign:route")) as CampaignRouteView;
    expect(view.settings.customisations.areaNotes.G1_1).toBe("mine");
  });

  it("opens only poe2wiki URLs", async () => {
    const h = await bootAndTrack();
    const ok = (await h.invoke("campaign:open-wiki", "G1_1")) as { opened: boolean; url?: string };
    expect(ok.opened).toBe(true);
    expect(ok.url).toBe("https://www.poe2wiki.net/wiki/The_Riverbank");
    expect(h.openExternal).toHaveBeenCalledWith("https://www.poe2wiki.net/wiki/The_Riverbank");

    h.openExternal.mockClear();
    // A wiki title that would leave /wiki/ is refused by the sanitizer before it
    // is ever persisted; the handler re-checks the final URL as well.
    await expect(
      h.invoke("campaign:customise", { op: "edit-area", id: "G1_2", patch: { wiki: "../../evil" } }),
    ).rejects.toThrow(/campaign-patch-rejected/);
    expect(h.openExternal).not.toHaveBeenCalled();

    expect(await h.invoke("campaign:open-wiki", "nope")).toEqual({ opened: false });
  });

  it("shows and hides the panel from the desktop", async () => {
    const h = await bootAndTrack();
    const shown = (await h.invoke("campaign:show-overlay", "G1_3")) as CampaignStateView;
    expect(shown.overlay.visible).toBe(true);
    expect(h.overlay.show.mock.calls[0][1]).toMatchObject({
      payload: { areaId: "G1_3", reason: "desktop" },
    });
    const hidden = (await h.invoke("campaign:hide-overlay")) as CampaignStateView;
    expect(hidden.overlay.visible).toBe(false);
  });
});
