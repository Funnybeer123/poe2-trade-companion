/**
 * The session service: owns the live session state, the files it persists,
 * the AFK / post-game recap and the death screenshots.
 *
 * WHY a service and not a pile of handlers: the interesting decisions are
 * about TIME (the game does not log its own exit, a run left in the hideout
 * is only over once nobody came back, a death screenshot must wait for the
 * death screen to draw). The reducer in src/core/sessionTracker.ts holds the
 * rules; this class decides when to run them, and every clock, timer, file
 * and capture is injected so the whole thing runs offline in tests.
 *
 * Safety: no game input, no network. The only outward effects are files
 * under userData, a Windows notification, and the overlay panel.
 */
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import type { ClientLogEvent } from "../../../core/clientLog.js";
import {
  DEFAULT_MAX_DEATH_SCREENSHOTS,
  deathCaptureId,
  deathFileNames,
  parseDeathIndex,
  pruneDeathPlan,
  serializeDeathCapture,
  type CaptureSkipReason,
  type DeathCapture,
} from "../../../core/sessionDeaths.js";
import {
  marketMovers,
  recommendations,
  stashGains,
  tradeEarnings,
  type HomeSignals,
  type MarketMovers,
  type StashGains,
  type TradeEarnings,
} from "../../../core/sessionHome.js";
import {
  parseSessionRecordLine,
  recentRuns,
  sanitizeSessionRecord,
  serializeSessionRecord,
  shouldPersist,
  stateForView,
  summarizeSession,
  MAX_HISTORY_SESSIONS,
  SESSION_RECORD_VERSION,
  type SessionRecord,
  type SessionSummary,
} from "../../../core/sessionHistory.js";
import {
  applyEvent,
  applyTick,
  currentCharacter,
  endSession,
  experienceHint,
  formatDuration,
  msBetween,
  newSessionId,
  sessionMetrics,
  setCharacterOverride,
  startSession,
  type DeathMark,
  type SessionEndReason,
  type SessionState,
} from "../../../core/sessionTracker.js";
import type { TrendReport } from "../../../core/priceTrends.js";
import type { ClientLogStatus } from "../../../shared/clientLog.js";
import type { HotkeyBindingView } from "../../../shared/hotkeys.js";
import type { OverlayShowOptions, OverlayState } from "../../../shared/overlay.js";
import {
  ACCOUNT_LINKED_STAT,
  SESSION_RECAP_PANEL_ID,
  type HomeOverview,
  type RecapMode,
  type SessionOverview,
  type SessionRecapPayload,
  type SessionRecordView,
  type SessionSettings,
} from "../../../shared/session.js";
import { DeathCapturer, CAPTURE_DELAY_MS } from "./deathCapture.js";
import { readStashFiles, type StashFilesCache, type StashFilesFs } from "./stashFiles.js";

export const SESSION_CURRENT_FILE = "session-current.json";
export const SESSION_HISTORY_FILE = "session-history.jsonl";
export const DEATHS_DIR = "deaths";
export const DEATHS_INDEX_FILE = "deaths.jsonl";

export const SNAPSHOT_EVERY_MS = 60_000;
/**
 * Consecutive polls without a Path of Exile process before the session may end
 * (four polls ≈ one minute). WHY not two: `ctx.poeWindows()` swallows every
 * failure of its PowerShell probe and returns an empty list, so "absent" and
 * "the probe broke" look identical. Ending a session is destructive (it
 * archives the run, notifies and splits the evening's maps/hour in two), so it
 * takes a longer streak — and, per `poeSeen`, a probe that has worked at least
 * once during this session.
 */
export const PROCESS_ABSENT_POLLS = 4;
export const LOG_SILENCE_BEFORE_END_MS = 120_000;
export const CHANGED_THROTTLE_MS = 500;
/** A resumable current-session file must be this fresh. */
export const RESUME_WINDOW_MS = 30 * 60_000;
/** While nothing is happening the process poll runs every fourth tick. */
export const IDLE_POLL_EVERY = 4;
export const IDLE_BEFORE_BACKOFF_MS = 10 * 60_000;
export const RECENT_RUNS_ON_HOME = 10;
export const RECENT_RUNS_IN_RECAP = 5;
/**
 * How many finished sessions stay fully parsed in memory. Older ones keep only
 * their summary; `historyGet` reads the one line it needs off disk. WHY: a full
 * history is 200 records of up to MAX_RECORD_BYTES each, and nothing but the
 * detail card ever looks at more than the newest few.
 */
export const EAGER_HISTORY_RECORDS = 25;

export interface SessionFs extends StashFilesFs {
  write(file: string, text: string): void;
  append(file: string, text: string): void;
  remove(file: string): void;
  mkdir(dir: string): void;
  list(dir: string): string[];
  writeBinary(file: string, bytes: Buffer): void;
  readBinary(file: string): Buffer | undefined;
}

export interface SessionTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface PriceFeedLike {
  status(): {
    resolvedLeague?: string;
    leagueAmbiguous: boolean;
    config: { league: string };
    feedEntryCount: number;
    feedAgeHours?: number;
  };
  hasSession(): boolean;
}

interface MarketTrendsLike {
  getTrends(query: { cachedOnly: true }): Promise<{
    ok: boolean;
    league?: string;
    fetchedAt?: string;
    stale: boolean;
    trends: TrendReport[];
    error?: string;
  }>;
}

interface OverlayLike {
  show(panelId: string, options?: OverlayShowOptions): Promise<void>;
  update(panelId: string, payload: unknown): void;
  hide(panelId: string): void;
  isVisible(panelId: string): boolean;
  state(): OverlayState;
}

export interface SessionServiceDeps {
  userDataDir: string;
  configDir: string;
  fs?: SessionFs;
  now?: () => Date;
  timers?: SessionTimers;
  settings: () => SessionSettings;
  clientLog: { status(): ClientLogStatus; recent(kind?: string, limit?: number): ClientLogEvent[] };
  overlay?: OverlayLike;
  hotkeys?: { list(): HotkeyBindingView[] };
  priceFeed: PriceFeedLike;
  marketTrends: MarketTrendsLike;
  poeRunning: () => Promise<boolean>;
  capturer?: DeathCapturer;
  /** Electron shell.openPath semantics: "" on success, the error text otherwise. */
  openPath: (target: string) => Promise<string>;
  emit(channel: "session:changed" | "session:recap" | "session:death", payload: unknown): void;
  notify(title: string, body: string): void;
  log(level: "info" | "warn" | "error", message: string, detail?: unknown): void;
}

export const realSessionFs: SessionFs = {
  exists: (file) => existsSync(file),
  read: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  stat: (file) => {
    try {
      const stat = statSync(file);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  },
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
  append: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, text, "utf8");
  },
  remove: (file) => {
    try {
      rmSync(file, { force: true });
    } catch {
      // Best effort: a file we cannot delete is not worth failing a session over.
    }
  },
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  writeBinary: (file, bytes) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  },
  readBinary: (file) => {
    try {
      return readFileSync(file);
    } catch {
      return undefined;
    }
  },
};

const realTimers: SessionTimers = {
  setInterval: (callback, ms) => {
    const handle: { unref?: () => void } = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => {
    const handle: { unref?: () => void } = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SessionService {
  private readonly fs: SessionFs;
  private readonly timers: SessionTimers;
  private readonly currentFile: string;
  private readonly historyFile: string;
  private readonly deathsDir: string;
  private readonly deathsIndexFile: string;

  private state: SessionState | undefined;
  /** One summary per archived session, oldest first. Bounded and small. */
  private summaries: SessionSummary[] = [];
  /** The newest EAGER_HISTORY_RECORDS records, oldest first. */
  private recentRecords: SessionRecord[] = [];
  private deathIndex: DeathCapture[] = [];
  private stashCache: StashFilesCache = {};
  private lastRecap: SessionRecapPayload | undefined;
  private lastError: string | undefined;

  private dirty = false;
  private lastSnapshotMs = 0;
  private absentPolls = 0;
  private poeDetected = false;
  /** The process probe returned the game at least once during this session. */
  private poeSeen = false;
  private tickCount = 0;
  private recapDismissedAt: string | undefined;
  private changeTimer: unknown;
  private changePending = false;
  private captureTimers = new Set<unknown>();
  private disposed = false;

  constructor(private readonly deps: SessionServiceDeps) {
    this.fs = deps.fs ?? realSessionFs;
    this.timers = deps.timers ?? realTimers;
    this.currentFile = path.join(deps.userDataDir, SESSION_CURRENT_FILE);
    this.historyFile = path.join(deps.userDataDir, SESSION_HISTORY_FILE);
    this.deathsDir = path.join(deps.userDataDir, DEATHS_DIR);
    this.deathsIndexFile = path.join(this.deathsDir, DEATHS_INDEX_FILE);
    this.loadHistory();
    this.loadDeathIndex();
    this.resumeOrArchive();
  }

  // -------------------------------------------------------------------------
  // Loading / persistence
  // -------------------------------------------------------------------------

  private nowDate(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }

  /** The history file split into its non-empty lines, oldest first. */
  private historyLines(): string[] {
    const text = this.fs.read(this.historyFile);
    return text ? text.split(/\r?\n/).filter((line) => line.trim().length > 0) : [];
  }

  /** Rebuild the bounded in-memory view from the lines on disk. */
  private ingestHistory(lines: readonly string[]): void {
    const summaries: SessionSummary[] = [];
    const recent: SessionRecord[] = [];
    for (const line of lines) {
      const record = parseSessionRecordLine(line);
      if (!record) continue;
      summaries.push(summarizeSession(record));
      recent.push(record);
      if (recent.length > EAGER_HISTORY_RECORDS) recent.shift();
    }
    this.summaries = summaries;
    this.recentRecords = recent;
  }

  private loadHistory(): void {
    this.ingestHistory(this.historyLines());
  }

  private loadDeathIndex(): void {
    const text = this.fs.read(this.deathsIndexFile);
    this.deathIndex = text ? parseDeathIndex(text) : [];
  }

  /** A fresh current-session file continues; an old one is archived as "app-quit". */
  private resumeOrArchive(): void {
    const text = this.fs.read(this.currentFile);
    if (!text) return;
    let record: SessionRecord | undefined;
    try {
      record = sanitizeSessionRecord(JSON.parse(text));
    } catch {
      record = undefined;
    }
    if (!record) {
      this.fs.remove(this.currentFile);
      return;
    }
    const now = this.nowIso();
    if (!record.state.endedAt && msBetween(record.savedAt, now) <= RESUME_WINDOW_MS) {
      this.state = record.state;
      this.deps.log("info", "resumed the previous session", { id: record.state.id });
      return;
    }
    const ended = record.state.endedAt
      ? record.state
      : endSession(record.state, record.savedAt, "app-quit");
    this.archive(ended, record.stash);
    this.fs.remove(this.currentFile);
  }

  private archive(state: SessionState, stash?: StashGains): void {
    const metrics = sessionMetrics(state, state.endedAt ?? this.nowIso());
    if (!shouldPersist(state, metrics)) return;
    const record: SessionRecord = {
      version: SESSION_RECORD_VERSION,
      state,
      metrics,
      ...(stash ? { stash } : {}),
      savedAt: this.nowIso(),
    };
    const line = serializeSessionRecord(record);
    try {
      if (this.summaries.length + 1 > MAX_HISTORY_SESSIONS) {
        // Over the cap: rewrite from the lines on disk instead of
        // re-serializing every record we would otherwise have to keep.
        const lines = [...this.historyLines(), line].slice(-MAX_HISTORY_SESSIONS);
        this.fs.write(this.historyFile, `${lines.join("\n")}\n`);
        this.ingestHistory(lines);
      } else {
        this.fs.append(this.historyFile, `${line}\n`);
        this.summaries.push(summarizeSession(record));
        this.recentRecords.push(record);
        if (this.recentRecords.length > EAGER_HISTORY_RECORDS) this.recentRecords.shift();
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "session history could not be written", this.lastError);
    }
  }

  private snapshot(force = false): void {
    if (!this.state || this.state.endedAt) return;
    const nowMs = this.nowDate().getTime();
    if (!force && (!this.dirty || nowMs - this.lastSnapshotMs < SNAPSHOT_EVERY_MS)) return;
    const record: SessionRecord = {
      version: SESSION_RECORD_VERSION,
      state: this.state,
      metrics: sessionMetrics(this.state, this.nowIso()),
      savedAt: this.nowIso(),
    };
    try {
      this.fs.write(this.currentFile, `${JSON.stringify(record, null, 2)}\n`);
      this.dirty = false;
      this.lastSnapshotMs = nowMs;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "current session could not be written", this.lastError);
    }
  }

  // -------------------------------------------------------------------------
  // Live events
  // -------------------------------------------------------------------------

  private ensureSession(at: string): void {
    if (this.state && !this.state.endedAt) return;
    const status = this.deps.clientLog.status();
    this.state = startSession(newSessionId(at), at, {
      ...(status.character ? { character: status.character } : {}),
      ...(status.area ? { area: status.area } : {}),
    });
    this.applyOverride();
    this.dirty = true;
  }

  private applyOverride(): void {
    if (!this.state) return;
    const override = this.deps.settings().characterOverride;
    this.state = setCharacterOverride(this.state, override, this.state.startedAt);
  }

  /** One live client-log event. Never throws: a bad line must not stop the tail. */
  handleEvent(event: ClientLogEvent): void {
    if (this.disposed || !event || typeof event !== "object") return;
    try {
      const at = typeof event.at === "string" ? event.at : this.nowIso();
      this.ensureSession(at);
      if (!this.state) return;
      const before = this.state;
      this.state = applyEvent(this.state, event);
      this.dirty = true;

      if (event.kind === "death") {
        this.snapshot(true);
        this.scheduleDeathCapture(this.state.deaths.at(-1));
      } else if (event.kind === "level-up") {
        this.snapshot(true);
      } else if (event.kind === "area" && this.state.runs.length !== before.runs.length) {
        this.snapshot(true);
      } else if (event.kind === "afk") {
        // The overlay call is async and CAN reject (the overlay window may be
        // torn down between ensureWindow() and send()). The catch above is
        // synchronous, so the rejection has to be caught on the promise or it
        // becomes an unhandled rejection — a fatal error in the main process.
        this.handleAfk(event.on).catch((error: unknown) => {
          this.deps.log("warn", "AFK recap failed", error);
        });
      }
      this.announce();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "session event failed", this.lastError);
    }
  }

  private async handleAfk(on: boolean): Promise<void> {
    const settings = this.deps.settings();
    if (!this.deps.overlay) return;
    if (on) {
      if (!settings.afkRecap) return;
      // Path of Exile re-emits "AFK mode is now ON." whenever the autoreply
      // text changes, so a panel the user already dismissed would pop back up.
      // The dismissal is cleared by AFK ending (below) or by an explicit
      // showRecap() — i.e. it holds until the NEXT AFK, as documented.
      if (this.recapDismissedAt) return;
      const payload = this.buildRecap("afk");
      if (!payload) return;
      await this.deps.overlay.show(SESSION_RECAP_PANEL_ID, {
        anchor: "center",
        pinned: false,
        focus: false,
        width: 380,
        height: 300,
        payload,
      });
      this.deps.emit("session:recap", payload);
    } else {
      this.recapDismissedAt = undefined;
      if (settings.afkRecapAutoClose) this.deps.overlay.hide(SESSION_RECAP_PANEL_ID);
    }
  }

  /** The overlay reports the user closed the panel: do not re-open it this AFK. */
  notePanelClosed(panelId: string): void {
    if (panelId === SESSION_RECAP_PANEL_ID) this.recapDismissedAt = this.nowIso();
  }

  applySettings(next: SessionSettings): void {
    if (this.state) {
      this.state = setCharacterOverride(this.state, next.characterOverride, this.nowIso());
      this.dirty = true;
    }
    if (!next.afkRecap && this.deps.overlay?.isVisible(SESSION_RECAP_PANEL_ID)) {
      this.deps.overlay.hide(SESSION_RECAP_PANEL_ID);
    }
    if (this.deathIndex.length > next.maxDeathScreenshots) this.pruneDeaths(next.maxDeathScreenshots);
    this.announce();
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /**
   * Process presence, run timeouts, the idle/exit end rules and the periodic
   * snapshot. The PowerShell-backed process probe is skipped on three of
   * every four ticks while nothing is happening (compliance recommendation).
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    this.tickCount += 1;
    const now = this.nowIso();
    const settings = this.deps.settings();

    const silentMs = this.state?.lastEventAt ? msBetween(this.state.lastEventAt, now) : Number.POSITIVE_INFINITY;
    const quiet = !this.state || silentMs > IDLE_BEFORE_BACKOFF_MS;
    const probe = !quiet || this.tickCount % IDLE_POLL_EVERY === 1;

    if (probe) {
      try {
        this.poeDetected = await this.deps.poeRunning();
      } catch {
        this.poeDetected = false;
      }
      if (this.poeDetected) {
        this.poeSeen = true;
        this.absentPolls = 0;
      } else {
        this.absentPolls += 1;
      }
    }
    if (this.disposed) return;

    if (!this.state && this.poeDetected) {
      this.ensureSession(now);
      this.announce();
    }

    if (this.state && !this.state.endedAt) {
      const ticked = applyTick(this.state, now);
      if (ticked !== this.state) {
        this.state = ticked;
        this.dirty = true;
        this.announce();
      }
      const silent = this.state.lastEventAt ? msBetween(this.state.lastEventAt, now) : msBetween(this.state.startedAt, now);
      // `poeSeen` keeps a broken probe (blocked execution policy, a busy
      // powershell.exe) from looking like the game exiting: if the process was
      // never once reported while this session ran, absence proves nothing and
      // only the much longer idle rule may end the session.
      if (
        !this.poeDetected &&
        this.poeSeen &&
        this.absentPolls >= PROCESS_ABSENT_POLLS &&
        silent >= LOG_SILENCE_BEFORE_END_MS
      ) {
        this.finishSession("game-exit");
      } else if (!this.poeDetected && silent >= settings.idleEndMinutes * 60_000) {
        this.finishSession("idle");
      }
    }
    this.snapshot();
  }

  private finishSession(reason: SessionEndReason): SessionOverview {
    if (!this.state) return this.overview();
    const now = this.nowIso();
    const ended = endSession(this.state, now, reason);
    const metrics = sessionMetrics(ended, now);
    const stash = this.stashForState(ended);
    this.state = ended;
    this.archive(ended, stash);
    this.fs.remove(this.currentFile);

    const settings = this.deps.settings();
    if (settings.postGameRecap) {
      const payload = this.buildRecap("full");
      if (payload) {
        this.lastRecap = payload;
        this.deps.emit("session:recap", payload);
        if (settings.postGameNotification) {
          const rate = metrics.mapsPerHour !== undefined ? `${metrics.mapsPerHour.toFixed(1)}/h · ` : "";
          this.deps.notify(
            "Session ended",
            `${metrics.mapsCompleted} maps · ${rate}${metrics.deaths} deaths · ${formatDuration(metrics.wallMs)}`,
          );
        }
      }
    }
    this.state = undefined;
    this.dirty = false;
    this.absentPolls = 0;
    this.poeSeen = false;
    this.announce(true);
    return this.overview();
  }

  endSession(reason: SessionEndReason = "manual"): SessionOverview {
    return this.finishSession(reason);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private announce(immediate = false): void {
    if (this.disposed) return;
    if (immediate) {
      if (this.changeTimer) this.timers.clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
      this.changePending = false;
      this.pushChange();
      return;
    }
    if (this.changeTimer) {
      this.changePending = true;
      return;
    }
    this.pushChange();
    this.changeTimer = this.timers.setTimeout(() => {
      this.changeTimer = undefined;
      if (this.changePending) {
        this.changePending = false;
        this.announce();
      }
    }, CHANGED_THROTTLE_MS);
  }

  private pushChange(): void {
    const overview = this.overview();
    this.deps.emit("session:changed", overview);
    if (this.deps.overlay?.isVisible(SESSION_RECAP_PANEL_ID)) {
      const payload = this.buildRecap(this.lastRecap?.mode ?? "afk");
      if (payload) this.deps.overlay.update(SESSION_RECAP_PANEL_ID, payload);
    }
  }

  overview(): SessionOverview {
    const now = this.nowIso();
    return {
      active: Boolean(this.state && !this.state.endedAt),
      poeDetected: this.poeDetected,
      ...(this.state ? { session: stateForView(this.state), metrics: sessionMetrics(this.state, now) } : {}),
      ...(this.state && currentCharacter(this.state) ? { character: currentCharacter(this.state) } : {}),
      ...(this.lastRecap ? { lastRecap: this.lastRecap } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      overlayAvailable: Boolean(this.deps.overlay),
      files: { current: this.currentFile, history: this.historyFile, deathsDir: this.deathsDir },
    };
  }

  /** One read of P6's and P3's files; re-parsed only when size or mtime moved. */
  private readFiles(): ReturnType<typeof readStashFiles> {
    const files = readStashFiles(
      this.fs,
      { userData: this.deps.userDataDir, config: this.deps.configDir },
      this.stashCache,
    );
    this.stashCache = files.cache;
    return files;
  }

  private stashForState(state: SessionState | undefined): StashGains {
    const files = this.readFiles();
    return stashGains({
      ...(files.summary ? { summary: files.summary } : {}),
      points: files.points,
      ...(state ? { sessionStartedAt: state.startedAt } : {}),
      now: this.nowIso(),
    });
  }

  private tradeForState(state: SessionState | undefined): TradeEarnings {
    return tradeEarnings(this.readFiles().trades, state?.startedAt);
  }

  private async movers(): Promise<MarketMovers> {
    try {
      const result = await this.deps.marketTrends.getTrends({ cachedOnly: true });
      return marketMovers({
        ok: result.ok,
        ...(result.league ? { league: result.league } : {}),
        ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
        stale: result.stale,
        trends: result.trends ?? [],
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (error) {
      return marketMovers({
        ok: false,
        stale: true,
        trends: [],
        error: error instanceof Error ? error.message : "The trends cache could not be read.",
      });
    }
  }

  private signals(status: ClientLogStatus): HomeSignals {
    const feed = this.deps.priceFeed.status();
    return {
      clientLog: {
        watching: status.watching,
        source: status.source,
        ...(status.file ? { file: status.file } : {}),
        ...(status.error ? { error: status.error } : {}),
      },
      poeDetected: this.poeDetected,
      priceFeed: {
        ...(feed.resolvedLeague ? { resolvedLeague: feed.resolvedLeague } : {}),
        leagueAmbiguous: feed.leagueAmbiguous,
        configLeague: feed.config.league,
        feedEntryCount: feed.feedEntryCount,
        ...(feed.feedAgeHours !== undefined ? { feedAgeHours: feed.feedAgeHours } : {}),
        hasSession: this.deps.priceFeed.hasSession(),
      },
      hotkeys: (this.deps.hotkeys?.list() ?? []).map((binding) => ({
        id: binding.id,
        accelerator: binding.accelerator,
        registered: binding.registered,
      })),
      overlayAvailable: Boolean(this.deps.overlay),
    };
  }

  async home(): Promise<HomeOverview> {
    const now = this.nowIso();
    const status = this.deps.clientLog.status();
    const state = this.state;
    const character = state ? currentCharacter(state) : undefined;
    const fallbackCharacter = status.character
      ? {
          name: status.character.name,
          className: status.character.className,
          level: status.character.level,
          seenAt: status.character.seenAt,
          source: "backfill" as const,
        }
      : undefined;
    const shown = character ?? fallbackCharacter;
    const stash = this.stashForState(state);
    const trade = this.tradeForState(state);
    const market = await this.movers();
    const signals = this.signals(status);
    const runs = recentRuns(this.recentRecords, state, RECENT_RUNS_ON_HOME);
    const deathsRecent = runs.slice(0, 3).reduce((sum, run) => sum + run.deaths, 0);

    const campaign = state?.campaign;
    const hint = experienceHint(shown?.level, campaign?.areaLevel);

    return {
      generatedAt: now,
      clientLog: {
        watching: status.watching,
        source: status.source,
        ...(status.file ? { file: status.file } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.lastLineAt ? { lastLineAt: status.lastLineAt } : {}),
      },
      ...(shown ? { character: shown } : {}),
      ...(state?.current
        ? {
            area: {
              areaId: state.current.areaId,
              name: state.current.name,
              category: state.current.category,
              level: state.current.level,
              enteredAt: state.current.enteredAt,
              ...(state.current.unverified ? { unverified: true } : {}),
            },
          }
        : {}),
      ...(campaign
        ? {
            campaign: {
              ...campaign,
              ...(hint.delta !== undefined ? { levelDelta: hint.delta } : {}),
              ...(hint.hint ? { hint: hint.hint } : {}),
              tone: hint.tone,
            },
          }
        : {}),
      session: this.overview(),
      recentMaps: runs,
      xpPerHour: ACCOUNT_LINKED_STAT,
      xpPerMap: ACCOUNT_LINKED_STAT,
      goldPerMap: ACCOUNT_LINKED_STAT,
      timeToLevel: ACCOUNT_LINKED_STAT,
      stash,
      trade,
      market,
      recommendations: recommendations({
        ...signals,
        ...(state ? { metrics: sessionMetrics(state, now) } : {}),
        stash,
        stashFileExists: this.readFiles().exists,
        market,
        recentRuns: runs,
        deathsRecent,
      }),
      deathsRecent,
    };
  }

  historyList(limit = 50): SessionSummary[] {
    const max = Math.min(500, Math.max(1, Math.round(limit)));
    return [...this.summaries]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, max);
  }

  /** The newest records are resident; an older one is read back line by line. */
  private findRecord(id: string): SessionRecord | undefined {
    const resident = this.recentRecords.find((entry) => entry.state.id === id);
    if (resident) return resident;
    for (const line of this.historyLines()) {
      if (!line.includes(id)) continue;
      const parsed = parseSessionRecordLine(line);
      if (parsed?.state.id === id) return parsed;
    }
    return undefined;
  }

  historyGet(id: string): SessionRecordView | undefined {
    if (!id) return undefined;
    const record = this.findRecord(id);
    if (!record) return undefined;
    return {
      version: SESSION_RECORD_VERSION,
      state: stateForView(record.state),
      metrics: record.metrics,
      ...(record.stash ? { stash: record.stash } : {}),
      savedAt: record.savedAt,
      summary: summarizeSession(record),
    };
  }

  historyDelete(id: string): SessionSummary[] {
    if (!id) return this.historyList();
    const lines = this.historyLines();
    const kept = lines.filter((line) => parseSessionRecordLine(line)?.state.id !== id);
    if (kept.length !== lines.length) {
      try {
        this.fs.write(this.historyFile, kept.length ? `${kept.join("\n")}\n` : "");
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      this.ingestHistory(kept);
    }
    return this.historyList();
  }

  // -------------------------------------------------------------------------
  // Recap
  // -------------------------------------------------------------------------

  buildRecap(mode: RecapMode): SessionRecapPayload | undefined {
    const state = this.state;
    if (!state) return this.lastRecap ? { ...this.lastRecap, mode } : undefined;
    const now = this.nowIso();
    const metrics = sessionMetrics(state, now);
    const record: SessionRecord = {
      version: SESSION_RECORD_VERSION,
      state,
      metrics,
      savedAt: now,
    };
    const character = currentCharacter(state);
    const hint = experienceHint(character?.level, state.campaign?.areaLevel);
    return {
      mode,
      at: now,
      summary: summarizeSession(record),
      metrics,
      ...(state.campaign
        ? {
            campaign: {
              ...state.campaign,
              ...(hint.delta !== undefined ? { levelDelta: hint.delta } : {}),
              ...(hint.hint ? { hint: hint.hint } : {}),
            },
          }
        : {}),
      stash: this.stashForState(state),
      trade: this.tradeForState(state),
      recentRuns: recentRuns([], state, RECENT_RUNS_IN_RECAP),
      trades: { ...state.trades },
      whispers: { ...state.whispers },
    };
  }

  async showRecap(mode: RecapMode): Promise<boolean> {
    if (!this.deps.overlay) return false;
    const payload = this.buildRecap(mode);
    if (!payload) return false;
    // The user asked for it explicitly, so an earlier dismissal no longer holds.
    this.recapDismissedAt = undefined;
    await this.deps.overlay.show(SESSION_RECAP_PANEL_ID, {
      anchor: "center",
      pinned: false,
      focus: false,
      width: 380,
      height: 300,
      payload,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Death screenshots
  // -------------------------------------------------------------------------

  private scheduleDeathCapture(mark: DeathMark | undefined): void {
    if (!mark || !this.deps.settings().deathScreenshots || !this.deps.capturer) return;
    const handle = this.timers.setTimeout(() => {
      this.captureTimers.delete(handle);
      this.captureNow("death", mark).catch((error: unknown) => {
        this.deps.log("warn", "death screenshot failed", error);
      });
    }, CAPTURE_DELAY_MS);
    this.captureTimers.add(handle);
  }

  async captureNow(
    kind: "death" | "manual" = "manual",
    mark?: DeathMark,
  ): Promise<DeathCapture | { skipped: CaptureSkipReason }> {
    const capturer = this.deps.capturer;
    if (!capturer) return { skipped: "no-source" };
    if (kind === "death" && !this.deps.settings().deathScreenshots) return { skipped: "disabled" };
    if (this.disposed) return { skipped: "busy" };
    const at = mark?.at ?? this.nowIso();
    const result = await capturer.capture();
    // The capture parks for up to two seconds (delay plus the black-frame
    // retry); the app may have been torn down meanwhile. Writing JPEGs and
    // rewriting deaths.jsonl on the way out is how a truncated index happens.
    if (this.disposed) return { skipped: "busy" };
    if (!result.ok) {
      if (result.reason === "black-frame") {
        this.lastError =
          "The screenshot came out black — Path of Exile blocks captures in exclusive fullscreen. Use borderless windowed.";
        this.deps.log("info", "death screenshot skipped", this.lastError);
      }
      this.announce();
      return { skipped: result.reason };
    }
    const areaId = mark?.areaId ?? this.state?.current?.areaId;
    const id = deathCaptureId(at, kind);
    const names = deathFileNames(id, areaId);
    const capture: DeathCapture = {
      id,
      at,
      kind,
      ...(mark?.character ?? this.state?.characters.at(-1)?.name
        ? { character: mark?.character ?? this.state?.characters.at(-1)?.name }
        : {}),
      ...(areaId ? { areaId } : {}),
      ...(mark?.areaName ?? this.state?.current?.name
        ? { areaName: mark?.areaName ?? this.state?.current?.name }
        : {}),
      ...(this.state?.current?.level ? { areaLevel: this.state.current.level } : {}),
      ...(mark?.runId ? { runId: mark.runId } : {}),
      file: names.file,
      thumbFile: names.thumbFile,
      width: result.width,
      height: result.height,
      bytes: result.jpeg.length,
      sourceName: result.sourceName,
    };
    try {
      this.fs.mkdir(this.deathsDir);
      this.fs.writeBinary(path.join(this.deathsDir, names.file), result.jpeg);
      this.fs.writeBinary(path.join(this.deathsDir, names.thumbFile), result.thumbJpeg);
      this.fs.append(this.deathsIndexFile, `${serializeDeathCapture(capture)}\n`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "death screenshot could not be written", this.lastError);
      return { skipped: "write-failed" };
    }
    this.deathIndex.push(capture);
    this.pruneDeaths(this.deps.settings().maxDeathScreenshots);
    if (mark && this.state) {
      const index = this.state.deaths.findIndex((entry) => entry.at === mark.at);
      if (index >= 0) {
        const deaths = [...this.state.deaths];
        deaths[index] = { ...deaths[index], captureId: capture.id };
        this.state = { ...this.state, deaths };
        this.dirty = true;
        this.snapshot(true);
      }
    }
    this.deps.emit("session:death", capture);
    this.announce();
    return capture;
  }

  private pruneDeaths(max: number): void {
    const plan = pruneDeathPlan(this.deathIndex, max || DEFAULT_MAX_DEATH_SCREENSHOTS);
    if (plan.remove.length === 0) {
      this.deathIndex = plan.keep;
      return;
    }
    for (const capture of plan.remove) {
      this.fs.remove(path.join(this.deathsDir, capture.file));
      this.fs.remove(path.join(this.deathsDir, capture.thumbFile));
    }
    this.deathIndex = plan.keep;
    this.rewriteDeathIndex();
  }

  private rewriteDeathIndex(): void {
    try {
      this.fs.write(
        this.deathsIndexFile,
        this.deathIndex.length
          ? `${this.deathIndex.map((entry) => serializeDeathCapture(entry)).join("\n")}\n`
          : "",
      );
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  deaths(limit = 50): DeathCapture[] {
    const max = Math.min(500, Math.max(1, Math.round(limit)));
    return [...this.deathIndex].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
  }

  /** The full file path, only when it really sits inside the deaths folder. */
  private resolveInsideDeaths(name: string): string | undefined {
    const resolved = path.resolve(this.deathsDir, name);
    const root = path.resolve(this.deathsDir);
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
  }

  deathThumbnail(id: string): string | undefined {
    const capture = this.deathIndex.find((entry) => entry.id === id);
    if (!capture) return undefined;
    const file = this.resolveInsideDeaths(capture.thumbFile);
    if (!file) return undefined;
    const bytes = this.fs.readBinary(file);
    if (!bytes) return undefined;
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }

  async deathOpen(id: string): Promise<boolean> {
    const capture = this.deathIndex.find((entry) => entry.id === id);
    if (!capture) return false;
    const file = this.resolveInsideDeaths(capture.file);
    if (!file || !this.fs.exists(file)) return false;
    const error = await this.deps.openPath(file);
    if (error) this.deps.log("warn", "screenshot could not be opened", error);
    return error === "";
  }

  deathDelete(id: string): DeathCapture[] {
    const capture = this.deathIndex.find((entry) => entry.id === id);
    if (capture) {
      const file = this.resolveInsideDeaths(capture.file);
      const thumb = this.resolveInsideDeaths(capture.thumbFile);
      if (file) this.fs.remove(file);
      if (thumb) this.fs.remove(thumb);
      this.deathIndex = this.deathIndex.filter((entry) => entry.id !== id);
      this.rewriteDeathIndex();
    }
    return this.deaths();
  }

  async openDeathsFolder(): Promise<boolean> {
    this.fs.mkdir(this.deathsDir);
    const error = await this.deps.openPath(this.deathsDir);
    return error === "";
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.captureTimers) this.timers.clearTimeout(handle);
    this.captureTimers.clear();
    if (this.changeTimer) this.timers.clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    if (this.state && !this.state.endedAt) {
      const ended = endSession(this.state, this.nowIso(), "app-quit");
      this.state = ended;
      this.archive(ended, this.stashForState(ended));
      this.fs.remove(this.currentFile);
      this.state = undefined;
    }
  }
}
