/**
 * Stash tracker service (package "stash-tracker").
 *
 * Owns the snapshot journal, the session summary mirror and the in-stash
 * price overlay. It READS the sorter's ledger and the grid calibration and
 * WRITES only its own two files under `<userData>/stash-tracker/` — nothing
 * under `artifacts/` is ever rewritten or deleted here.
 *
 * Game contact is one passive `{ op: "rect" }` probe per user gesture
 * (hostProbe.ts). `tick()` never spawns a host: it re-plans with the client
 * rectangle the last gesture measured. No key, no click, no focus change.
 *
 * Everything the service needs from the outside is injected (fs, timers,
 * clock, the probe, the overlay service, the label window) so the whole
 * class runs offline in tests.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { emptyProfile, type CalibrationProfile } from "../../../core/calibrationProfile.js";
import {
  latestObservations,
  locationStaleness,
  parseInventoryRecords,
  type InventoryObservation,
  type InventoryRecord,
  type LocationStaleness,
} from "../../../core/inventoryLedger.js";
import { starterPriceTable, type PriceTable } from "../../../core/priceTable.js";
import type { ScreenRect } from "../../../core/screenLayout.js";
import {
  cycleOverlayTab,
  isTopLevelTabLabel,
  parseGridCalibration,
  pickOverlayTab,
  planPriceOverlay,
  priceOverlayGeometry,
  type PriceOverlayPlan,
} from "../../../core/stashTrackerOverlay.js";
import {
  diffSnapshots,
  parseSnapshotJournal,
  pruneSnapshots,
  sanitizeLabel,
  sessionGains as computeSessionGains,
  serializeSnapshot,
  shouldAutoSnapshot,
  snapshotFromLedger,
  snapshotMeta,
  trackerSummary,
  type SessionGains,
  type SnapshotDiff,
  type SnapshotKind,
  type WealthSnapshot,
} from "../../../core/stashTrackerSnapshot.js";
import {
  STASH_PRICES_PANEL,
  STASH_SNAPSHOTS_FILE,
  STASH_TRACKER_DIR,
  STASH_TRACKER_SUMMARY_FILE,
  STASH_TRACKER_SUMMARY_MIRROR,
  type LedgerStatus,
  type PriceOverlayStatus,
  type StashTrackerOverview,
  type StashTrackerSettings,
  type StashTrackerSettingsPatch,
} from "../../../shared/stashTracker.js";
import type { OverlayPanelEvent, OverlayState } from "../../../shared/overlay.js";
import type { OverlayService } from "../../overlayWindow.js";
import type { SettingsNamespace } from "../../settingsStore.js";
import type { ClientProbe } from "./hostProbe.js";
import type { LabelWindowPort } from "./labelWindow.js";

export const TRACKER_POLL_MS = 10_000;
/** A sort run appends for minutes; snapshot only after this much quiet. */
export const AUTO_SETTLE_MS = 60_000;
const LEDGER_FILE = "inventory.jsonl";
const GRID_CALIBRATION_FILE = "grid-calibration.json";
const FINGERPRINT = /^[0-9a-f]{16}$/i;

export interface TrackerFs {
  readText(file: string): string | undefined;
  stat(file: string): { size: number; mtimeMs: number } | undefined;
  /** Atomic: tmp + rename, so a crash can never leave a half journal. */
  writeText(file: string, text: string): void;
  appendText(file: string, text: string): void;
}

export interface TrackerTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTrackerFs: TrackerFs = {
  readText: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  stat: (file) => {
    try {
      const stats = statSync(file);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  },
  writeText: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
  appendText: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, text, "utf8");
  },
};

const realTimers: TrackerTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface StashTrackerServiceOptions {
  /** artifacts/tab-admin — the ledger and grid calibration live here (read-only). */
  configDir: string;
  /** Electron userData — where this package's own two files live. */
  userDataDir: string;
  repoRoot: string;
  sessionId: string;
  getPriceTable: () => PriceTable;
  settings: SettingsNamespace<StashTrackerSettings>;
  overlay: OverlayService;
  labelWindow: LabelWindowPort;
  probeClient: () => Promise<ClientProbe>;
  poeRunning: () => Promise<boolean>;
  killSwitchLatched: () => boolean;
  dryRun: () => boolean;
  /** True when another win-input-host.ps1 is alive (the numpad daemon, a CLI). */
  otherHostRunning?: () => Promise<boolean>;
  emit(channel: "stash-tracker:changed" | "stash-tracker:overlay", payload: unknown): void;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
  fs?: TrackerFs;
  timers?: TrackerTimers;
  now?: () => Date;
  pollMs?: number;
  settleMs?: number;
  /** Tests drive `tick()` by hand instead of arming the interval. */
  manualTicks?: boolean;
}

interface LedgerCache {
  signature: string;
  records: InventoryRecord[];
  observations: InventoryObservation[];
  staleness: LocationStaleness[];
  newestAt?: string;
  error?: string;
}

/**
 * The same rule as `calibrationIpc.readMergedProfile`, without importing
 * Electron: the user's taught profile wins when it holds any grid, else the
 * repo fixture is the fallback.
 */
export function mergedCalibrationProfile(
  userDataDir: string,
  repoRoot: string,
  fs: TrackerFs,
): CalibrationProfile | undefined {
  const read = (dir: string): CalibrationProfile | undefined => {
    const text = fs.readText(path.join(dir, "calibration.json"));
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as CalibrationProfile;
      if (parsed.version !== 1) return undefined;
      return { ...emptyProfile(), ...parsed, npcs: parsed.npcs ?? [] };
    } catch {
      return undefined;
    }
  };
  const user = read(path.join(userDataDir, "perception-templates"));
  if (user && (user.stashGrid || user.quadStashGrid || user.bagGrid || user.ventorBagGrid)) {
    return user;
  }
  return read(path.join(repoRoot, "fixtures", "perception", "templates")) ?? user;
}

export class StashTrackerService {
  private readonly fs: TrackerFs;
  private readonly timers: TrackerTimers;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly files: {
    ledger: string;
    gridCalibration: string;
    snapshots: string;
    summary: string;
    summaryMirror: string;
    trace: string;
  };

  private snapshots: WealthSnapshot[] = [];
  private sessionId: string;
  private ledgerCache: LedgerCache | undefined;
  private currentCache: { signature: string; snapshot: WealthSnapshot } | undefined;
  private ledgerSignature = "";
  private fileChangedAt: number | undefined;
  private pollHandle: unknown;
  private stopStateChange: (() => void) | undefined;
  private disposed = false;

  private overlayTab: string | undefined;
  private overlayPlanLedgerAt: string | undefined;
  private cachedClient: ScreenRect | undefined;
  private legendShown = false;
  /** The in-flight show, so a repeated Alt+P cannot start a second probe. */
  private showing: Promise<PriceOverlayStatus> | undefined;
  private status: PriceOverlayStatus;
  lastError: string | undefined;

  constructor(private readonly options: StashTrackerServiceOptions) {
    this.fs = options.fs ?? realTrackerFs;
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? TRACKER_POLL_MS;
    this.settleMs = options.settleMs ?? AUTO_SETTLE_MS;
    this.sessionId = options.sessionId;
    const dir = path.join(options.userDataDir, STASH_TRACKER_DIR);
    this.files = {
      ledger: path.join(options.configDir, LEDGER_FILE),
      gridCalibration: path.join(options.configDir, GRID_CALIBRATION_FILE),
      snapshots: path.join(dir, STASH_SNAPSHOTS_FILE),
      summary: path.join(dir, STASH_TRACKER_SUMMARY_FILE),
      summaryMirror: path.join(options.userDataDir, STASH_TRACKER_SUMMARY_MIRROR),
      trace: path.join(options.userDataDir, "assistive-artifacts", "qa-action-trace.jsonl"),
    };
    this.status = {
      visible: false,
      legendVisible: false,
      topLevel: false,
      tabs: [],
      priced: 0,
      unpriced: 0,
      items: 0,
      poeRunning: false,
    };
  }

  /* ---------------- lifecycle ---------------- */

  start(): void {
    this.loadJournal();
    const ledger = this.readLedger(true);
    this.ledgerSignature = ledger.signature;
    if (ledger.records.length && !this.snapshots.some((s) => s.sessionId === this.sessionId)) {
      try {
        this.writeSnapshot(undefined, "session-start");
      } catch (error) {
        this.remember(error);
      }
    }
    this.writeSummary();
    // The overlay foundation already polls for the game window, and that poll
    // is the ONLY thing that can turn the tool's "Show overlay" button on
    // after a launch: nothing else here learns that PoE started.
    try {
      this.status = { ...this.status, poeRunning: this.options.overlay.state().poeDetected };
    } catch (error) {
      this.options.log("warn", "overlay state unavailable at start", error);
    }
    this.stopStateChange = this.options.overlay.onStateChange((state) => this.onOverlayState(state));
    if (!this.options.manualTicks) {
      this.pollHandle = this.timers.setInterval(() => {
        this.tick().catch((error: unknown) => this.remember(error));
      }, this.pollMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollHandle !== undefined) this.timers.clearInterval(this.pollHandle);
    this.pollHandle = undefined;
    this.stopStateChange?.();
    this.stopStateChange = undefined;
    this.options.labelWindow.dispose();
  }

  /* ---------------- reads ---------------- */

  private nowIso(): string {
    return this.now().toISOString();
  }

  private remember(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.options.log("warn", "stash tracker operation failed", error);
  }

  private excludedSet(): Set<string> {
    return new Set(this.options.settings.get().excludedFingerprints);
  }

  private loadJournal(): void {
    try {
      const text = this.fs.readText(this.files.snapshots);
      this.snapshots = text ? parseSnapshotJournal(text) : [];
    } catch (error) {
      this.snapshots = [];
      this.remember(error);
    }
  }

  private readLedger(force = false): LedgerCache {
    const stat = this.fs.stat(this.files.ledger);
    const signature = stat ? `${stat.size}:${stat.mtimeMs}` : "none";
    const cached = this.ledgerCache;
    if (!force && cached && cached.signature === signature) return cached;
    const nowIso = this.nowIso();
    let records: InventoryRecord[] = [];
    let error: string | undefined;
    try {
      const text = this.fs.readText(this.files.ledger);
      records = text ? parseInventoryRecords(text) : [];
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    const observations = latestObservations(records);
    let newestAt: string | undefined;
    for (const record of records) {
      if (!newestAt || Date.parse(record.at) > Date.parse(newestAt)) newestAt = record.at;
    }
    const next: LedgerCache = {
      signature,
      records,
      observations,
      staleness: locationStaleness(records, nowIso),
      ...(newestAt ? { newestAt } : {}),
      ...(error ? { error } : {}),
    };
    this.ledgerCache = next;
    return next;
  }

  private priceTable(): PriceTable {
    try {
      return this.options.getPriceTable();
    } catch {
      return starterPriceTable();
    }
  }

  private ledgerStatus(): LedgerStatus {
    const ledger = this.readLedger();
    const locations = [...new Set(ledger.observations.map((entry) => entry.location))].sort();
    const ageMs = ledger.newestAt
      ? Math.max(0, this.now().getTime() - Date.parse(ledger.newestAt))
      : undefined;
    return {
      file: this.files.ledger,
      exists: ledger.signature !== "none",
      recordCount: ledger.records.length,
      observationCount: ledger.observations.length,
      ...(ledger.newestAt ? { newestAt: ledger.newestAt } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
      locations,
      ...(ledger.error ? { error: ledger.error } : {}),
    };
  }

  /** The live ledger as an unsaved snapshot; raw totals, id "current". */
  current(): WealthSnapshot | undefined {
    const ledger = this.readLedger();
    if (!ledger.records.length) return undefined;
    if (this.currentCache?.signature === ledger.signature) return this.currentCache.snapshot;
    const snapshot: WealthSnapshot = {
      ...snapshotFromLedger(ledger.records, this.priceTable(), {
        at: this.nowIso(),
        kind: "auto",
        sessionId: this.sessionId,
      }),
      id: "current",
    };
    this.currentCache = { signature: ledger.signature, snapshot };
    return snapshot;
  }

  overview(): StashTrackerOverview {
    const settings = this.options.settings.get();
    const excluded = new Set(settings.excludedFingerprints);
    const current = this.current();
    const sorted = [...this.snapshots].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      generatedAt: this.nowIso(),
      sessionId: this.sessionId,
      ledger: this.ledgerStatus(),
      ...(current ? { current: snapshotMeta(current, excluded) } : {}),
      snapshots: sorted.map((snapshot) => snapshotMeta(snapshot, excluded)),
      session: this.sessionGains(),
      settings,
      overlay: this.overlayStatus(),
      files: { snapshots: this.files.snapshots, summary: this.files.summary },
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  sessionGains(): SessionGains {
    return computeSessionGains(
      this.snapshots,
      this.sessionId,
      this.current(),
      this.excludedSet(),
      this.now().getTime(),
    );
  }

  get(id: string): WealthSnapshot | undefined {
    if (id === "current") return this.current();
    return this.snapshots.find((snapshot) => snapshot.id === id);
  }

  compare(fromId: string, toId: string): SnapshotDiff | undefined {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from || !to) return undefined;
    return diffSnapshots(from, to, this.excludedSet());
  }

  /* ---------------- writes ---------------- */

  private uniqueId(base: string): string {
    if (!this.snapshots.some((snapshot) => snapshot.id === base)) return base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!this.snapshots.some((snapshot) => snapshot.id === candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  private writeSnapshot(label: string | undefined, kind: SnapshotKind): WealthSnapshot {
    const ledger = this.readLedger(true);
    if (!ledger.records.length) throw new Error("stash-tracker-ledger-empty");
    const built = snapshotFromLedger(ledger.records, this.priceTable(), {
      at: this.nowIso(),
      kind,
      sessionId: this.sessionId,
      ...(label !== undefined ? { label } : {}),
    });
    const snapshot: WealthSnapshot = { ...built, id: this.uniqueId(built.id) };
    this.snapshots.push(snapshot);
    const settings = this.options.settings.get();
    const pruned = pruneSnapshots(this.snapshots, settings.maxAutoSnapshots, {
      now: this.now().getTime(),
    });
    if (pruned.dropped.length || pruned.trimmed.length) {
      this.snapshots = pruned.kept;
      this.rewriteJournal();
    } else {
      try {
        this.fs.appendText(this.files.snapshots, `${serializeSnapshot(snapshot)}\n`);
        this.lastError = undefined;
      } catch (error) {
        this.remember(new Error(`stash-tracker-write-failed:${String(error)}`));
      }
    }
    return snapshot;
  }

  private rewriteJournal(): void {
    try {
      const text = this.snapshots.map((snapshot) => `${serializeSnapshot(snapshot)}\n`).join("");
      this.fs.writeText(this.files.snapshots, text);
      this.lastError = undefined;
    } catch (error) {
      this.remember(new Error(`stash-tracker-write-failed:${String(error)}`));
    }
  }

  private writeSummary(): void {
    try {
      const summary = trackerSummary(
        this.snapshots,
        this.sessionId,
        this.current(),
        this.excludedSet(),
        this.nowIso(),
      );
      const text = `${JSON.stringify(summary, null, 2)}\n`;
      // The mirror (the filename P7 pins) is written FIRST and the canonical
      // file last, so a failed write can only ever leave the mirror ahead of
      // the canonical file — never a stale mirror presented as current.
      this.fs.writeText(this.files.summaryMirror, text);
      this.fs.writeText(this.files.summary, text);
    } catch (error) {
      this.remember(new Error(`stash-tracker-write-failed:${String(error)}`));
    }
  }

  private changed(): StashTrackerOverview {
    const view = this.overview();
    this.options.emit("stash-tracker:changed", view);
    return view;
  }

  snapshot(label?: string, kind: SnapshotKind = "manual"): StashTrackerOverview {
    this.writeSnapshot(sanitizeLabel(label), kind);
    this.writeSummary();
    return this.changed();
  }

  rename(id: string, label: string): StashTrackerOverview {
    const clean = sanitizeLabel(label);
    if (!clean) throw new Error("stash-tracker-label-required");
    const index = this.snapshots.findIndex((snapshot) => snapshot.id === id);
    if (index < 0) throw new Error(`stash-tracker-snapshot-not-found:${id}`);
    this.snapshots[index] = { ...this.snapshots[index]!, label: clean };
    this.rewriteJournal();
    this.writeSummary();
    return this.changed();
  }

  remove(id: string): StashTrackerOverview {
    const index = this.snapshots.findIndex((snapshot) => snapshot.id === id);
    if (index < 0) throw new Error(`stash-tracker-snapshot-not-found:${id}`);
    this.snapshots.splice(index, 1);
    this.rewriteJournal();
    this.writeSummary();
    return this.changed();
  }

  /** A new session id: gains are measured from here on. */
  startSession(): StashTrackerOverview {
    this.sessionId = `s-${this.now().getTime().toString(36)}`;
    try {
      this.writeSnapshot(undefined, "session-start");
    } catch (error) {
      this.remember(error);
    }
    this.writeSummary();
    return this.changed();
  }

  setExcluded(fingerprint: string, excluded: boolean): StashTrackerSettings {
    const value = String(fingerprint ?? "").trim();
    if (!FINGERPRINT.test(value)) throw new Error(`stash-tracker-invalid-fingerprint:${value}`);
    const next = this.options.settings.set((current) => {
      const set = new Set(current.excludedFingerprints);
      if (excluded) set.add(value);
      else set.delete(value);
      return { ...current, excludedFingerprints: [...set] };
    });
    this.writeSummary();
    this.changed();
    if (this.status.visible) this.replan().catch((error: unknown) => this.remember(error));
    return next;
  }

  configure(patch: StashTrackerSettingsPatch): StashTrackerSettings {
    const next = this.options.settings.set((current) => ({
      ...current,
      ...patch,
      overlay: { ...current.overlay, ...(patch.overlay ?? {}) },
    }));
    this.writeSummary();
    this.changed();
    if (this.status.visible) this.replan().catch((error: unknown) => this.remember(error));
    return next;
  }

  /* ---------------- overlay ---------------- */

  overlayStatus(): PriceOverlayStatus {
    return { ...this.status };
  }

  private emitOverlay(): PriceOverlayStatus {
    const status = this.overlayStatus();
    this.options.emit("stash-tracker:overlay", status);
    if (this.legendShown) this.options.overlay.update(STASH_PRICES_PANEL, status);
    return status;
  }

  private isTopLevel(tab: string): boolean {
    const list = this.options.settings.get().overlay.topLevelTabs;
    if (list.includes(`!${tab}`)) return false;
    return list.includes(tab) || isTopLevelTabLabel(tab);
  }

  private async notice(title: string, body: string, tone: "warning" | "danger" = "warning"): Promise<void> {
    try {
      await this.options.overlay.show("notice", {
        anchor: "top-right",
        payload: { title, body, tone, ttlMs: 4_000 },
      });
    } catch (error) {
      this.options.log("warn", "notice panel failed", error);
    }
  }

  private appendTrace(result: string, reason: string): void {
    // Every PowerShell host spawn is auditable even though no input follows.
    try {
      this.fs.appendText(
        this.files.trace,
        `${JSON.stringify({
          at: this.nowIso(),
          module: "stash-tracker",
          type: "stash-tracker-rect-probe",
          result,
          reason,
        })}\n`,
      );
    } catch {
      // The audit line is best-effort; never fail a gesture over it.
    }
  }

  private setStatusError(error: string | undefined): void {
    if (error) this.status = { ...this.status, error };
    else {
      const { error: _dropped, ...rest } = this.status;
      this.status = rest;
    }
  }

  /**
   * Single flight. Windows' RegisterHotKey repeats WM_HOTKEY while Alt+P is
   * held, and `status.visible` only turns true at the END of the ~half-second
   * probe — so without this guard every repeat inside that window would take
   * the show path and start its own PowerShell rect host.
   */
  async overlayShow(tab?: string): Promise<PriceOverlayStatus> {
    const inFlight = this.showing;
    if (inFlight) return inFlight;
    const run = this.runOverlayShow(tab);
    this.showing = run;
    try {
      return await run;
    } finally {
      if (this.showing === run) this.showing = undefined;
    }
  }

  private async runOverlayShow(tab?: string): Promise<PriceOverlayStatus> {
    if (this.options.killSwitchLatched()) {
      this.setStatusError("Kill switch latched — re-arm before reading the game window.");
      await this.notice("Stash prices", "Kill switch latched — re-arm before reading the game window.", "danger");
      return this.emitOverlay();
    }
    const running = await this.options.poeRunning();
    if (this.disposed) return this.overlayStatus();
    this.status = { ...this.status, poeRunning: running };
    if (!running) {
      this.setStatusError("Path of Exile is not running.");
      await this.notice("Stash prices", "Path of Exile is not running.");
      return this.emitOverlay();
    }
    const ledger = this.readLedger();
    const locations = [...new Set(ledger.observations.map((entry) => entry.location))];
    this.status = { ...this.status, tabs: [...locations].sort() };
    if (!locations.length) {
      this.setStatusError("No ledger yet — run a sort first.");
      await this.notice("Stash prices", "No ledger yet — run a sort first.");
      return this.emitOverlay();
    }
    const settings = this.options.settings.get();
    const chosen = pickOverlayTab(locations, tab ?? settings.overlay.lastTab, ledger.staleness);
    if (!chosen) {
      this.setStatusError("No tab to label.");
      return this.emitOverlay();
    }
    this.overlayTab = chosen;
    const probed = await this.measureClient();
    // The probe can outlive a quit: never draw into a disposed service.
    if (this.disposed) return this.overlayStatus();
    if (!probed.ok) {
      this.setStatusError(probed.error);
      await this.notice("Stash prices", `Could not read the game window: ${probed.error}`);
      return this.emitOverlay();
    }
    return this.replan();
  }

  /**
   * One `rect` probe per gesture. When another input host is alive (the
   * numpad daemon, a CLI run) the last measured rectangle is reused instead
   * of starting a second PowerShell process next to it.
   */
  private async measureClient(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.options.otherHostRunning) {
      let busy = false;
      try {
        busy = await this.options.otherHostRunning();
      } catch {
        busy = false;
      }
      if (busy) {
        if (this.cachedClient) {
          this.appendTrace("skipped", "other-host-running");
          this.options.log("info", "input host busy; reusing the last window position");
          return { ok: true };
        }
        this.appendTrace("refused", "other-host-running");
        return { ok: false, error: "input host busy — try again when the daemon is idle" };
      }
    }
    const probe = await this.options.probeClient();
    this.appendTrace(probe.ok ? "ok" : "failed", "overlay-show");
    if (!probe.ok) return { ok: false, error: probe.error };
    this.cachedClient = probe.client;
    return { ok: true };
  }

  /**
   * Re-draw from the cached client rectangle. NEVER probes, and NEVER throws:
   * every caller is a timer, a hotkey or a settings write that discards the
   * promise, so a thrown read (a grid-calibration.json held open by the
   * sorter, say) would surface as an unhandled rejection in main instead of
   * as `overview().lastError`.
   */
  private async replan(): Promise<PriceOverlayStatus> {
    try {
      return await this.drawPlan();
    } catch (error) {
      this.remember(error);
      this.setStatusError(this.lastError);
      return this.emitOverlay();
    }
  }

  private async drawPlan(): Promise<PriceOverlayStatus> {
    if (this.disposed) return this.overlayStatus();
    const client = this.cachedClient;
    const tab = this.overlayTab;
    if (!client || !tab) return this.overlayStatus();
    const ledger = this.readLedger();
    const settings = this.options.settings.get();
    const observations = ledger.observations.filter((entry) => entry.location === tab);
    const topLevel = this.isTopLevel(tab);
    const profile = this.calibrationProfile();
    const geometry = priceOverlayGeometry({
      tabKey: tab,
      topLevel,
      gridCalibration: parseGridCalibration(this.fs.readText(this.files.gridCalibration)),
      ...(profile ? { profile } : {}),
      client,
      cellsHint: observations.flatMap((entry) => entry.cells),
    });
    if (!geometry) {
      this.setStatusError(
        "No calibration for this tab — calibrate the stash grid (Tools → Calibration) or teach it with calibrate-grid.",
      );
      await this.notice(
        "Stash prices",
        "No calibration for this tab — calibrate the stash grid, or teach it with calibrate-grid.",
      );
      return this.emitOverlay();
    }
    const staleness = ledger.staleness.find((entry) => entry.location === tab);
    const plan: PriceOverlayPlan = planPriceOverlay({
      observations,
      table: this.priceTable(),
      geometry,
      client,
      tab,
      ...(staleness ? { staleness } : {}),
      excluded: this.excludedSet(),
      options: {
        fadeByValue: settings.overlay.fadeByValue,
        showUnpriced: settings.overlay.showUnpriced,
        minLabelExalted: settings.overlay.minLabelExalted,
      },
    });
    if (this.disposed) return this.overlayStatus();
    this.options.labelWindow.show(plan);
    this.overlayPlanLedgerAt = ledger.newestAt ?? "";
    this.status = {
      visible: true,
      legendVisible: settings.overlay.showLegend,
      tab,
      topLevel,
      tabs: [...new Set(ledger.observations.map((entry) => entry.location))].sort(),
      ...(staleness ? { lastScanAt: staleness.lastScanAt, ageMs: staleness.ageMs } : {}),
      totalExalted: plan.totalExalted,
      priced: plan.priced,
      unpriced: plan.unpriced,
      items: plan.items.length,
      geometrySource: geometry.source,
      poeRunning: true,
    };
    if (settings.overlay.showLegend && !this.legendShown) {
      try {
        await this.options.overlay.show(STASH_PRICES_PANEL, {
          anchor: "bottom-right",
          payload: this.overlayStatus(),
          pinned: false,
          focus: false,
          width: 300,
          height: 168,
        });
        // Only now: an "is the legend still open?" check that ran while the
        // show was in flight would otherwise tear the labels down again.
        this.legendShown = true;
      } catch (error) {
        this.options.log("warn", "stash-prices legend failed to open", error);
      }
    } else if (!settings.overlay.showLegend && this.legendShown) {
      this.legendShown = false;
      this.options.overlay.hide(STASH_PRICES_PANEL);
    }
    if (settings.overlay.lastTab !== tab) {
      this.options.settings.set((current) => ({
        ...current,
        overlay: { ...current.overlay, lastTab: tab },
      }));
    }
    return this.emitOverlay();
  }

  private profileCache: { loaded: boolean; profile?: CalibrationProfile } = { loaded: false };

  private calibrationProfile(): CalibrationProfile | undefined {
    if (!this.profileCache.loaded) {
      const profile = mergedCalibrationProfile(
        this.options.userDataDir,
        this.options.repoRoot,
        this.fs,
      );
      this.profileCache = { loaded: true, ...(profile ? { profile } : {}) };
    }
    return this.profileCache.profile;
  }

  overlayHide(): PriceOverlayStatus {
    this.options.labelWindow.hide();
    if (this.legendShown) {
      this.legendShown = false;
      try {
        this.options.overlay.hide(STASH_PRICES_PANEL);
      } catch (error) {
        this.options.log("warn", "stash-prices legend failed to close", error);
      }
    }
    this.status = { ...this.status, visible: false, legendVisible: false };
    this.setStatusError(undefined);
    return this.emitOverlay();
  }

  async overlayToggle(tab?: string): Promise<PriceOverlayStatus> {
    // A key repeat is not a second gesture: join the show already running
    // rather than hiding a layer that has not finished appearing.
    const inFlight = this.showing;
    if (inFlight) return inFlight;
    if (this.status.visible) return this.overlayHide();
    return this.overlayShow(tab);
  }

  async overlayNext(direction: 1 | -1): Promise<PriceOverlayStatus> {
    const ledger = this.readLedger();
    const locations = [...new Set(ledger.observations.map((entry) => entry.location))];
    const next = cycleOverlayTab(locations, this.overlayTab, direction);
    if (!next) return this.overlayStatus();
    this.overlayTab = next;
    if (!this.cachedClient || !this.status.visible) return this.overlayShow(next);
    return this.replan();
  }

  async overlaySetTopLevel(tab: string, topLevel: boolean): Promise<PriceOverlayStatus> {
    this.options.settings.set((current) => {
      const list = current.overlay.topLevelTabs.filter(
        (entry) => entry !== tab && entry !== `!${tab}`,
      );
      // "!Tab" is the explicit "treat as a folder tab" override, needed for
      // the T1..T99 labels the heuristic flags automatically.
      if (topLevel) list.push(tab);
      else if (isTopLevelTabLabel(tab)) list.push(`!${tab}`);
      return { ...current, overlay: { ...current.overlay, topLevelTabs: list } };
    });
    this.overlayTab = tab;
    if (!this.cachedClient || !this.status.visible) return this.overlayShow(tab);
    return this.replan();
  }

  onPanelEvent(event: OverlayPanelEvent): void {
    if (!event || event.panelId !== STASH_PRICES_PANEL) return;
    if (event.kind !== "closed-by-user" && event.kind !== "hidden") return;
    if (!this.status.visible) return;
    this.legendShown = false;
    this.overlayHide();
  }

  /**
   * The overlay foundation's state poll, which is also this package's only
   * source of "is PoE running?" outside a gesture: the tool's Show-overlay
   * button reads `poeRunning` and would otherwise stay disabled forever.
   * It is also how main tells us it hid the legend (hide-all, Escape, PoE
   * gone) — in which case the labels must go with it.
   */
  private onOverlayState(state: OverlayState): void {
    if (this.disposed) return;
    if (state.poeDetected !== this.status.poeRunning) {
      this.status = { ...this.status, poeRunning: state.poeDetected };
      this.emitOverlay();
    }
    if (!this.status.visible || !this.legendShown) return;
    if (state.visiblePanels.includes(STASH_PRICES_PANEL)) return;
    this.legendShown = false;
    this.overlayHide();
  }

  /* ---------------- the poll ---------------- */

  async tick(): Promise<void> {
    if (this.disposed) return;
    const stat = this.fs.stat(this.files.ledger);
    const signature = stat ? `${stat.size}:${stat.mtimeMs}` : "none";
    const nowMs = this.now().getTime();
    if (signature !== this.ledgerSignature) {
      this.ledgerSignature = signature;
      this.fileChangedAt = nowMs;
      return; // let the sort run finish appending
    }
    const settings = this.options.settings.get();
    const ledger = this.readLedger();
    const latest = [...this.snapshots].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (
      settings.autoSnapshot &&
      shouldAutoSnapshot({
        ...(ledger.newestAt ? { ledgerAt: ledger.newestAt } : {}),
        ...(latest ? { latest } : {}),
        ...(this.fileChangedAt !== undefined ? { fileChangedAt: this.fileChangedAt } : {}),
        now: nowMs,
        settleMs: this.settleMs,
        recordCount: ledger.records.length,
      })
    ) {
      try {
        this.writeSnapshot(undefined, "auto");
        this.writeSummary();
        this.changed();
      } catch (error) {
        this.remember(error);
      }
      this.fileChangedAt = undefined;
    }
    if (!this.status.visible) return;
    const running = await this.options.poeRunning();
    // The process query can outlive a quit; never touch the layer afterwards.
    if (this.disposed) return;
    if (!running) {
      this.status = { ...this.status, poeRunning: false };
      this.overlayHide();
      return;
    }
    if (this.legendShown && !this.options.overlay.isVisible(STASH_PRICES_PANEL)) {
      this.legendShown = false;
      this.overlayHide();
      return;
    }
    if ((ledger.newestAt ?? "") !== (this.overlayPlanLedgerAt ?? "")) {
      // Re-draw from the cached rectangle; a timer never spawns a host.
      await this.replan();
    }
  }
}
