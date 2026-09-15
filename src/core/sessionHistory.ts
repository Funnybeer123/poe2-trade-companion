/**
 * Session records on disk: sanitizers, JSONL (de)serialization and the
 * summaries the History tab lists.
 *
 * WHY sanitizers rather than trusting JSON.parse: the current-session file is
 * rewritten every minute while the app runs, so a crash or a full disk can
 * leave a half-written object; the history file is append-only and a torn
 * last line is normal. Everything here treats the input as hostile, never
 * throws, and drops what it cannot vouch for instead of failing the read.
 */
import type { StashGains } from "./sessionHome.js";
import {
  MAX_AFK,
  MAX_AREAS,
  MAX_CHARACTERS,
  MAX_DEATHS,
  MAX_LEVEL_UPS,
  MAX_RUNS,
  sessionMetrics,
  type AfkSpan,
  type AreaVisit,
  type CampaignProgress,
  type DeathMark,
  type LevelUp,
  type MapRun,
  type RunKind,
  type SessionCharacter,
  type SessionMetrics,
  type SessionState,
} from "./sessionTracker.js";
import type { AreaCategory } from "./clientLog.js";

export interface SessionRecord {
  version: 1;
  state: SessionState;
  metrics: SessionMetrics;
  stash?: StashGains;
  savedAt: string;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  character?: Pick<SessionCharacter, "name" | "className" | "level">;
  wallMs: number;
  activeMs: number;
  mapsCompleted: number;
  mapsPerHour?: number;
  avgMapMs?: number;
  deaths: number;
  levelsGained: number;
  campaign?: string;
}

export const SESSION_RECORD_VERSION = 1 as const;
export const MAX_HISTORY_SESSIONS = 200;
export const MAX_RECORD_BYTES = 256 * 1024;
/** Sessions shorter than this with nothing in them are not written at all. */
export const MIN_PERSIST_WALL_MS = 2 * 60_000;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const AREA_CATEGORIES: readonly AreaCategory[] = [
  "town",
  "hideout",
  "campaign",
  "map",
  "league",
  "sanctum",
  "endgame-town",
  "other",
];
const RUN_KINDS: readonly RunKind[] = ["map", "trial", "league"];
const END_REASONS = ["game-exit", "idle", "app-quit", "manual"] as const;
const ENDED_BY = [
  "hideout",
  "town",
  "endgame-town",
  "new-run",
  "campaign",
  "timeout",
  "session-end",
] as const;
const CHARACTER_SOURCES = ["level-up", "death", "override", "backfill"] as const;

function obj(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function str(raw: unknown, max = 200): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function iso(raw: unknown): string | undefined {
  const text = str(raw, 40);
  if (!text) return undefined;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
}

function num(raw: unknown, fallback?: number): number | undefined {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function count(raw: unknown): number {
  const value = num(raw, 0) ?? 0;
  return value >= 0 ? Math.round(value) : 0;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  const text = typeof raw === "string" ? raw : undefined;
  return text && (allowed as readonly string[]).includes(text) ? (text as T) : undefined;
}

function array(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(Math.max(0, raw.length - max));
}

function sanitizeVisit(raw: unknown): AreaVisit | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const areaId = str(source.areaId, 80);
  const enteredAt = iso(source.enteredAt);
  const category = oneOf(source.category, AREA_CATEGORIES);
  if (!areaId || !enteredAt || !category) return undefined;
  return {
    areaId,
    name: str(source.name, 120) ?? areaId,
    category,
    level: count(source.level),
    seed: count(source.seed),
    enteredAt,
    ...(iso(source.leftAt) ? { leftAt: iso(source.leftAt) } : {}),
    ...(str(source.instance, 80) ? { instance: str(source.instance, 80) } : {}),
    ...(str(source.runId, 80) ? { runId: str(source.runId, 80) } : {}),
    ...(source.unverified === true ? { unverified: true } : {}),
  };
}

function sanitizeRun(raw: unknown): MapRun | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const id = str(source.id, 80);
  const areaId = str(source.areaId, 80);
  const kind = oneOf(source.kind, RUN_KINDS);
  const startedAt = iso(source.startedAt);
  if (!id || !areaId || !kind || !startedAt) return undefined;
  const tier = num(source.tier);
  return {
    id,
    kind,
    areaId,
    name: str(source.name, 120) ?? areaId,
    areaLevel: count(source.areaLevel),
    seed: count(source.seed),
    ...(tier !== undefined ? { tier: Math.round(tier) } : {}),
    startedAt,
    ...(iso(source.endedAt) ? { endedAt: iso(source.endedAt) } : {}),
    ...(iso(source.suspendedAt) ? { suspendedAt: iso(source.suspendedAt) } : {}),
    wallMs: count(source.wallMs),
    activeMs: count(source.activeMs),
    portals: count(source.portals),
    deaths: count(source.deaths),
    subAreas: array(source.subAreas, 40)
      .map((entry) => str(entry, 80))
      .filter((entry): entry is string => Boolean(entry)),
    completed: source.completed === true,
    ...(oneOf(source.endedBy, ENDED_BY) ? { endedBy: oneOf(source.endedBy, ENDED_BY) } : {}),
  };
}

function sanitizeCharacter(raw: unknown): SessionCharacter | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const name = str(source.name, 40);
  const seenAt = iso(source.seenAt);
  if (!name || !seenAt) return undefined;
  const level = num(source.level);
  return {
    name,
    ...(str(source.className, 60) ? { className: str(source.className, 60) } : {}),
    ...(level !== undefined && level > 0 ? { level: Math.round(level) } : {}),
    seenAt,
    source: oneOf(source.source, CHARACTER_SOURCES) ?? "level-up",
  };
}

function sanitizeDeath(raw: unknown): DeathMark | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const at = iso(source.at);
  if (!at) return undefined;
  return {
    at,
    character: str(source.character, 40) ?? "",
    ...(str(source.areaId, 80) ? { areaId: str(source.areaId, 80) } : {}),
    ...(str(source.areaName, 120) ? { areaName: str(source.areaName, 120) } : {}),
    ...(str(source.runId, 80) ? { runId: str(source.runId, 80) } : {}),
    ...(str(source.captureId, 120) ? { captureId: str(source.captureId, 120) } : {}),
  };
}

function sanitizeLevelUp(raw: unknown): LevelUp | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const at = iso(source.at);
  const level = num(source.level);
  if (!at || level === undefined) return undefined;
  return {
    at,
    character: str(source.character, 40) ?? "",
    className: str(source.className, 60) ?? "",
    level: Math.round(level),
  };
}

function sanitizeAfk(raw: unknown): AfkSpan | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const from = iso(source.from);
  if (!from) return undefined;
  return { from, ...(iso(source.to) ? { to: iso(source.to) } : {}) };
}

function sanitizeCampaign(raw: unknown): CampaignProgress | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const areaId = str(source.areaId, 80);
  const at = iso(source.at);
  if (!areaId || !at) return undefined;
  const part = count(source.part) === 2 ? 2 : 1;
  return {
    areaId,
    name: str(source.name, 120) ?? areaId,
    act: count(source.act),
    part,
    areaLevel: count(source.areaLevel),
    at,
    isTown: source.isTown === true,
    complete: source.complete === true,
    rank: count(source.rank),
    ...(source.unverified === true ? { unverified: true } : {}),
  };
}

/** A session state read back from disk, or undefined when it is not one. */
export function sanitizeSessionState(raw: unknown): SessionState | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const id = str(source.id, 64);
  const startedAt = iso(source.startedAt);
  if (!id || !ID_PATTERN.test(id) || !startedAt) return undefined;
  const trades = obj(source.trades) ?? {};
  const whispers = obj(source.whispers) ?? {};
  return {
    id,
    startedAt,
    ...(iso(source.endedAt) ? { endedAt: iso(source.endedAt) } : {}),
    ...(oneOf(source.endReason, END_REASONS) ? { endReason: oneOf(source.endReason, END_REASONS) } : {}),
    characters: array(source.characters, MAX_CHARACTERS)
      .map(sanitizeCharacter)
      .filter((entry): entry is SessionCharacter => Boolean(entry)),
    ...(sanitizeVisit(source.current) ? { current: sanitizeVisit(source.current) } : {}),
    areas: array(source.areas, MAX_AREAS)
      .map(sanitizeVisit)
      .filter((entry): entry is AreaVisit => Boolean(entry)),
    areasDropped: count(source.areasDropped),
    runs: array(source.runs, MAX_RUNS)
      .map(sanitizeRun)
      .filter((entry): entry is MapRun => Boolean(entry)),
    runsDropped: count(source.runsDropped),
    deaths: array(source.deaths, MAX_DEATHS)
      .map(sanitizeDeath)
      .filter((entry): entry is DeathMark => Boolean(entry)),
    deathsDropped: count(source.deathsDropped),
    levelUps: array(source.levelUps, MAX_LEVEL_UPS)
      .map(sanitizeLevelUp)
      .filter((entry): entry is LevelUp => Boolean(entry)),
    afk: array(source.afk, MAX_AFK)
      .map(sanitizeAfk)
      .filter((entry): entry is AfkSpan => Boolean(entry)),
    ...(sanitizeCampaign(source.campaign) ? { campaign: sanitizeCampaign(source.campaign) } : {}),
    trades: { accepted: count(trades.accepted), cancelled: count(trades.cancelled) },
    whispers: { in: count(whispers.in), out: count(whispers.out) },
    ...(str(source.pendingInstance, 80) ? { pendingInstance: str(source.pendingInstance, 80) } : {}),
    ...(iso(source.lastEventAt) ? { lastEventAt: iso(source.lastEventAt) } : {}),
    eventCount: count(source.eventCount),
  };
}

function sanitizeMetrics(raw: unknown): SessionMetrics | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  if (num(source.wallMs) === undefined) return undefined;
  const optional = (key: string): Record<string, number> => {
    const value = num(source[key]);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    wallMs: count(source.wallMs),
    afkMs: count(source.afkMs),
    activeMs: count(source.activeMs),
    runsStarted: count(source.runsStarted),
    mapsStarted: count(source.mapsStarted),
    mapsCompleted: count(source.mapsCompleted),
    mapsAbandoned: count(source.mapsAbandoned),
    trialsCompleted: count(source.trialsCompleted),
    leagueCompleted: count(source.leagueCompleted),
    ...optional("mapsPerHour"),
    ...optional("avgMapMs"),
    ...optional("medianMapMs"),
    deathsInMaps: count(source.deathsInMaps),
    ...optional("deathsPerMap"),
    deaths: count(source.deaths),
    levelsGained: count(source.levelsGained),
    levelUps: count(source.levelUps),
    ...optional("sinceLastLevelUpMs"),
  };
}

function sanitizeStash(raw: unknown): StashGains | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  const numberKey = (key: string): Record<string, number> => {
    const value = num(source[key]);
    return value === undefined ? {} : { [key]: value };
  };
  const textKey = (key: string, max = 60): Record<string, string> => {
    const value = str(source[key], max);
    return value === undefined ? {} : { [key]: value };
  };
  const sourceKind = oneOf(source.source, ["session-file", "snapshots"] as const);
  return {
    available: source.available === true,
    ...textKey("reason", 120),
    ...(sourceKind ? { source: sourceKind } : {}),
    ...textKey("baselineAt", 40),
    ...numberKey("baselineExalted"),
    ...textKey("latestAt", 40),
    ...numberKey("latestExalted"),
    ...numberKey("deltaExalted"),
    ...numberKey("deltaDivine"),
    ...numberKey("divineRate"),
    ...(source.rateAssumed === true ? { rateAssumed: true } : {}),
    ...numberKey("perHourExalted"),
    snapshots: count(source.snapshots),
    ...textKey("updatedAt", 40),
  };
}

export function sanitizeSessionRecord(raw: unknown): SessionRecord | undefined {
  const source = obj(raw);
  if (!source) return undefined;
  if (count(source.version) !== SESSION_RECORD_VERSION) return undefined;
  const state = sanitizeSessionState(source.state);
  if (!state) return undefined;
  const savedAt = iso(source.savedAt) ?? state.endedAt ?? state.startedAt;
  const metrics = sanitizeMetrics(source.metrics) ?? sessionMetrics(state, state.endedAt ?? savedAt);
  const stash = sanitizeStash(source.stash);
  return {
    version: SESSION_RECORD_VERSION,
    state,
    metrics,
    ...(stash ? { stash } : {}),
    savedAt,
  };
}

/**
 * How many BYTES the line takes on disk. WHY not `line.length`: a Korean or
 * Cyrillic character name costs up to three UTF-8 bytes per JS code unit, so a
 * cap measured in code units would let a record written as ~750 KB pass a
 * "256 KB" check and blow the documented history size apart.
 */
function lineBytes(line: string): number {
  return typeof Buffer === "undefined" ? line.length : Buffer.byteLength(line, "utf8");
}

/**
 * One compact JSON line. Over the byte cap the areas go first (they are the
 * bulkiest and the least interesting after the fact), then the oldest runs.
 */
export function serializeSessionRecord(record: SessionRecord): string {
  let state: SessionState = {
    ...record.state,
    areas: record.state.areas.slice(-MAX_AREAS),
    runs: record.state.runs.slice(-MAX_RUNS),
    deaths: record.state.deaths.slice(-MAX_DEATHS),
    levelUps: record.state.levelUps.slice(-MAX_LEVEL_UPS),
    afk: record.state.afk.slice(-MAX_AFK),
    characters: record.state.characters.slice(-MAX_CHARACTERS),
  };
  let line = JSON.stringify({ ...record, state });
  if (lineBytes(line) <= MAX_RECORD_BYTES) return line;
  state = { ...state, areas: [] };
  line = JSON.stringify({ ...record, state });
  while (lineBytes(line) > MAX_RECORD_BYTES && state.runs.length > 1) {
    state = { ...state, runs: state.runs.slice(1), runsDropped: state.runsDropped + 1 };
    line = JSON.stringify({ ...record, state });
  }
  return line;
}

/**
 * One JSONL line → a record, or undefined for a torn or junk line. Exported so
 * the service can walk the file one line at a time instead of holding every
 * record it ever wrote in memory.
 */
export function parseSessionRecordLine(line: string): SessionRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    return sanitizeSessionRecord(JSON.parse(line));
  } catch {
    // Torn line (crash mid-append): skip it.
    return undefined;
  }
}

/** JSONL, oldest first as on disk; torn or junk lines are skipped. */
export function parseSessionHistory(text: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const record = parseSessionRecordLine(line);
    if (record) out.push(record);
  }
  return out;
}

export function summarizeSession(record: SessionRecord): SessionSummary {
  const { state, metrics } = record;
  let best: SessionCharacter | undefined;
  for (const entry of state.characters) {
    if (!best || (entry.level ?? 0) >= (best.level ?? 0)) best = entry;
  }
  return {
    id: state.id,
    startedAt: state.startedAt,
    ...(state.endedAt ? { endedAt: state.endedAt } : {}),
    ...(state.endReason ? { endReason: state.endReason } : {}),
    ...(best
      ? {
          character: {
            name: best.name,
            ...(best.className ? { className: best.className } : {}),
            ...(best.level !== undefined ? { level: best.level } : {}),
          },
        }
      : {}),
    wallMs: metrics.wallMs,
    activeMs: metrics.activeMs,
    mapsCompleted: metrics.mapsCompleted,
    ...(metrics.mapsPerHour !== undefined ? { mapsPerHour: metrics.mapsPerHour } : {}),
    ...(metrics.avgMapMs !== undefined ? { avgMapMs: metrics.avgMapMs } : {}),
    deaths: metrics.deaths,
    levelsGained: metrics.levelsGained,
    ...(state.campaign ? { campaign: state.campaign.name } : {}),
  };
}

/** A two-minute session with nothing in it is noise, not history. */
export function shouldPersist(state: SessionState, metrics: SessionMetrics): boolean {
  if (metrics.runsStarted > 0 || metrics.deaths > 0 || metrics.levelUps > 0) return true;
  return metrics.wallMs >= MIN_PERSIST_WALL_MS && state.eventCount > 0;
}

export function pruneHistory(
  records: SessionRecord[],
  max = MAX_HISTORY_SESSIONS,
): SessionRecord[] {
  const sorted = [...records].sort((a, b) => Date.parse(a.state.startedAt) - Date.parse(b.state.startedAt));
  return sorted.slice(Math.max(0, sorted.length - max));
}

/** Newest runs first across the live session and the history. */
export function recentRuns(
  records: readonly SessionRecord[],
  current: SessionState | undefined,
  limit: number,
): MapRun[] {
  const runs: MapRun[] = [];
  if (current) runs.push(...current.runs);
  for (let index = records.length - 1; index >= 0 && runs.length < limit * 4; index -= 1) {
    runs.push(...records[index].state.runs);
  }
  return runs
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, Math.max(0, limit));
}

/** Trim the arrays before the state crosses the IPC boundary. */
export function stateForView(
  state: SessionState,
  opts?: { areas?: number; runs?: number },
): SessionState {
  const areas = opts?.areas ?? 50;
  const runs = opts?.runs ?? 100;
  return {
    ...state,
    areas: state.areas.slice(-areas),
    runs: state.runs.slice(-runs),
    deaths: state.deaths.slice(-50),
    levelUps: state.levelUps.slice(-25),
    afk: state.afk.slice(-25),
  };
}
