/**
 * Pure aggregation for the Home dashboard: stash gains, market movers,
 * trade earnings and the recommended-next-actions list.
 *
 * WHY it is pure and file-shaped: every number on Home comes from a file
 * another package already wrote (P6's stash tracker, P3's trade history,
 * MarketTrendsService's cache). Home never fetches and never writes — it
 * parses tolerantly, labels everything as an estimate, and links to the
 * paced tool when the data is stale. The setup checklist is NOT here: P10
 * owns it and Home calls `app:setup-checklist` for it.
 */
import type { TrendReport } from "./priceTrends.js";
import type { MapRun, SessionMetrics } from "./sessionTracker.js";

/** Same threshold as src/renderer/utils/readiness.ts (renderer utils cannot be imported into main). */
export const FEED_STALE_AFTER_HOURS = 36;
/** Used only when neither the summary nor a snapshot carries a divine rate. */
export const FALLBACK_DIVINE_RATE = 405;

// ---------------------------------------------------------------------------
// P6 (stash tracker) files — read-only
// ---------------------------------------------------------------------------

/** One snapshot reference inside P6's summary file. */
export interface StashSummaryPoint {
  id?: string;
  at: string;
  kind?: string;
  totalExalted: number;
  ledgerAt?: string;
}

/** The subset of P6's tracker summary file Home reads. Extra fields are ignored. */
export interface StashSummaryFile {
  version?: number;
  updatedAt?: string;
  sessionId?: string;
  divineRate?: number;
  sessionStart?: StashSummaryPoint;
  latest?: StashSummaryPoint;
  sessionGainExalted?: number;
  sessionGainDivine?: number;
  snapshotCount?: number;
  excludedCount?: number;
}

export type StashSnapshotKind = "manual" | "auto" | "session-start";

/** The subset of a P6 snapshot journal line Home reads. */
export interface StashSnapshotPoint {
  id?: string;
  at: string;
  kind?: StashSnapshotKind;
  label?: string;
  totalExalted: number;
  totalDivine?: number;
  divineRate?: number;
}

export interface StashGains {
  available: boolean;
  reason?: string;
  source?: "session-file" | "snapshots";
  baselineAt?: string;
  baselineExalted?: number;
  latestAt?: string;
  latestExalted?: number;
  deltaExalted?: number;
  deltaDivine?: number;
  divineRate?: number;
  /**
   * True when `divineRate` is FALLBACK_DIVINE_RATE because neither the tracker
   * summary nor any snapshot carried one. The divine figure is then a guess
   * and the UI must say so: real rates move by hundreds of exalted a league.
   */
  rateAssumed?: boolean;
  perHourExalted?: number;
  snapshots: number;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// P3 (trade) history — read-only
// ---------------------------------------------------------------------------

export interface TradeHistoryPoint {
  at: string;
  kind: "sale" | "purchase" | "unknown";
  exalted?: number;
}

export interface TradeEarnings {
  available: boolean;
  reason?: string;
  sales: number;
  purchases: number;
  earnedExalted: number;
  spentExalted: number;
  netExalted: number;
  /** True when some entries carried no exalted price (the totals are partial). */
  partial: boolean;
  /**
   * Which period the totals cover. "session" = since the running session
   * started; "all" = every trade still in the trade package's file (it keeps
   * two weeks). The UI MUST print this: the same card otherwise means two very
   * different things depending on whether the game is open.
   */
  window: "session" | "all";
  /** The session start the totals are counted from, when `window` is "session". */
  sinceIso?: string;
}

// ---------------------------------------------------------------------------
// Market movers (MarketTrendsService cache only — never a fetch)
// ---------------------------------------------------------------------------

export interface MoverView {
  key: string;
  name: string;
  current: number;
  change3d?: number;
  change7d?: number;
  volume7d: number;
  sampleSize: number;
  direction: "rising" | "falling" | "stable";
}

export interface MarketMovers {
  available: boolean;
  reason?: string;
  league?: string;
  fetchedAt?: string;
  stale: boolean;
  rising: MoverView[];
  falling: MoverView[];
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** What Home knows about the foundations; the checklist itself comes from P10. */
export interface HomeSignals {
  clientLog: { watching: boolean; source: string; file?: string; error?: string };
  poeDetected: boolean;
  priceFeed: {
    resolvedLeague?: string;
    leagueAmbiguous: boolean;
    configLeague: string;
    feedEntryCount: number;
    feedAgeHours?: number;
    hasSession: boolean;
  };
  hotkeys: Array<{ id: string; accelerator: string | null; registered: boolean }>;
  overlayAvailable: boolean;
}

export interface RecommendationInput extends HomeSignals {
  metrics?: SessionMetrics;
  stash: StashGains;
  stashFileExists: boolean;
  market: MarketMovers;
  recentRuns: MapRun[];
  deathsRecent: number;
}

export interface HomeRecommendation {
  id: string;
  title: string;
  detail: string;
  route: string;
  tone: "info" | "warning";
}

export const MAX_RECOMMENDATIONS = 5;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function obj(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function finite(raw: unknown): number | undefined {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isoAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return Number.isFinite(Date.parse(raw)) ? raw : undefined;
}

function text(raw: unknown, max = 80): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** P6's summary file; anything that is not one → undefined (never throws). */
export function parseStashSummaryFile(text_: string): StashSummaryFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text_);
  } catch {
    return undefined;
  }
  const source = obj(parsed);
  if (!source) return undefined;
  const point = (raw: unknown): StashSummaryPoint | undefined => {
    const entry = obj(raw);
    if (!entry) return undefined;
    const at = isoAt(entry.at);
    const totalExalted = finite(entry.totalExalted);
    if (!at || totalExalted === undefined) return undefined;
    return {
      ...(text(entry.id, 60) ? { id: text(entry.id, 60) } : {}),
      at,
      ...(text(entry.kind, 20) ? { kind: text(entry.kind, 20) } : {}),
      totalExalted,
      ...(isoAt(entry.ledgerAt) ? { ledgerAt: isoAt(entry.ledgerAt) } : {}),
    };
  };
  const start = point(source.sessionStart);
  const latest = point(source.latest);
  const file: StashSummaryFile = {
    ...(finite(source.version) !== undefined ? { version: finite(source.version) } : {}),
    ...(isoAt(source.updatedAt) ? { updatedAt: isoAt(source.updatedAt) } : {}),
    ...(text(source.sessionId, 80) ? { sessionId: text(source.sessionId, 80) } : {}),
    ...(finite(source.divineRate) !== undefined ? { divineRate: finite(source.divineRate) } : {}),
    ...(start ? { sessionStart: start } : {}),
    ...(latest ? { latest } : {}),
    ...(finite(source.sessionGainExalted) !== undefined
      ? { sessionGainExalted: finite(source.sessionGainExalted) }
      : {}),
    ...(finite(source.sessionGainDivine) !== undefined
      ? { sessionGainDivine: finite(source.sessionGainDivine) }
      : {}),
    ...(finite(source.snapshotCount) !== undefined ? { snapshotCount: finite(source.snapshotCount) } : {}),
    ...(finite(source.excludedCount) !== undefined ? { excludedCount: finite(source.excludedCount) } : {}),
  };
  // Nothing usable at all (no baseline, no latest, no gain) is not a summary.
  if (!file.sessionStart && !file.latest && file.sessionGainExalted === undefined) return undefined;
  return file;
}

/** Tolerant JSONL: a point needs `at` and `totalExalted`; everything else is optional. */
export function parseStashSnapshotPoints(text_: string): StashSnapshotPoint[] {
  const out: StashSnapshotPoint[] = [];
  for (const line of text_.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const source = obj(JSON.parse(line));
      if (!source) continue;
      const at = isoAt(source.at);
      const totalExalted = finite(source.totalExalted);
      if (!at || totalExalted === undefined) continue;
      const kind = text(source.kind, 20);
      out.push({
        ...(text(source.id, 60) ? { id: text(source.id, 60) } : {}),
        at,
        ...(kind === "manual" || kind === "auto" || kind === "session-start" ? { kind } : {}),
        ...(text(source.label, 80) ? { label: text(source.label, 80) } : {}),
        totalExalted,
        ...(finite(source.totalDivine) !== undefined ? { totalDivine: finite(source.totalDivine) } : {}),
        ...(finite(source.divineRate) !== undefined ? { divineRate: finite(source.divineRate) } : {}),
      });
    } catch {
      // Torn line: skip.
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** P3's trade-history.json → the points the recap sums. Never throws. */
export function parseTradeHistoryPoints(text_: string): TradeHistoryPoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text_);
  } catch {
    return [];
  }
  const source = obj(parsed);
  const entries = Array.isArray(source?.entries) ? (source?.entries as unknown[]) : [];
  const out: TradeHistoryPoint[] = [];
  for (const raw of entries.slice(-5_000)) {
    const entry = obj(raw);
    if (!entry) continue;
    const at = isoAt(entry.at);
    if (!at) continue;
    const kindText = text(entry.kind, 20);
    const price = obj(entry.price);
    const exalted = price ? finite(price.exalted) : undefined;
    out.push({
      at,
      kind: kindText === "sale" || kindText === "purchase" ? kindText : "unknown",
      ...(exalted !== undefined ? { exalted } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Stash gains since the session started. P6's summary file wins when it has
 * a session in it (it is the tracker's own answer); the snapshot journal is
 * the fallback so Home still shows something after a summary rewrite.
 *
 * WHY the guard is `sessionStart && latest` and not "the gain field exists":
 * the stash tracker rewrites its summary on every app launch and ALWAYS emits
 * `sessionGainExalted` — zero when no session has been started. Trusting that
 * field would make "you never started a stash session" render as a confident
 * "+0 ex" and would hide both the snapshot fallback and the recommendation
 * that tells the user to start one. Only `sessionStart` proves a baseline.
 */
export function stashGains(input: {
  summary?: StashSummaryFile;
  points: readonly StashSnapshotPoint[];
  sessionStartedAt?: string;
  now: string;
}): StashGains {
  const { summary, points, sessionStartedAt, now } = input;
  const nowMs = Date.parse(now);

  if (summary?.sessionStart && summary.latest) {
    const baselineAt = summary.sessionStart.at;
    const baselineExalted = summary.sessionStart.totalExalted;
    const latestExalted = summary.latest.totalExalted;
    const delta =
      summary.sessionGainExalted ??
      (latestExalted !== undefined && baselineExalted !== undefined
        ? Math.round((latestExalted - baselineExalted) * 100) / 100
        : undefined);
    const rate = summary.divineRate;
    const deltaDivine =
      summary.sessionGainDivine ??
      (delta !== undefined && rate && rate > 0 ? Math.round((delta / rate) * 100) / 100 : undefined);
    const elapsedMs = Number.isFinite(nowMs) ? Math.max(0, nowMs - Date.parse(baselineAt)) : 0;
    const perHour =
      delta !== undefined && elapsedMs > 60_000
        ? Math.round((delta / (elapsedMs / 3_600_000)) * 100) / 100
        : undefined;
    return {
      available: true,
      source: "session-file",
      baselineAt,
      baselineExalted,
      latestAt: summary.latest.at,
      latestExalted,
      ...(delta !== undefined ? { deltaExalted: delta } : {}),
      ...(deltaDivine !== undefined ? { deltaDivine } : {}),
      ...(rate !== undefined ? { divineRate: rate } : {}),
      ...(perHour !== undefined ? { perHourExalted: perHour } : {}),
      snapshots: summary.snapshotCount ?? points.length,
      ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
    };
  }

  if (points.length === 0) {
    return {
      available: false,
      reason: "No stash session yet — Tools → Stash tracker → Start session.",
      snapshots: 0,
    };
  }

  const latest = points[points.length - 1];
  const sessionStartMs = sessionStartedAt ? Date.parse(sessionStartedAt) : Number.NaN;
  const sessionStartPoints = points.filter((point) => point.kind === "session-start");
  const baseline =
    sessionStartPoints.at(-1) ??
    (Number.isFinite(sessionStartMs)
      ? [...points].reverse().find((point) => Date.parse(point.at) <= sessionStartMs)
      : undefined) ??
    points[0];
  const delta = Math.round((latest.totalExalted - baseline.totalExalted) * 100) / 100;
  const known = latest.divineRate ?? baseline.divineRate;
  // No snapshot carried a rate: the divine figure is a guess, and it is
  // flagged as one rather than printed as if the feed had said so.
  const assumed = !(known && known > 0);
  const rate = assumed ? FALLBACK_DIVINE_RATE : (known as number);
  const deltaDivine = Math.round((delta / rate) * 100) / 100;
  const elapsedMs = Math.max(0, Date.parse(latest.at) - Date.parse(baseline.at));
  return {
    available: true,
    source: "snapshots",
    baselineAt: baseline.at,
    baselineExalted: baseline.totalExalted,
    latestAt: latest.at,
    latestExalted: latest.totalExalted,
    deltaExalted: delta,
    deltaDivine,
    divineRate: rate,
    ...(assumed ? { rateAssumed: true } : {}),
    ...(elapsedMs > 60_000
      ? { perHourExalted: Math.round((delta / (elapsedMs / 3_600_000)) * 100) / 100 }
      : {}),
    snapshots: points.length,
    updatedAt: latest.at,
  };
}

/**
 * Sales and purchases in exalted, either since the session started or — when
 * no session is running — across every trade still on file. The `window` field
 * carries which of the two it was, because the UI must not silently relabel
 * two weeks of sales as "this session".
 */
export function tradeEarnings(
  points: readonly TradeHistoryPoint[],
  sinceIso: string | undefined,
): TradeEarnings {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const scoped = Number.isFinite(sinceMs);
  const windowFields = scoped
    ? { window: "session" as const, sinceIso: sinceIso as string }
    : { window: "all" as const };
  if (points.length === 0) {
    return {
      available: false,
      reason: "No trade history yet — the Trade tool records sales as they happen.",
      sales: 0,
      purchases: 0,
      earnedExalted: 0,
      spentExalted: 0,
      netExalted: 0,
      partial: false,
      ...windowFields,
    };
  }
  let sales = 0;
  let purchases = 0;
  let earned = 0;
  let spent = 0;
  let partial = false;
  for (const point of points) {
    if (scoped && Date.parse(point.at) < sinceMs) continue;
    if (point.kind === "sale") {
      sales += 1;
      if (point.exalted === undefined) partial = true;
      else earned += point.exalted;
    } else if (point.kind === "purchase") {
      purchases += 1;
      if (point.exalted === undefined) partial = true;
      else spent += point.exalted;
    }
  }
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    available: true,
    sales,
    purchases,
    earnedExalted: round(earned),
    spentExalted: round(spent),
    netExalted: round(earned - spent),
    partial,
    ...windowFields,
  };
}

/** Top movers from the trends cache. Never fetches; `ok: false` is shown honestly. */
export function marketMovers(
  input: {
    ok: boolean;
    league?: string;
    fetchedAt?: string;
    stale: boolean;
    trends: readonly TrendReport[];
    error?: string;
  },
  limit = 5,
): MarketMovers {
  const usable = input.trends.filter(
    (trend) => trend.sampleSize >= 3 && trend.change3d !== undefined && trend.volume7d > 0,
  );
  const view = (trend: TrendReport): MoverView => ({
    key: trend.key,
    name: trend.name,
    current: trend.current,
    ...(trend.change3d !== undefined ? { change3d: trend.change3d } : {}),
    ...(trend.change7d !== undefined ? { change7d: trend.change7d } : {}),
    volume7d: trend.volume7d,
    sampleSize: trend.sampleSize,
    direction:
      (trend.change3d ?? 0) > 0 ? "rising" : (trend.change3d ?? 0) < 0 ? "falling" : "stable",
  });
  const rising = usable
    .filter((trend) => (trend.change3d ?? 0) > 0)
    .sort((a, b) => (b.change3d ?? 0) - (a.change3d ?? 0))
    .slice(0, limit)
    .map(view);
  const falling = usable
    .filter((trend) => (trend.change3d ?? 0) < 0)
    .sort((a, b) => (a.change3d ?? 0) - (b.change3d ?? 0))
    .slice(0, limit)
    .map(view);
  const available = input.ok && usable.length > 0;
  return {
    available,
    ...(available
      ? {}
      : { reason: input.error ?? "No trends cache yet — Tools → Market → Refresh." }),
    ...(input.league ? { league: input.league } : {}),
    ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
    stale: input.stale,
    rising,
    falling,
  };
}

/** Whether the price feed is old enough that a refresh is worth suggesting. */
export function feedIsStale(feedAgeHours: number | undefined): boolean {
  return feedAgeHours === undefined || feedAgeHours > FEED_STALE_AFTER_HOURS;
}

/** At most five next actions, most blocking first. Every route already exists. */
export function recommendations(input: RecommendationInput): HomeRecommendation[] {
  const out: HomeRecommendation[] = [];
  const push = (entry: HomeRecommendation): void => {
    if (out.length < MAX_RECOMMENDATIONS && !out.some((existing) => existing.id === entry.id)) {
      out.push(entry);
    }
  };

  if (!input.clientLog.watching) {
    push({
      id: "client-log",
      title: "Point the app at Client.txt",
      detail:
        input.clientLog.error ??
        "Nothing is being read yet, so character, maps and deaths stay empty.",
      route: "/tools/settings",
      tone: "warning",
    });
  }
  if (input.priceFeed.leagueAmbiguous || !input.priceFeed.resolvedLeague) {
    push({
      id: "league",
      title: "Pin the pricing league",
      detail: "Two current leagues are listed; pricing stays blocked until one is pinned.",
      route: "/tools/settings",
      tone: "warning",
    });
  }
  if (input.priceFeed.feedEntryCount === 0 || feedIsStale(input.priceFeed.feedAgeHours)) {
    push({
      id: "feed",
      title: "Refresh market prices",
      detail:
        input.priceFeed.feedEntryCount === 0
          ? "The local price feed is empty, so every estimate falls back to the price table."
          : `The price feed is older than ${FEED_STALE_AFTER_HOURS} hours.`,
      route: "/sort",
      tone: "info",
    });
  }
  if (!input.stash.available && input.stashFileExists) {
    push({
      id: "stash-session",
      title: "Start a stash session",
      detail: "The stash tracker has snapshots but no session baseline, so gains stay blank.",
      route: "/tools/stash-tracker",
      tone: "info",
    });
  }
  if (!input.stashFileExists) {
    push({
      id: "stash-files",
      title: "Run a sort to build the stash ledger",
      detail: "Home reads the stash tracker's snapshots; there are none yet.",
      route: "/sort",
      tone: "info",
    });
  }
  if (!input.market.available || input.market.stale) {
    push({
      id: "market",
      title: "Refresh market trends",
      detail: input.market.available
        ? "The trends cache is older than its refresh window."
        : (input.market.reason ?? "No trends cached yet."),
      route: "/tools/market",
      tone: "info",
    });
  }
  if (input.deathsRecent >= 2) {
    push({
      id: "deaths",
      title: "Check map mods before running",
      detail: `${input.deathsRecent} deaths in the last runs — the item view explains dangerous mods.`,
      route: "/items",
      tone: "warning",
    });
  }
  push({
    id: "evaluate",
    title: "Price-check an item with Ctrl+D",
    detail: "Copy an item in game and the item log shows comps and an estimate.",
    route: "/items",
    tone: "info",
  });
  return out;
}
