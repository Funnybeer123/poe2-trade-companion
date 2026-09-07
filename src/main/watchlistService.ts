/**
 * Deals watchlist service: re-runs the user's watches against trade2 on a
 * timer, appends the underpriced listings it finds to an alert log, and
 * raises an OS notification for each new one.
 *
 * Budget etiquette (the shop flow and price checks share the same trade2
 * budget through priceFeedService):
 *   - ticks every 30 s while the master switch is on, never more than ONE
 *     scan per tick (one search + one fetch), scheduled scans at least
 *     60 s apart and at most 5 per rolling 5 minutes (unlisted trade2
 *     lockout layer — see MAX_SCANS_PER_5_MIN);
 *   - scans only when the pacer has at least 3 spare lookups, so a bag
 *     listing run always has headroom;
 *   - a global cap of 20 scans per hour (persisted, so a restart cannot
 *     double-spend);
 *   - nothing runs while trade2 has us in a penalty window.
 *
 * Files (configDir = artifacts/tab-admin, shared with the CLIs):
 *   watchlist.json     — watches, master switch, settings, dismissals
 *   deal-alerts.jsonl  — append-only alert history (the dedupe source)
 *
 * Decision support only: an alert's whisper is copied to the clipboard on
 * request. The app never sends a whisper, buys, or lists.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PriceTable } from "../core/priceTable.js";
import type { StatCatalogue } from "../core/statIds.js";
import {
  alertBody,
  alertTitle,
  buildWatchQuery,
  evaluateWatch,
  nextScanEtaMs,
  parseDealAlerts,
  parseWatchlist,
  sanitizeWatches,
  scheduleNextWatch,
  seenAsks,
  serializeDealAlert,
  serializeWatchlist,
  summarizeWatch,
  WATCH_SAMPLE_SIZE,
  type DealAlert,
  type Watch,
  type WatchlistFile,
} from "../core/watchlist.js";
import type {
  WatchlistOverviewView,
  WatchlistSaveRequest,
  WatchlistScanOutcome,
} from "../shared/ipc.js";
import type { SearchListingsResult } from "./priceFeedService.js";

export type WatchlistOverview = WatchlistOverviewView;
export type WatchlistSavePayload = WatchlistSaveRequest;
export type ScanOutcome = WatchlistScanOutcome;

export const WATCHLIST_FILE = "watchlist.json";
export const DEAL_ALERTS_FILE = "deal-alerts.jsonl";
const TICK_MS = 30_000;
/** Spare lookups the pacer must show before a scheduled scan goes out. */
const MIN_SPARE_LOOKUPS = 3;
const MAX_SCANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;
/**
 * trade2 has an unlisted lockout layer above the advertised rules (a 429
 * with Retry-After 600 landed around 25 calls in 5 minutes on 2026-09-07,
 * with the advertised windows far from full). A scan is one search + one
 * fetch, so five scans per five minutes keeps the watchlist at ten calls
 * and leaves room for the shop flow and manual price checks.
 */
const MAX_SCANS_PER_5_MIN = 5;
const FIVE_MIN_MS = 5 * 60_000;
/** Scheduled scans never run back to back; a manual "Scan now" may. */
const MIN_SCHEDULED_GAP_MS = 60_000;
/** Alerts the overview returns, newest first. */
const OVERVIEW_ALERTS = 50;

/** The slice of PriceFeedService the watchlist needs (a test seam). */
export interface WatchlistFeed {
  searchListings: (
    body: Record<string, unknown>,
    options?: { limit?: number },
  ) => Promise<SearchListingsResult>;
  tradeBudget: () => { lookups: number; restrictedUntilIso?: string };
  rateLimitedUntilIso: () => string | undefined;
  fetchStats: () => Promise<StatCatalogue | undefined>;
}

export interface WatchlistServiceOptions {
  configDir: string;
  feed: WatchlistFeed;
  getPriceTable: () => PriceTable;
  now?: () => Date;
  /** OS notification sink; absent in tests and headless runs. */
  notify?: (notification: { title: string; body: string }) => void;
  /** Clipboard sink for copyWhisper. */
  writeClipboard?: (text: string) => void;
  /** Test seam: scheduler period (default 30 s). */
  tickMs?: number;
  /** Test seam: do not arm the interval timer. */
  manualTicks?: boolean;
}

export class WatchlistService {
  private state: WatchlistFile;
  private alerts: DealAlert[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning: Promise<ScanOutcome> | undefined;
  private lastError: string | undefined;
  private lastSkip: string | undefined;

  constructor(private readonly options: WatchlistServiceOptions) {
    this.state = this.loadState();
    this.alerts = this.loadAlerts();
    this.armTimer();
  }

  // ---- files ---------------------------------------------------------------

  private watchlistFile(): string {
    return path.join(this.options.configDir, WATCHLIST_FILE);
  }

  private alertsFile(): string {
    return path.join(this.options.configDir, DEAL_ALERTS_FILE);
  }

  private loadState(): WatchlistFile {
    try {
      const file = this.watchlistFile();
      return parseWatchlist(existsSync(file) ? readFileSync(file, "utf8") : undefined);
    } catch {
      return parseWatchlist(undefined);
    }
  }

  private persistState(): void {
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      writeFileSync(this.watchlistFile(), serializeWatchlist(this.state));
    } catch (error) {
      this.lastError = `watchlist.json could not be written: ${message(error)}`;
    }
  }

  private loadAlerts(): DealAlert[] {
    try {
      const file = this.alertsFile();
      return parseDealAlerts(existsSync(file) ? readFileSync(file, "utf8") : undefined);
    } catch {
      return [];
    }
  }

  private appendAlerts(alerts: readonly DealAlert[]): void {
    if (alerts.length === 0) return;
    this.alerts.push(...alerts);
    try {
      mkdirSync(this.options.configDir, { recursive: true });
      appendFileSync(
        this.alertsFile(),
        alerts.map((alert) => `${serializeDealAlert(alert)}\n`).join(""),
      );
    } catch (error) {
      this.lastError = `deal-alerts.jsonl could not be appended: ${message(error)}`;
    }
  }

  // ---- clock + scheduler ---------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private armTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.options.manualTicks || !this.state.enabled) return;
    this.timer = setInterval(
      () => void this.tick().catch((error) => (this.lastError = message(error))),
      this.options.tickMs ?? TICK_MS,
    );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private pruneScanLog(nowMs: number): void {
    this.state.scanLog = this.state.scanLog.filter((at) => at <= nowMs && nowMs - at < HOUR_MS);
  }

  private scansInLast(windowMs: number): number {
    const nowMs = this.now().getTime();
    return this.state.scanLog.filter((at) => at <= nowMs && nowMs - at < windowMs).length;
  }

  private msSinceLastScan(): number | undefined {
    if (this.state.scanLog.length === 0) return undefined;
    return this.now().getTime() - Math.max(...this.state.scanLog);
  }

  private scansThisHour(): number {
    this.pruneScanLog(this.now().getTime());
    return this.state.scanLog.length;
  }

  /**
   * One scheduler beat: at most one scan, and only when the budget, the
   * hourly cap and the penalty window all allow it. Public so tests (and a
   * manual "tick now") can drive it without timers.
   */
  async tick(): Promise<ScanOutcome> {
    if (!this.state.enabled) return this.skip("watchlist is off");
    if (this.scanning) return this.skip("a scan is already running");
    const restricted = this.options.feed.rateLimitedUntilIso();
    if (restricted) {
      return this.skip(`trade2 penalty window until ${new Date(restricted).toLocaleTimeString()}`);
    }
    if (this.scansThisHour() >= MAX_SCANS_PER_HOUR) {
      return this.skip(`hourly cap reached (${MAX_SCANS_PER_HOUR} scans)`);
    }
    if (this.scansInLast(FIVE_MIN_MS) >= MAX_SCANS_PER_5_MIN) {
      return this.skip(`5-minute cap reached (${MAX_SCANS_PER_5_MIN} scans) — trade2 locks out above ~25 calls per 5 min`);
    }
    const sinceLast = this.msSinceLastScan();
    if (sinceLast !== undefined && sinceLast < MIN_SCHEDULED_GAP_MS) {
      return this.skip(`last scan ${Math.round(sinceLast / 1000)}s ago — scheduled scans stay ${MIN_SCHEDULED_GAP_MS / 1000}s apart`);
    }
    const budget = this.options.feed.tradeBudget();
    if (budget.lookups < MIN_SPARE_LOOKUPS) {
      return this.skip(
        `${budget.lookups} trade2 lookup${budget.lookups === 1 ? "" : "s"} spare — waiting for ${MIN_SPARE_LOOKUPS}`,
      );
    }
    const watch = scheduleNextWatch(this.state.watches, this.now());
    if (!watch) return this.skip("no watch is due");
    this.lastSkip = undefined;
    return this.runScan(watch);
  }

  private skip(reason: string): ScanOutcome {
    this.lastSkip = reason;
    return { ok: false, newAlerts: 0, skipped: reason };
  }

  /**
   * The button: scan one watch now (or the most overdue enabled one),
   * ignoring its interval but never the penalty window or the hourly cap.
   * A deliberate click may use the last spare lookup.
   */
  async scanNow(watchId?: string): Promise<ScanOutcome> {
    if (this.scanning) return this.skip("a scan is already running");
    const restricted = this.options.feed.rateLimitedUntilIso();
    if (restricted) {
      return this.skip(`trade2 penalty window until ${new Date(restricted).toLocaleTimeString()}`);
    }
    if (this.scansThisHour() >= MAX_SCANS_PER_HOUR) {
      return this.skip(`hourly cap reached (${MAX_SCANS_PER_HOUR} scans)`);
    }
    if (this.scansInLast(FIVE_MIN_MS) >= MAX_SCANS_PER_5_MIN) {
      return this.skip(`5-minute cap reached (${MAX_SCANS_PER_5_MIN} scans) — trade2 locks out above ~25 calls per 5 min`);
    }
    if (this.options.feed.tradeBudget().lookups < 1) return this.skip("no trade2 lookup spare right now");
    const watch = watchId
      ? this.state.watches.find((entry) => entry.id === watchId)
      : (scheduleNextWatch(this.state.watches, this.now()) ?? this.mostOverdue());
    if (!watch) return this.skip(watchId ? "that watch no longer exists" : "no watch to scan");
    this.lastSkip = undefined;
    return this.runScan(watch);
  }

  private mostOverdue(): Watch | undefined {
    let best: Watch | undefined;
    for (const watch of this.state.watches) {
      if (!watch.enabled) continue;
      const last = watch.lastScanAt ? Date.parse(watch.lastScanAt) : 0;
      const bestLast = best?.lastScanAt ? Date.parse(best.lastScanAt) : 0;
      if (!best || last < bestLast) best = watch;
    }
    return best;
  }

  private runScan(watch: Watch): Promise<ScanOutcome> {
    const run = this.scan(watch).finally(() => {
      this.scanning = undefined;
    });
    this.scanning = run;
    return run;
  }

  private async scan(watch: Watch): Promise<ScanOutcome> {
    const now = this.now();
    const stamp = (): void => {
      watch.lastScanAt = now.toISOString();
    };
    const statIds = watch.kind === "stat-filtered" ? await this.options.feed.fetchStats() : undefined;
    const body = buildWatchQuery(watch, statIds);
    if (!body) {
      // Never spin on a watch that cannot be expressed: stamp it and report.
      stamp();
      this.persistState();
      this.lastError =
        watch.kind === "stat-filtered" && !statIds
          ? `"${watch.label}": the trade2 stats catalogue is unavailable — try again later`
          : `"${watch.label}" cannot be turned into a trade2 search — edit its fields`;
      return { ok: false, watchId: watch.id, label: watch.label, newAlerts: 0, error: this.lastError };
    }
    // The scan counts the moment it goes out, whatever comes back.
    this.pruneScanLog(now.getTime());
    this.state.scanLog.push(now.getTime());
    stamp();
    let result: SearchListingsResult;
    try {
      result = await this.options.feed.searchListings(body, { limit: WATCH_SAMPLE_SIZE });
    } catch (error) {
      result = { ok: false, listings: [], error: message(error) };
    }
    if (!result.ok) {
      this.persistState();
      this.lastError = `"${watch.label}": ${result.error ?? "trade2 search failed"}`;
      return { ok: false, watchId: watch.id, label: watch.label, newAlerts: 0, error: this.lastError };
    }
    const priceTable = this.options.getPriceTable();
    const summary = summarizeWatch(watch, result.listings, { priceTable });
    if (summary.referenceExalted !== undefined) watch.lastReferenceExalted = summary.referenceExalted;
    const alerts = evaluateWatch(watch, result.listings, {
      priceTable,
      seen: seenAsks(this.alerts),
      now,
    });
    this.appendAlerts(alerts);
    this.persistState();
    this.lastError = undefined;
    if (this.state.notifications && this.options.notify) {
      for (const alert of alerts) {
        try {
          this.options.notify({ title: alertTitle(alert), body: alertBody(alert, watch) });
        } catch {
          // A notification that cannot show is not a scan failure.
        }
      }
    }
    return {
      ok: true,
      watchId: watch.id,
      label: watch.label,
      sample: summary.sample,
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(summary.referenceExalted !== undefined ? { referenceExalted: summary.referenceExalted } : {}),
      ...(summary.referenceBasis ? { referenceBasis: summary.referenceBasis } : {}),
      newAlerts: alerts.length,
    };
  }

  // ---- IPC surface ---------------------------------------------------------

  overview(): WatchlistOverview {
    const now = this.now();
    const dismissed = new Set(this.state.dismissed);
    const alerts = [...this.alerts]
      .reverse()
      .filter((alert) => !dismissed.has(alert.id))
      .slice(0, OVERVIEW_ALERTS);
    const lastScanAt = this.state.watches
      .map((watch) => watch.lastScanAt)
      .filter((at): at is string => typeof at === "string")
      .sort()
      .at(-1);
    const eta = this.state.enabled ? nextScanEtaMs(this.state.watches, now) : undefined;
    return {
      enabled: this.state.enabled,
      notifications: this.state.notifications,
      watches: this.state.watches.map((watch) => ({ ...watch, query: { ...watch.query } })),
      alerts,
      budget: this.options.feed.tradeBudget(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastSkip ? { lastSkip: this.lastSkip } : {}),
      ...(lastScanAt ? { lastScanAt } : {}),
      ...(eta !== undefined ? { nextScanEtaMs: eta } : {}),
      scansThisHour: this.scansThisHour(),
      maxScansPerHour: MAX_SCANS_PER_HOUR,
      scanning: this.scanning !== undefined,
      files: { watchlist: this.watchlistFile(), alerts: this.alertsFile() },
    };
  }

  /**
   * Replace the list and settings. Scan bookkeeping (lastScanAt, last
   * reference) is kept from the current state when the payload omits it,
   * so an edit never resets a watch's schedule.
   */
  save(payload: WatchlistSavePayload): WatchlistOverview {
    const incoming = payload.watches === undefined ? this.state.watches : sanitizeWatches(payload.watches);
    const current = new Map(this.state.watches.map((watch) => [watch.id, watch] as const));
    this.state.watches = incoming.map((watch) => {
      const previous = current.get(watch.id);
      if (!previous) return watch;
      return {
        ...watch,
        ...(watch.lastScanAt === undefined && previous.lastScanAt ? { lastScanAt: previous.lastScanAt } : {}),
        ...(watch.lastReferenceExalted === undefined && previous.lastReferenceExalted !== undefined
          ? { lastReferenceExalted: previous.lastReferenceExalted }
          : {}),
      };
    });
    if (typeof payload.enabled === "boolean") this.state.enabled = payload.enabled;
    if (typeof payload.notifications === "boolean") this.state.notifications = payload.notifications;
    if (!this.state.enabled) this.lastSkip = undefined;
    this.persistState();
    this.armTimer();
    return this.overview();
  }

  /** Put an alert's whisper on the clipboard. Nothing is sent anywhere. */
  copyWhisper(alertId: string): { ok: boolean; error?: string } {
    const alert = this.alerts.find((entry) => entry.id === alertId);
    if (!alert) return { ok: false, error: "That alert is no longer in the log." };
    if (!alert.whisper) return { ok: false, error: "This listing came without a whisper." };
    if (!this.options.writeClipboard) return { ok: false, error: "No clipboard is available." };
    try {
      this.options.writeClipboard(alert.whisper);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  dismiss(alertId: string): WatchlistOverview {
    if (alertId && !this.state.dismissed.includes(alertId)) {
      this.state.dismissed.push(alertId);
      this.persistState();
    }
    return this.overview();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
