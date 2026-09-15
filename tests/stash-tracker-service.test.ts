import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { PriceOverlayPlan } from "../src/core/stashTrackerOverlay.js";
import type { ClientProbe } from "../src/main/features/stashTracker/hostProbe.js";
import type { LabelWindowPort } from "../src/main/features/stashTracker/labelWindow.js";
import {
  StashTrackerService,
  mergedCalibrationProfile,
  type TrackerFs,
} from "../src/main/features/stashTracker/service.js";
import type { OverlayService } from "../src/main/overlayWindow.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { OverlayPanelEvent, OverlayState } from "../src/shared/overlay.js";
import {
  normalizeStashTrackerSettings,
  type StashTrackerSettings,
} from "../src/shared/stashTracker.js";

const CONFIG_DIR = path.join("C:", "cfg");
const USER_DIR = path.join("C:", "user");
const REPO_ROOT = path.join("C:", "repo");
const LEDGER = path.join(CONFIG_DIR, "inventory.jsonl");
const GRID = path.join(CONFIG_DIR, "grid-calibration.json");
const SNAPSHOTS = path.join(USER_DIR, "stash-tracker", "snapshots.jsonl");
const SUMMARY = path.join(USER_DIR, "stash-tracker", "summary.json");
const SUMMARY_MIRROR = path.join(USER_DIR, "stash-tracker-summary.json");
const TRACE = path.join(USER_DIR, "assistive-artifacts", "qa-action-trace.jsonl");

const START = Date.parse("2026-09-12T18:00:00.000Z");

function table(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [
      { id: "divine", match: { name: "Divine Orb" }, value: 98 },
      { id: "storm", match: { name: "Storm Loop" }, value: 3 },
      { id: "hh", match: { name: "Headhunter" }, value: 120 },
    ],
  };
}

function ledgerLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
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
    ...overrides,
  });
}

const LEDGER_TEXT = [
  ledgerLine(),
  ledgerLine({
    fingerprint: "cafebabecafebabe",
    name: "Headhunter",
    itemClass: "Belts",
    location: "Belts",
    cells: [{ row: 2, col: 2 }],
    at: "2026-09-12T17:31:00.000Z",
  }),
].join("\n");

const GRID_TEXT = JSON.stringify({
  "Rings#0": { x: 34, y: 320, w: 1261, h: 1263, cols: 12, rows: 12 },
  "Belts#0": { x: 34, y: 320, w: 1261, h: 1263, cols: 12, rows: 12 },
  __default_12x12: { x: 34, y: 320, w: 1261, h: 1263, cols: 12, rows: 12 },
});

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  let failWrites = false;
  const unreadable = new Set<string>();
  const fs: TrackerFs = {
    readText: (file) => {
      // The real readText is existsSync+readFileSync: it throws on EBUSY when
      // the sorter is holding grid-calibration.json open.
      if (unreadable.has(file)) throw new Error(`EBUSY: ${file}`);
      return files.get(file);
    },
    stat: (file) => {
      const text = files.get(file);
      if (text === undefined) return undefined;
      return { size: text.length, mtimeMs: (mtimes.get(file) ?? 0) };
    },
    writeText: (file, text) => {
      if (failWrites) throw new Error("disk full");
      files.set(file, text);
      mtimes.set(file, (mtimes.get(file) ?? 0) + 1);
    },
    appendText: (file, text) => {
      if (failWrites) throw new Error("disk full");
      files.set(file, `${files.get(file) ?? ""}${text}`);
      mtimes.set(file, (mtimes.get(file) ?? 0) + 1);
    },
  };
  const mtimes = new Map<string, number>(Object.keys(initial).map((file) => [file, 1]));
  return {
    files,
    fs,
    setFailWrites: (value: boolean) => {
      failWrites = value;
    },
    failReads: (file: string) => {
      unreadable.add(file);
    },
    write: (file: string, text: string) => {
      files.set(file, text);
      mtimes.set(file, (mtimes.get(file) ?? 0) + 1);
    },
  };
}

function fakeOverlay(poeDetected = true) {
  const shown: Array<{ id: string; options: unknown }> = [];
  const updated: Array<[string, unknown]> = [];
  const hidden: string[] = [];
  const visible = new Set<string>();
  let detected = poeDetected;
  const panelListeners = new Set<(event: OverlayPanelEvent) => void>();
  const stateListeners = new Set<(state: OverlayState) => void>();
  const state = (): OverlayState => ({
    windowVisible: visible.size > 0,
    visiblePanels: [...visible],
    pinnedPanels: [],
    pointerOverPanel: false,
    poeDetected: detected,
  });
  const service: OverlayService = {
    show: async (id, options) => {
      shown.push({ id, options });
      if (id !== "notice") visible.add(id);
    },
    update: (id, payload) => updated.push([id, payload]),
    hide: (id) => {
      hidden.push(id);
      visible.delete(id);
    },
    hideAll: () => visible.clear(),
    toggle: async () => undefined,
    isVisible: (id) => visible.has(id),
    setFocus: () => undefined,
    state,
    onPanelEvent: (callback) => {
      panelListeners.add(callback);
      return () => panelListeners.delete(callback);
    },
    onStateChange: (callback) => {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
  };
  return {
    service,
    shown,
    updated,
    hidden,
    visible,
    emitPanelEvent: (event: OverlayPanelEvent) => {
      for (const listener of panelListeners) listener(event);
    },
    emitState: () => {
      for (const listener of stateListeners) listener(state());
    },
    setPoeDetected: (value: boolean) => {
      detected = value;
    },
    notices: () => shown.filter((entry) => entry.id === "notice"),
  };
}

function fakeLabelWindow() {
  const plans: PriceOverlayPlan[] = [];
  let visible = false;
  let disposed = false;
  const port: LabelWindowPort = {
    show: (plan) => {
      plans.push(plan);
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    isVisible: () => visible,
    dispose: () => {
      disposed = true;
      visible = false;
    },
  };
  return { port, plans, isVisible: () => visible, wasDisposed: () => disposed };
}

interface HarnessOptions {
  ledger?: string | null;
  grid?: string | null;
  snapshots?: string;
  probe?: ClientProbe;
  /** Replaces the probe body, so a test can hold a gesture open. */
  probeImpl?: () => Promise<ClientProbe>;
  poeRunning?: boolean;
  poeDetected?: boolean;
  killSwitch?: boolean;
  otherHost?: boolean;
  sessionId?: string;
}

/** A promise a test resolves by hand, to hold an await open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const OK_PROBE: ClientProbe = {
  ok: true,
  client: { left: 0, top: 0, width: 3840, height: 2160 },
  hwnd: "1",
  title: "Path of Exile 2",
  process: "PathOfExile",
};

function harness(options: HarnessOptions = {}) {
  const initial: Record<string, string> = {};
  if (options.ledger !== null) initial[LEDGER] = options.ledger ?? LEDGER_TEXT;
  if (options.grid !== null) initial[GRID] = options.grid ?? GRID_TEXT;
  if (options.snapshots) initial[SNAPSHOTS] = options.snapshots;
  const memory = memoryFs(initial);
  const settingsMemory = new Map<string, string>();
  const store = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => settingsMemory.get(file),
      write: (file, text) => {
        settingsMemory.set(file, text);
      },
    },
  });
  const settings = store.namespace<StashTrackerSettings>(
    "stash-tracker",
    normalizeStashTrackerSettings,
  );
  const overlay = fakeOverlay(options.poeDetected ?? true);
  const labels = fakeLabelWindow();
  const emitted: Array<[string, unknown]> = [];
  const probeClient = vi.fn(
    async (): Promise<ClientProbe> =>
      options.probeImpl ? options.probeImpl() : (options.probe ?? OK_PROBE),
  );
  let otherHost = options.otherHost === true;
  let now = START;
  let poe = options.poeRunning ?? true;
  let latched = options.killSwitch ?? false;
  const service = new StashTrackerService({
    configDir: CONFIG_DIR,
    userDataDir: USER_DIR,
    repoRoot: REPO_ROOT,
    sessionId: options.sessionId ?? "s-test",
    getPriceTable: () => table(),
    settings,
    overlay: overlay.service,
    labelWindow: labels.port,
    probeClient,
    ...(options.otherHost !== undefined ? { otherHostRunning: async () => otherHost } : {}),
    poeRunning: async () => poe,
    killSwitchLatched: () => latched,
    dryRun: () => false,
    emit: (channel, payload) => emitted.push([channel, payload]),
    log: () => undefined,
    fs: memory.fs,
    now: () => new Date(now),
    manualTicks: true,
  });
  return {
    service,
    memory,
    settings,
    overlay,
    labels,
    emitted,
    probeClient,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
    setPoe: (value: boolean) => {
      poe = value;
    },
    setLatched: (value: boolean) => {
      latched = value;
    },
    setOtherHost: (value: boolean) => {
      otherHost = value;
    },
    trace: () =>
      (memory.files.get(TRACE) ?? "")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    journal: () => memory.files.get(SNAPSHOTS) ?? "",
    summary: () => JSON.parse(memory.files.get(SUMMARY) ?? "{}") as Record<string, unknown>,
  };
}

describe("StashTrackerService start", () => {
  it("anchors the session and writes the summary to userData (never under artifacts/)", () => {
    const h = harness();
    h.service.start();
    const snapshots = h.service.overview().snapshots;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.kind).toBe("session-start");
    expect(h.journal().trim().split("\n")).toHaveLength(1);
    expect(h.summary()).toMatchObject({ version: 1, sessionId: "s-test", snapshotCount: 1 });
    expect(h.memory.files.has(SUMMARY_MIRROR)).toBe(true);
    for (const file of h.memory.files.keys()) {
      expect(file.includes(`${path.sep}artifacts${path.sep}`)).toBe(false);
    }
  });

  it("takes no snapshot when the ledger is empty", () => {
    const h = harness({ ledger: null });
    h.service.start();
    expect(h.service.overview().snapshots).toEqual([]);
    expect(h.service.overview().ledger.exists).toBe(false);
    expect(h.service.current()).toBeUndefined();
  });

  it("re-reads an existing journal and adds one anchor for the new session", () => {
    const first = harness();
    first.service.start();
    const journal = first.journal();
    const second = harness({ snapshots: journal, sessionId: "s-next" });
    second.service.start();
    expect(second.service.overview().snapshots).toHaveLength(2);
  });
});

describe("snapshots", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
    h.service.start();
  });

  it("saves, renames and deletes, rewriting the journal", () => {
    h.advance(60_000);
    const afterSave = h.service.snapshot("before mapping");
    const saved = afterSave.snapshots[0]!;
    expect(saved.label).toBe("before mapping");
    expect(saved.effectiveExalted).toBe(123);

    h.service.rename(saved.id, "  after  mapping ");
    expect(h.service.get(saved.id)?.label).toBe("after mapping");
    expect(h.journal().trim().split("\n")).toHaveLength(2);

    h.service.remove(saved.id);
    expect(h.service.overview().snapshots).toHaveLength(1);
    expect(h.journal()).not.toContain("after mapping");
  });

  it("refuses an empty rename and an unknown id", () => {
    expect(() => h.service.rename("nope", "x")).toThrow(/stash-tracker-snapshot-not-found:nope/);
    const id = h.service.overview().snapshots[0]!.id;
    expect(() => h.service.rename(id, "   ")).toThrow("stash-tracker-label-required");
    expect(() => h.service.remove("nope")).toThrow(/stash-tracker-snapshot-not-found/);
  });

  it("refuses a snapshot of an empty ledger", () => {
    const empty = harness({ ledger: null });
    empty.service.start();
    expect(() => empty.service.snapshot()).toThrow("stash-tracker-ledger-empty");
  });

  it("compares a stored snapshot with the live ledger", () => {
    const id = h.service.overview().snapshots[0]!.id;
    h.memory.write(LEDGER, `${LEDGER_TEXT}\n`);
    h.advance(60_000);
    const diff = h.service.compare(id, "current")!;
    expect(diff.fromId).toBe(id);
    expect(diff.toId).toBe("current");
    expect(diff.totalDelta).toBe(0);
    expect(h.service.compare("missing", "current")).toBeUndefined();
  });

  it("keeps the last write error instead of throwing from a save", () => {
    h.memory.setFailWrites(true);
    h.advance(60_000);
    const view = h.service.snapshot("doomed");
    expect(view.lastError).toContain("stash-tracker-write-failed");
  });
});

describe("auto snapshots", () => {
  it("waits for the ledger to settle, then takes exactly one per ledgerAt", async () => {
    const h = harness();
    h.service.start();
    expect(h.service.overview().snapshots).toHaveLength(1);

    h.memory.write(LEDGER, `${LEDGER_TEXT}\n${ledgerLine({ at: "2026-09-12T18:05:00.000Z", fingerprint: "0badf00d0badf00d", name: "Rugged Girdle", location: "Belts" })}`);
    h.advance(10_000);
    await h.service.tick(); // notices the change, does not snapshot
    expect(h.service.overview().snapshots).toHaveLength(1);

    h.advance(10_000);
    await h.service.tick(); // still inside the settle window
    expect(h.service.overview().snapshots).toHaveLength(1);

    h.advance(60_000);
    await h.service.tick();
    const snapshots = h.service.overview().snapshots;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.kind).toBe("auto");
    expect(h.emitted.some(([channel]) => channel === "stash-tracker:changed")).toBe(true);

    h.advance(120_000);
    await h.service.tick(); // same ledgerAt: no duplicate
    expect(h.service.overview().snapshots).toHaveLength(2);
  });

  it("never takes one while the setting is off", async () => {
    const h = harness();
    h.service.start();
    h.service.configure({ autoSnapshot: false });
    h.memory.write(LEDGER, `${LEDGER_TEXT}\n${ledgerLine({ at: "2026-09-12T18:05:00.000Z", fingerprint: "0badf00d0badf00d", name: "Other" })}`);
    h.advance(10_000);
    await h.service.tick();
    h.advance(120_000);
    await h.service.tick();
    expect(h.service.overview().snapshots).toHaveLength(1);
  });

  it("prunes past the cap without dropping named snapshots", async () => {
    const h = harness();
    h.service.start();
    h.service.configure({ maxAutoSnapshots: 20 });
    h.advance(60_000);
    h.service.snapshot("keep me");
    for (let step = 0; step < 25; step += 1) {
      h.advance(60_000);
      h.service.snapshot(undefined, "auto");
    }
    const snapshots = h.service.overview().snapshots;
    expect(snapshots.filter((entry) => entry.kind !== "manual")).toHaveLength(20);
    expect(snapshots.some((entry) => entry.label === "keep me")).toBe(true);
    expect(h.journal().trim().split("\n")).toHaveLength(21);
  });
});

describe("exclusions", () => {
  it("updates the settings, the totals and the summary", () => {
    const h = harness();
    h.service.start();
    const before = h.service.overview().current!.effectiveExalted;
    expect(before).toBe(123);
    const settings = h.service.setExcluded("cafebabecafebabe", true);
    expect(settings.excludedFingerprints).toEqual(["cafebabecafebabe"]);
    expect(h.service.overview().current!.effectiveExalted).toBe(3);
    expect(h.summary()).toMatchObject({ excludedCount: 1 });
    h.service.setExcluded("cafebabecafebabe", false);
    expect(h.service.overview().current!.effectiveExalted).toBe(123);
  });

  it("refuses anything that is not a ledger fingerprint", () => {
    const h = harness();
    h.service.start();
    expect(() => h.service.setExcluded("nope", true)).toThrow(/stash-tracker-invalid-fingerprint/);
  });
});

describe("the price overlay", () => {
  it("probes once per show, draws labels, opens the legend and remembers the tab", async () => {
    const h = harness();
    h.service.start();
    const status = await h.service.overlayShow("Rings");
    expect(h.probeClient).toHaveBeenCalledTimes(1);
    expect(h.labels.plans).toHaveLength(1);
    expect(h.labels.plans[0]!.tab).toBe("Rings");
    expect(h.labels.plans[0]!.grids[0]!.label).toContain("est. prices");
    expect(status).toMatchObject({ visible: true, tab: "Rings", geometrySource: "taught" });
    expect(h.overlay.shown.some((entry) => entry.id === "stash-prices")).toBe(true);
    expect(h.settings.get().overlay.lastTab).toBe("Rings");
    expect(h.emitted.some(([channel]) => channel === "stash-tracker:overlay")).toBe(true);
  });

  it("toggles off, hiding both the labels and the legend", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayToggle("Rings");
    expect(h.labels.isVisible()).toBe(true);
    const hidden = await h.service.overlayToggle();
    expect(hidden.visible).toBe(false);
    expect(h.labels.isVisible()).toBe(false);
    expect(h.overlay.hidden).toContain("stash-prices");
  });

  it("cycles tabs and toggles top-level WITHOUT a second probe", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayShow("Belts");
    expect(h.probeClient).toHaveBeenCalledTimes(1);

    const next = await h.service.overlayNext(1);
    expect(next.tab).toBe("Rings");
    expect(h.probeClient).toHaveBeenCalledTimes(1);

    const topLevel = await h.service.overlaySetTopLevel("Rings", true);
    expect(topLevel.topLevel).toBe(true);
    expect(h.settings.get().overlay.topLevelTabs).toContain("Rings");
    expect(h.probeClient).toHaveBeenCalledTimes(1);
    expect(h.labels.plans).toHaveLength(3);
  });

  it("refuses while the kill switch is latched", async () => {
    const h = harness({ killSwitch: true });
    h.service.start();
    const status = await h.service.overlayShow("Rings");
    expect(status.visible).toBe(false);
    expect(status.error).toMatch(/Kill switch/);
    expect(h.probeClient).not.toHaveBeenCalled();
    expect(h.overlay.notices()).toHaveLength(1);
  });

  it("refuses when Path of Exile is not running", async () => {
    const h = harness({ poeRunning: false });
    h.service.start();
    const status = await h.service.overlayShow("Rings");
    expect(status).toMatchObject({ visible: false, poeRunning: false });
    expect(h.probeClient).not.toHaveBeenCalled();
  });

  it("reports a probe failure as a notice and an error, drawing nothing", async () => {
    const h = harness({ probe: { ok: false, error: "no-poe-window" } });
    h.service.start();
    const status = await h.service.overlayShow("Rings");
    expect(status.visible).toBe(false);
    expect(status.error).toBe("no-poe-window");
    expect(h.labels.plans).toHaveLength(0);
    expect(h.overlay.notices()).toHaveLength(1);
  });

  it("refuses without any calibration and says how to fix it", async () => {
    const h = harness({ grid: null });
    h.service.start();
    const status = await h.service.overlayShow("Rings");
    expect(status.visible).toBe(false);
    expect(status.error).toMatch(/No calibration/);
    expect(h.labels.plans).toHaveLength(0);
  });

  it("refuses while another host is alive and nothing has been measured yet", async () => {
    const h = harness({ otherHost: true });
    h.service.start();
    const refused = await h.service.overlayShow("Rings");
    expect(refused.error).toMatch(/input host busy/);
    expect(h.probeClient).not.toHaveBeenCalled();
    expect(h.trace()).toEqual([
      expect.objectContaining({
        type: "stash-tracker-rect-probe",
        result: "refused",
        reason: "other-host-running",
      }),
    ]);
  });

  it("reuses the cached rectangle when another host appears mid-session", async () => {
    const h = harness({ otherHost: false });
    h.service.start();
    await h.service.overlayShow("Rings");
    expect(h.probeClient).toHaveBeenCalledTimes(1);

    h.setOtherHost(true);
    h.service.overlayHide();
    const again = await h.service.overlayShow("Belts");
    expect(again).toMatchObject({ visible: true, tab: "Belts" });
    expect(h.probeClient).toHaveBeenCalledTimes(1);
    expect(h.labels.plans).toHaveLength(2);
    expect(h.trace()).toEqual([
      expect.objectContaining({ result: "ok", reason: "overlay-show" }),
      expect.objectContaining({ result: "skipped", reason: "other-host-running" }),
    ]);
  });

  it("joins a repeated Alt+P instead of starting a second host", async () => {
    const gate = deferred<ClientProbe>();
    const h = harness({ probeImpl: () => gate.promise });
    h.service.start();
    const first = h.service.overlayToggle("Rings");
    const second = h.service.overlayToggle("Rings");
    const third = h.service.overlayToggle();
    gate.resolve(OK_PROBE);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(h.probeClient).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ visible: true, tab: "Rings" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(h.labels.plans).toHaveLength(1);
  });

  it("learns the game started from the overlay's own poll", () => {
    const h = harness({ poeDetected: false });
    h.service.start();
    expect(h.service.overlayStatus().poeRunning).toBe(false);
    h.overlay.setPoeDetected(true);
    h.overlay.emitState();
    expect(h.service.overlayStatus().poeRunning).toBe(true);
    const last = h.emitted.filter(([channel]) => channel === "stash-tracker:overlay").pop();
    expect(last?.[1]).toMatchObject({ poeRunning: true });
  });

  it("turns a thrown calibration read into lastError, never a rejection", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayShow("Rings");
    h.memory.failReads(GRID);
    const status = await h.service.overlayNext(1);
    expect(status.error).toContain("EBUSY");
    expect(h.service.overview().lastError).toContain("EBUSY");
    expect(h.probeClient).toHaveBeenCalledTimes(1);
  });

  it("draws nothing for a show that lands after dispose", async () => {
    const gate = deferred<ClientProbe>();
    const h = harness({ probeImpl: () => gate.promise });
    h.service.start();
    const pending = h.service.overlayShow("Rings");
    h.service.dispose();
    gate.resolve(OK_PROBE);
    const status = await pending;
    expect(status.visible).toBe(false);
    expect(h.labels.plans).toHaveLength(0);
    expect(h.labels.wasDisposed()).toBe(true);
  });

  it("hides the labels when the legend is closed by the user or by main", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayShow("Rings");
    h.service.onPanelEvent({ panelId: "stash-prices", kind: "closed-by-user" });
    expect(h.labels.isVisible()).toBe(false);
    expect(h.service.overlayStatus().visible).toBe(false);

    await h.service.overlayShow("Rings");
    expect(h.labels.isVisible()).toBe(true);
    h.overlay.visible.delete("stash-prices");
    h.overlay.emitState();
    expect(h.labels.isVisible()).toBe(false);
  });

  it("re-plans from the cached rectangle when the ledger moves, and never probes from a tick", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayShow("Rings");
    expect(h.labels.plans).toHaveLength(1);

    h.memory.write(LEDGER, `${LEDGER_TEXT}\n${ledgerLine({ at: "2026-09-12T18:20:00.000Z", fingerprint: "b2c3d4e5b2c3d4e5", name: "Doom Noose" })}`);
    h.advance(10_000);
    await h.service.tick();
    h.advance(120_000);
    await h.service.tick();
    expect(h.labels.plans.length).toBeGreaterThan(1);
    expect(h.probeClient).toHaveBeenCalledTimes(1);
  });

  it("drops the overlay when the game disappears", async () => {
    const h = harness();
    h.service.start();
    await h.service.overlayShow("Rings");
    h.setPoe(false);
    h.advance(10_000);
    await h.service.tick();
    expect(h.labels.isVisible()).toBe(false);
    expect(h.service.overlayStatus().poeRunning).toBe(false);
  });

  it("disposes the label window and stops the state subscription", () => {
    const h = harness();
    h.service.start();
    h.service.dispose();
    expect(h.labels.wasDisposed()).toBe(true);
  });
});

describe("mergedCalibrationProfile", () => {
  it("prefers the user's taught profile and falls back to the repo fixture", () => {
    const userFile = path.join(USER_DIR, "perception-templates", "calibration.json");
    const repoFile = path.join(REPO_ROOT, "fixtures", "perception", "templates", "calibration.json");
    const taught = JSON.stringify({
      version: 1,
      client: { width: 3840, height: 2160 },
      npcs: [],
      updatedAt: "2026-09-12T00:00:00.000Z",
      stashGrid: { x: 1, y: 2, w: 3, h: 4, cols: 12, rows: 12 },
    });
    const repo = JSON.stringify({
      version: 1,
      client: { width: 3840, height: 2160 },
      npcs: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      bagGrid: { x: 9, y: 9, w: 9, h: 9, cols: 12, rows: 5 },
    });
    const both = memoryFs({ [userFile]: taught, [repoFile]: repo });
    expect(mergedCalibrationProfile(USER_DIR, REPO_ROOT, both.fs)?.stashGrid?.x).toBe(1);

    const repoOnly = memoryFs({ [repoFile]: repo });
    expect(mergedCalibrationProfile(USER_DIR, REPO_ROOT, repoOnly.fs)?.bagGrid?.x).toBe(9);

    const none = memoryFs({ [userFile]: "not json" });
    expect(mergedCalibrationProfile(USER_DIR, REPO_ROOT, none.fs)).toBeUndefined();
  });
});
