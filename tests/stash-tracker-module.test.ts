import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createHotkeysModule } from "../src/main/features/hotkeys/index.js";
import { createOverlayModule } from "../src/main/features/overlay/index.js";
import { createStashTrackerModule } from "../src/main/features/stashTracker/index.js";
import type { ClientProbe } from "../src/main/features/stashTracker/hostProbe.js";
import type { TrackerFs } from "../src/main/features/stashTracker/service.js";
import type { OverlayDisplayLike, OverlayScreenLike, OverlayWindowLike } from "../src/main/overlayWindow.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { HotkeyBindingView } from "../src/shared/hotkeys.js";
import type { StashTrackerOverview, StashTrackerSettings } from "../src/shared/stashTracker.js";

const CONFIG_DIR = path.join("C:", "cfg");
const USER_DIR = path.join("C:", "user");
const LEDGER = path.join(CONFIG_DIR, "inventory.jsonl");
const GRID = path.join(CONFIG_DIR, "grid-calibration.json");

const PRIMARY: OverlayDisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

const CHANNELS = [
  "stash-tracker:overview",
  "stash-tracker:current",
  "stash-tracker:snapshot",
  "stash-tracker:snapshot-get",
  "stash-tracker:rename",
  "stash-tracker:delete",
  "stash-tracker:compare",
  "stash-tracker:session-start",
  "stash-tracker:session-gains",
  "stash-tracker:exclude",
  "stash-tracker:configure",
  "stash-tracker:overlay-toggle",
  "stash-tracker:overlay-show",
  "stash-tracker:overlay-hide",
  "stash-tracker:overlay-next",
  "stash-tracker:overlay-top-level",
  "stash-tracker:overlay-status",
];

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

function fakeOverlayWindow(): OverlayWindowLike & { finishLoad(): void } {
  let visible = false;
  let destroyed = false;
  let loading = true;
  const loadListeners: Array<() => void> = [];
  return {
    finishLoad: () => {
      loading = false;
      for (const listener of loadListeners.splice(0)) listener();
    },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    setBounds: () => undefined,
    show: () => {
      visible = true;
    },
    showInactive: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    focus: () => undefined,
    setFocusable: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    once: () => undefined,
    webContents: {
      send: () => undefined,
      isLoading: () => loading,
      once: (_event, listener) => loadListeners.push(listener),
    },
  };
}

const fakeScreen: OverlayScreenLike = {
  getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  getDisplayNearestPoint: () => PRIMARY,
  getPrimaryDisplay: () => PRIMARY,
};

function memoryFs(initial: Record<string, string>): TrackerFs {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    readText: (file) => files.get(file),
    stat: (file) => {
      const text = files.get(file);
      return text === undefined ? undefined : { size: text.length, mtimeMs: 1 };
    },
    writeText: (file, text) => {
      files.set(file, text);
    },
    appendText: (file, text) => {
      files.set(file, `${files.get(file) ?? ""}${text}`);
    },
  };
}

function priceTable(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [{ id: "storm", match: { name: "Storm Loop" }, value: 3 }],
  };
}

const LEDGER_TEXT = JSON.stringify({
  at: "2026-09-12T17:30:00.000Z",
  location: "Rings",
  cells: [{ row: 3, col: 5 }],
  fingerprint: "a1b2c3d4a1b2c3d4",
  name: "Storm Loop",
  itemClass: "Rings",
  rarity: "Unique",
  identified: true,
  count: 1,
  runId: "run-1",
});

const GRID_TEXT = JSON.stringify({
  "Rings#0": { x: 34, y: 320, w: 1261, h: 1263, cols: 12, rows: 12 },
});

async function moduleHarness(overrides: { probe?: ClientProbe } = {}) {
  const { ipc, invoke } = fakeIpc();
  const settingsMemory = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => settingsMemory.get(file),
      write: (file, text) => {
        settingsMemory.set(file, text);
      },
    },
  });
  const emitted: Array<[string, unknown]> = [];
  const main = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => emitted.push([channel, payload]),
    },
  };
  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: CONFIG_DIR,
    userDataDir: USER_DIR,
    repoRoot: path.join("C:", "repo"),
    appPath: path.join("C:", "repo"),
    buildMode: "authorized-qa",
    core: { itemIntelligence: { getPriceTable: () => priceTable() } } as never,
    settings,
    mainWindow: () => main as never,
    poeWindows: async () => [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    log: vi.fn(),
  });
  const probeClient = vi.fn(
    async (): Promise<ClientProbe> =>
      overrides.probe ?? {
        ok: true,
        client: { left: 0, top: 0, width: 3840, height: 2160 },
        hwnd: "1",
        title: "Path of Exile 2",
        process: "PathOfExile",
      },
  );
  const labelPlans: unknown[] = [];
  let labelVisible = false;
  const result = await rt.register([
    createHotkeysModule({
      globalShortcut: { register: () => true, unregister: () => undefined, isRegistered: () => false },
      fs: { read: () => undefined, write: () => undefined },
      reserved: () => [],
    }),
    createOverlayModule({
      createWindow: () => {
        const win = fakeOverlayWindow();
        win.finishLoad();
        return win;
      },
      screen: fakeScreen,
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    }),
    createStashTrackerModule({
      probeClient,
      otherHostRunning: async () => false,
      labelWindow: {
        show: (plan) => {
          labelPlans.push(plan);
          labelVisible = true;
        },
        hide: () => {
          labelVisible = false;
        },
        isVisible: () => labelVisible,
        dispose: () => {
          labelVisible = false;
        },
      },
      fs: memoryFs({ [LEDGER]: LEDGER_TEXT, [GRID]: GRID_TEXT }),
      timers: { setInterval: () => 1, clearInterval: () => undefined },
      sessionId: "s-module",
      manualTicks: true,
    }),
  ]);
  return {
    rt,
    invoke,
    result,
    settings,
    emitted,
    probeClient,
    labelPlans,
    labelVisible: () => labelVisible,
  };
}

describe("stashTracker feature module", () => {
  it("registers every channel, the settings namespace and three hotkey actions", async () => {
    const h = await moduleHarness();
    expect(h.result.failed).toEqual([]);
    expect(h.rt.ctx.channels()).toEqual(expect.arrayContaining(CHANNELS));

    const snapshot = h.settings.snapshot() as Record<string, StashTrackerSettings>;
    expect(snapshot["stash-tracker"]).toMatchObject({
      autoSnapshot: true,
      maxAutoSnapshots: 100,
      excludedFingerprints: [],
    });

    const bindings = (await h.invoke("hotkeys:list")) as HotkeyBindingView[];
    const ours = bindings.filter((binding) => binding.id.startsWith("stash-tracker."));
    expect(ours.map((binding) => binding.id).sort()).toEqual([
      "stash-tracker.overlay-toggle",
      "stash-tracker.overlay-next-tab",
      "stash-tracker.snapshot",
    ].sort());
    expect(ours.find((binding) => binding.id === "stash-tracker.overlay-toggle")).toMatchObject({
      defaultAccelerator: "Alt+P",
      group: "Overlay",
    });
    await h.rt.dispose();
  });

  it("serves the overview and takes a snapshot over the bridge", async () => {
    const h = await moduleHarness();
    const overview = (await h.invoke("stash-tracker:overview")) as StashTrackerOverview;
    expect(overview.sessionId).toBe("s-module");
    expect(overview.ledger.recordCount).toBe(1);
    expect(overview.snapshots).toHaveLength(1);

    const afterSnapshot = (await h.invoke(
      "stash-tracker:snapshot",
      "  named  ",
    )) as StashTrackerOverview;
    expect(afterSnapshot.snapshots.some((entry) => entry.label === "named")).toBe(true);
    expect(h.emitted.some(([channel]) => channel === "stash-tracker:changed")).toBe(true);
    await h.rt.dispose();
  });

  it("shows the overlay from the hotkey and hides it again", async () => {
    const h = await moduleHarness();
    await h.invoke("hotkeys:trigger", "stash-tracker.overlay-toggle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.probeClient).toHaveBeenCalledTimes(1);
    expect(h.labelPlans).toHaveLength(1);
    const state = (await h.invoke("overlay:state")) as { visiblePanels: string[] };
    expect(state.visiblePanels).toContain("stash-prices");

    await h.invoke("stash-tracker:overlay-hide");
    expect(h.labelVisible()).toBe(false);
    await h.rt.dispose();
  });

  it("coerces sloppy channel arguments instead of trusting them", async () => {
    const h = await moduleHarness();
    expect(await h.invoke("stash-tracker:snapshot-get", 42)).toBeUndefined();
    expect(await h.invoke("stash-tracker:compare", null, undefined)).toBeUndefined();
    const settings = (await h.invoke("stash-tracker:configure", "nonsense")) as StashTrackerSettings;
    expect(settings.autoSnapshot).toBe(true);
    await expect(h.invoke("stash-tracker:exclude", "not-a-fingerprint", true)).rejects.toThrow(
      /stash-tracker-invalid-fingerprint/,
    );
    await h.rt.dispose();
  });

  it("removes its channels and un-contributes its hotkeys on dispose", async () => {
    const h = await moduleHarness();
    await h.rt.dispose();
    await expect(h.invoke("stash-tracker:overview")).rejects.toThrow(/no handler/);
  });
});
