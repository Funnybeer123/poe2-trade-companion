/**
 * Pure play-session reducer: Client.txt events in, a session state out.
 *
 * WHY a reducer and not a stateful class: everything interesting here
 * (a map run resumed through a portal, a nested Breach domain, a run that
 * was left in the hideout and never came back) is a rule about the ORDER of
 * area lines. Keeping it pure means the whole rule set is testable from a
 * fixture log with no clock, no disk and no Electron, and the main-process
 * service only has to decide WHEN to call it.
 *
 * PoE2 facts this encodes (see docs/features/session-home.md):
 * - there is no "you have entered" line; an area change is the DEBUG
 *   `Generating level N area "<id>" with seed S` line, N = monster level;
 * - a portal back to town and back into the map re-emits the SAME area id
 *   and seed — that is a resumed run, not a new one;
 * - map areas run level 65..82 (81/82 = irradiated/corrupted T16);
 * - `MapHideout*_Claimable` ids are hideouts at level 46 (the catalogue
 *   classifies them as hideouts; MAP_RUN_MIN_LEVEL is the belt-and-braces
 *   guard in case an older catalogue calls them maps).
 *
 * Every function returns a NEW state object (arrays copied, untouched
 * members shared) and never throws: a malformed event must not lose a
 * session.
 */
import type { AreaCategory, AreaInfo, ClientLogEvent } from "./clientLog.js";

export type RunKind = "map" | "trial" | "league";
export type SessionEndReason = "game-exit" | "idle" | "app-quit" | "manual";
export type CharacterSource = "level-up" | "death" | "override" | "backfill";
export type RunEndedBy =
  | "hideout"
  | "town"
  | "endgame-town"
  | "new-run"
  | "campaign"
  | "timeout"
  | "session-end";

export interface SessionCharacter {
  name: string;
  className?: string;
  level?: number;
  seenAt: string;
  source: CharacterSource;
}

export interface AreaVisit {
  areaId: string;
  name: string;
  category: AreaCategory;
  level: number;
  seed: number;
  enteredAt: string;
  leftAt?: string;
  instance?: string;
  runId?: string;
  unverified?: boolean;
}

export interface MapRun {
  id: string;
  kind: RunKind;
  areaId: string;
  name: string;
  areaLevel: number;
  /** The area seed, so a re-entered portal is recognised as the same run. */
  seed: number;
  tier?: number;
  startedAt: string;
  endedAt?: string;
  /** Set while the player is in town/hideout: a provisional end. */
  suspendedAt?: string;
  wallMs: number;
  activeMs: number;
  portals: number;
  deaths: number;
  subAreas: string[];
  completed: boolean;
  endedBy?: RunEndedBy;
}

export interface DeathMark {
  at: string;
  character: string;
  areaId?: string;
  areaName?: string;
  runId?: string;
  captureId?: string;
}

export interface LevelUp {
  at: string;
  character: string;
  className: string;
  level: number;
}

export interface AfkSpan {
  from: string;
  to?: string;
}

export interface CampaignProgress {
  areaId: string;
  name: string;
  act: number;
  part: 1 | 2;
  areaLevel: number;
  at: string;
  isTown: boolean;
  complete: boolean;
  /** campaignRank() of the area, kept so later areas compare deterministically. */
  rank: number;
  unverified?: boolean;
}

export interface SessionState {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: SessionEndReason;
  /** Newest last; the last entry is the current character. */
  characters: SessionCharacter[];
  /** The open area visit (no leftAt). */
  current?: AreaVisit;
  areas: AreaVisit[];
  areasDropped: number;
  /** The open run (no endedAt) lives here too, at most one. */
  runs: MapRun[];
  runsDropped: number;
  deaths: DeathMark[];
  deathsDropped: number;
  levelUps: LevelUp[];
  afk: AfkSpan[];
  campaign?: CampaignProgress;
  trades: { accepted: number; cancelled: number };
  whispers: { in: number; out: number };
  pendingInstance?: string;
  lastEventAt?: string;
  eventCount: number;
}

export interface SessionMetrics {
  wallMs: number;
  afkMs: number;
  /** wallMs − afkMs, never below 0. */
  activeMs: number;
  runsStarted: number;
  mapsStarted: number;
  mapsCompleted: number;
  mapsAbandoned: number;
  trialsCompleted: number;
  leagueCompleted: number;
  /** undefined until activeMs ≥ MIN_RATE_WINDOW_MS — a rate from 3 minutes is noise. */
  mapsPerHour?: number;
  avgMapMs?: number;
  medianMapMs?: number;
  deathsInMaps: number;
  deathsPerMap?: number;
  deaths: number;
  levelsGained: number;
  levelUps: number;
  sinceLastLevelUpMs?: number;
}

export const MAX_AREAS = 400;
export const MAX_RUNS = 300;
export const MAX_DEATHS = 200;
export const MAX_LEVEL_UPS = 100;
export const MAX_AFK = 100;
export const MAX_CHARACTERS = 10;
/** maps/hour needs 10 active minutes before it means anything. */
export const MIN_RATE_WINDOW_MS = 10 * 60_000;
/** A suspended run not re-entered within 30 minutes is finalized. */
export const RUN_RESUME_WINDOW_MS = 30 * 60_000;
/** A "map" area below this never starts a run (claimable hideouts sit at 46). */
export const MAP_RUN_MIN_LEVEL = 65;
export const MAP_TIER_MIN_LEVEL = 65;
export const MAP_TIER_MAX_LEVEL = 80;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stamp(at: string): string {
  return at.replace(/[:.]/g, "-");
}

function sanitizeToken(value: string, max = 40): string {
  return value.replace(/[^A-Za-z0-9_]/g, "").slice(0, max);
}

/** Milliseconds between two ISO stamps, clamped at 0 (DST jumps, bad input). */
export function msBetween(from: string | undefined, to: string | undefined): number {
  if (!from || !to) return 0;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}

export function newSessionId(at: string): string {
  return `ses-${stamp(at)}`;
}

export function newRunId(at: string, areaId: string): string {
  return `run-${stamp(at)}-${sanitizeToken(areaId)}`;
}

/** < 65 → not a map; 65..80 → level − 64; 81/82 (irradiated, corrupted) → 16. */
export function mapTierFromLevel(level: number): number | undefined {
  if (!Number.isFinite(level) || level < MAP_TIER_MIN_LEVEL) return undefined;
  if (level > MAP_TIER_MAX_LEVEL) return 16;
  return Math.round(level) - 64;
}

export function isRunBoundary(category: AreaCategory): boolean {
  return category === "hideout" || category === "town" || category === "endgame-town";
}

/** The run kind an area starts, or undefined when it starts none. */
export function runKindFor(info: AreaInfo, level: number): RunKind | undefined {
  if (info.category === "sanctum") return "trial";
  if (info.category === "league") return "league";
  if (info.category === "map") {
    if (/^MapHideout/i.test(info.id)) return undefined;
    return level >= MAP_RUN_MIN_LEVEL ? "map" : undefined;
  }
  return undefined;
}

/** Campaign ordering: part, then act, then area level, towns last inside an act. */
export function campaignRank(info: AreaInfo): number | undefined {
  if (info.category !== "campaign" && info.category !== "town") return undefined;
  const part = info.part ?? 1;
  const act = info.act ?? 0;
  const level = info.level ?? 0;
  return (part - 1) * 1000 + act * 100 + level + (info.category === "town" ? 99 : 0);
}

/**
 * Character level vs area level as a tone, never a percentage and never the
 * word XP — the campaign guide (P8) owns experience maths.
 */
export function experienceHint(
  characterLevel: number | undefined,
  areaLevel: number | undefined,
): { delta?: number; hint?: string; tone: "safe" | "warning" | "neutral" } {
  if (
    characterLevel === undefined ||
    areaLevel === undefined ||
    !Number.isFinite(characterLevel) ||
    !Number.isFinite(areaLevel)
  ) {
    return { tone: "neutral" };
  }
  const delta = Math.round(characterLevel - areaLevel);
  if (delta <= -3) {
    return { delta, tone: "warning", hint: `${Math.abs(delta)} levels under the area — consider side areas` };
  }
  if (delta >= 6) return { delta, tone: "neutral", hint: `Over-levelled by ${delta} — move on` };
  return { delta, tone: "safe", hint: "On pace" };
}

/** "—" | "48s" | "12m 49s" | "1h 03m". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Session construction
// ---------------------------------------------------------------------------

export function startSession(
  id: string,
  at: string,
  seed?: {
    character?: { name: string; className: string; level: number; seenAt: string };
    area?: Extract<ClientLogEvent, { kind: "area" }>;
  },
): SessionState {
  const state: SessionState = {
    id,
    startedAt: at,
    characters: [],
    areas: [],
    areasDropped: 0,
    runs: [],
    runsDropped: 0,
    deaths: [],
    deathsDropped: 0,
    levelUps: [],
    afk: [],
    trades: { accepted: 0, cancelled: 0 },
    whispers: { in: 0, out: 0 },
    eventCount: 0,
  };
  if (seed?.character?.name) {
    state.characters.push({
      name: seed.character.name,
      className: seed.character.className,
      level: seed.character.level,
      seenAt: seed.character.seenAt,
      source: "backfill",
    });
  }
  if (seed?.area) {
    // The backfilled area is where the player IS, so open a visit for it but
    // start no run: we cannot know how long they have been in there.
    const info = seed.area.info;
    state.current = {
      areaId: seed.area.areaId,
      name: info.name,
      category: info.category,
      level: seed.area.level,
      seed: seed.area.seed,
      enteredAt: at,
      ...(info.unverified ? { unverified: true } : {}),
    };
  }
  return state;
}

interface Draft extends SessionState {
  characters: SessionCharacter[];
  areas: AreaVisit[];
  runs: MapRun[];
  deaths: DeathMark[];
  levelUps: LevelUp[];
  afk: AfkSpan[];
}

function draftOf(state: SessionState): Draft {
  return {
    ...state,
    characters: [...state.characters],
    areas: [...state.areas],
    runs: [...state.runs],
    deaths: [...state.deaths],
    levelUps: [...state.levelUps],
    afk: [...state.afk],
    trades: { ...state.trades },
    whispers: { ...state.whispers },
  };
}

function openRunIndex(draft: Draft): number {
  for (let index = draft.runs.length - 1; index >= 0; index -= 1) {
    if (!draft.runs[index].endedAt) return index;
  }
  return -1;
}

function pushCapped<T>(list: T[], value: T, max: number): number {
  list.push(value);
  let dropped = 0;
  while (list.length > max) {
    list.shift();
    dropped += 1;
  }
  return dropped;
}

function finalizeRun(draft: Draft, index: number, at: string, endedBy: RunEndedBy): void {
  const run = draft.runs[index];
  if (!run || run.endedAt) return;
  const endedAt = run.suspendedAt ?? at;
  const completed =
    endedBy === "hideout" ||
    endedBy === "town" ||
    endedBy === "endgame-town" ||
    endedBy === "new-run" ||
    endedBy === "campaign";
  draft.runs[index] = {
    ...run,
    endedAt,
    suspendedAt: undefined,
    wallMs: msBetween(run.startedAt, endedAt),
    completed,
    endedBy,
  };
}

function boundaryReason(category: AreaCategory): RunEndedBy {
  if (category === "town") return "town";
  if (category === "endgame-town") return "endgame-town";
  return "hideout";
}

function upsertCharacter(draft: Draft, next: SessionCharacter): void {
  const existingIndex = draft.characters.findIndex((entry) => entry.name === next.name);
  const existing = existingIndex >= 0 ? draft.characters[existingIndex] : undefined;
  if (existingIndex >= 0) draft.characters.splice(existingIndex, 1);
  draft.characters.push({
    ...existing,
    ...next,
    className: next.className ?? existing?.className,
    level: next.level ?? existing?.level,
  });
  while (draft.characters.length > MAX_CHARACTERS) draft.characters.shift();
}

function applyArea(draft: Draft, event: Extract<ClientLogEvent, { kind: "area" }>): void {
  const at = event.at;
  const info = event.info;
  const level = event.level;

  // 1. Close the open visit; map time inside a live run counts as active.
  let closed: AreaVisit | undefined;
  if (draft.current) {
    closed = { ...draft.current, leftAt: at };
    const runIndex = openRunIndex(draft);
    const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
    if (closed.runId && run && run.id === closed.runId && !run.suspendedAt) {
      draft.runs[runIndex] = {
        ...run,
        activeMs: run.activeMs + msBetween(closed.enteredAt, at),
      };
    }
    draft.areasDropped += pushCapped(draft.areas, closed, MAX_AREAS);
  }

  const visit: AreaVisit = {
    areaId: event.areaId,
    name: info.name,
    category: info.category,
    level,
    seed: event.seed,
    enteredAt: at,
    ...(draft.pendingInstance ? { instance: draft.pendingInstance } : {}),
    ...(info.unverified ? { unverified: true } : {}),
  };
  draft.pendingInstance = undefined;

  const boundary = isRunBoundary(info.category);
  const kind = runKindFor(info, level);
  let runIndex = openRunIndex(draft);

  if (boundary) {
    const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
    if (run && !run.suspendedAt) {
      draft.runs[runIndex] = { ...run, suspendedAt: at, endedBy: boundaryReason(info.category) };
    }
  } else if (kind) {
    const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
    if (run && run.areaId === visit.areaId && run.seed === visit.seed) {
      // Same id AND seed: the player portalled back into the same instance.
      draft.runs[runIndex] = {
        ...run,
        suspendedAt: undefined,
        endedBy: undefined,
        portals: run.suspendedAt ? run.portals + 1 : run.portals,
      };
      visit.runId = run.id;
    } else if (
      run &&
      closed?.runId === run.id &&
      run.kind === "map" &&
      (kind === "league" || kind === "trial")
    ) {
      // A Breach domain / trial entered from inside the map belongs to it.
      draft.runs[runIndex] = {
        ...run,
        subAreas: run.subAreas.includes(visit.areaId) ? run.subAreas : [...run.subAreas, visit.areaId],
      };
      visit.runId = run.id;
    } else {
      if (run) finalizeRun(draft, runIndex, at, run.suspendedAt ? (run.endedBy ?? "hideout") : "new-run");
      const started: MapRun = {
        id: newRunId(at, visit.areaId),
        kind,
        areaId: visit.areaId,
        name: visit.name,
        areaLevel: level,
        seed: visit.seed,
        ...(kind === "map" ? { tier: mapTierFromLevel(level) } : {}),
        startedAt: at,
        wallMs: 0,
        activeMs: 0,
        portals: 0,
        deaths: 0,
        subAreas: [],
        completed: false,
      };
      draft.runsDropped += pushCapped(draft.runs, started, MAX_RUNS);
      visit.runId = started.id;
      if (kind === "map" && draft.campaign && !draft.campaign.complete) {
        draft.campaign = { ...draft.campaign, complete: true };
      }
    }
  } else if (info.category === "campaign") {
    if (runIndex >= 0) {
      const run = draft.runs[runIndex];
      finalizeRun(draft, runIndex, at, run.suspendedAt ? (run.endedBy ?? "campaign") : "campaign");
    }
  } else {
    // "other", or a map-category area below the map level floor.
    const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
    if (run && closed?.runId === run.id && !run.suspendedAt) {
      draft.runs[runIndex] = {
        ...run,
        subAreas: run.subAreas.includes(visit.areaId) ? run.subAreas : [...run.subAreas, visit.areaId],
      };
      visit.runId = run.id;
    }
  }

  // Campaign progress: monotonic by rank, towns after the act's areas.
  if (info.category === "campaign" || info.category === "town") {
    const rank = campaignRank(info) ?? 0;
    if (!draft.campaign || rank >= draft.campaign.rank) {
      draft.campaign = {
        areaId: visit.areaId,
        name: visit.name,
        act: info.act ?? 0,
        part: info.part ?? 1,
        areaLevel: level,
        at,
        isTown: info.category === "town",
        complete: draft.campaign?.complete ?? false,
        rank,
        ...(info.unverified ? { unverified: true } : {}),
      };
    }
  } else if (info.category === "endgame-town" && draft.campaign) {
    draft.campaign = { ...draft.campaign, complete: true };
  }

  draft.current = visit;
}

/** Fold one live client-log event into the session. Never throws. */
export function applyEvent(state: SessionState, event: ClientLogEvent): SessionState {
  if (!event || typeof event !== "object" || state.endedAt) return state;
  const draft = draftOf(state);
  try {
    switch (event.kind) {
      case "area":
        applyArea(draft, event);
        break;
      case "instance":
        draft.pendingInstance = event.address;
        break;
      case "death": {
        const runIndex = openRunIndex(draft);
        const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
        const inRun = run && draft.current?.runId === run.id ? run : undefined;
        if (inRun) draft.runs[runIndex] = { ...inRun, deaths: inRun.deaths + 1 };
        draft.deathsDropped += pushCapped(
          draft.deaths,
          {
            at: event.at,
            character: event.character,
            ...(draft.current ? { areaId: draft.current.areaId, areaName: draft.current.name } : {}),
            ...(draft.current?.runId ? { runId: draft.current.runId } : {}),
          },
          MAX_DEATHS,
        );
        if (event.character && !draft.characters.some((entry) => entry.name === event.character)) {
          upsertCharacter(draft, { name: event.character, seenAt: event.at, source: "death" });
        }
        break;
      }
      case "level-up":
        upsertCharacter(draft, {
          name: event.character,
          className: event.className,
          level: event.level,
          seenAt: event.at,
          source: "level-up",
        });
        pushCapped(
          draft.levelUps,
          { at: event.at, character: event.character, className: event.className, level: event.level },
          MAX_LEVEL_UPS,
        );
        break;
      case "afk": {
        const last = draft.afk.at(-1);
        if (event.on) {
          if (!last || last.to) pushCapped(draft.afk, { from: event.at }, MAX_AFK);
        } else if (last && !last.to) {
          draft.afk[draft.afk.length - 1] = { ...last, to: event.at };
        }
        break;
      }
      case "trade":
        if (event.result === "accepted") draft.trades.accepted += 1;
        else draft.trades.cancelled += 1;
        break;
      case "whisper":
        if (event.direction === "in") draft.whispers.in += 1;
        else draft.whispers.out += 1;
        break;
      default:
        break;
    }
  } catch {
    // A malformed event must never lose the session.
  }
  draft.lastEventAt = typeof event.at === "string" ? event.at : draft.lastEventAt;
  draft.eventCount += 1;
  return draft;
}

/** Wall-clock housekeeping: a run suspended longer than the window is over. */
export function applyTick(state: SessionState, now: string): SessionState {
  const index = state.runs.findIndex((run) => !run.endedAt);
  if (index < 0) return state;
  const run = state.runs[index];
  if (!run.suspendedAt || msBetween(run.suspendedAt, now) <= RUN_RESUME_WINDOW_MS) return state;
  const draft = draftOf(state);
  finalizeRun(draft, index, now, run.endedBy ?? "hideout");
  return draft;
}

export function endSession(state: SessionState, at: string, reason: SessionEndReason): SessionState {
  if (state.endedAt) return state;
  const draft = draftOf(state);
  const runIndex = openRunIndex(draft);
  if (draft.current) {
    const closed: AreaVisit = { ...draft.current, leftAt: at };
    const run = runIndex >= 0 ? draft.runs[runIndex] : undefined;
    if (closed.runId && run && run.id === closed.runId && !run.suspendedAt) {
      draft.runs[runIndex] = { ...run, activeMs: run.activeMs + msBetween(closed.enteredAt, at) };
    }
    draft.areasDropped += pushCapped(draft.areas, closed, MAX_AREAS);
    draft.current = undefined;
  }
  if (runIndex >= 0) {
    const run = draft.runs[runIndex];
    // A run the player left through the hideout counts as finished; one they
    // were still standing in when the game closed does not.
    finalizeRun(draft, runIndex, at, run.suspendedAt ? (run.endedBy ?? "hideout") : "session-end");
  }
  const lastAfk = draft.afk.at(-1);
  if (lastAfk && !lastAfk.to) draft.afk[draft.afk.length - 1] = { ...lastAfk, to: at };
  draft.endedAt = at;
  draft.endReason = reason;
  return draft;
}

export function setCharacterOverride(
  state: SessionState,
  override: { name: string; className?: string; level?: number } | undefined,
  at: string,
): SessionState {
  const draft = draftOf(state);
  draft.characters = draft.characters.filter((entry) => entry.source !== "override");
  if (override?.name) {
    draft.characters.push({
      name: override.name,
      className: override.className,
      level: override.level,
      seenAt: at,
      source: "override",
    });
    while (draft.characters.length > MAX_CHARACTERS) draft.characters.shift();
  }
  return draft;
}

const SOURCE_RANK: Record<CharacterSource, number> = {
  "level-up": 4,
  backfill: 3,
  override: 2,
  death: 1,
};

/** Best-known character: a level-up beats the backfill, which beats the override. */
export function currentCharacter(state: SessionState): SessionCharacter | undefined {
  let best: SessionCharacter | undefined;
  for (const entry of state.characters) {
    if (!best) {
      best = entry;
      continue;
    }
    const rank = SOURCE_RANK[entry.source] ?? 0;
    const bestRank = SOURCE_RANK[best.source] ?? 0;
    if (rank > bestRank) best = entry;
    else if (rank === bestRank && Date.parse(entry.seenAt) >= Date.parse(best.seenAt)) best = entry;
  }
  return best;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function sessionMetrics(state: SessionState, now: string): SessionMetrics {
  const end = state.endedAt ?? now;
  const wallMs = msBetween(state.startedAt, end);
  let afkMs = 0;
  for (const span of state.afk) afkMs += msBetween(span.from, span.to ?? end);
  afkMs = Math.min(afkMs, wallMs);
  const activeMs = Math.max(0, wallMs - afkMs);

  const mapRuns = state.runs.filter((run) => run.kind === "map");
  const completedMaps = mapRuns.filter((run) => run.completed && run.endedAt);
  const mapsCompleted = completedMaps.length;
  const durations = completedMaps.map((run) => run.activeMs).filter((ms) => ms > 0);
  const avgMapMs =
    durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : undefined;
  const deathsInMaps = mapRuns.reduce((sum, run) => sum + run.deaths, 0);

  const character = currentCharacter(state);
  const levels = state.levelUps
    .filter((entry) => !character || entry.character === character.name)
    .map((entry) => entry.level);
  const levelsGained = levels.length >= 2 ? Math.max(...levels) - Math.min(...levels) : 0;
  const lastLevelUp = state.levelUps.at(-1);

  const mapsPerHour =
    activeMs >= MIN_RATE_WINDOW_MS
      ? Math.round((mapsCompleted / (activeMs / 3_600_000)) * 10) / 10
      : undefined;

  return {
    wallMs,
    afkMs,
    activeMs,
    runsStarted: state.runs.length,
    mapsStarted: mapRuns.length,
    mapsCompleted,
    mapsAbandoned: mapRuns.filter((run) => run.endedAt && !run.completed).length,
    trialsCompleted: state.runs.filter((run) => run.kind === "trial" && run.completed).length,
    leagueCompleted: state.runs.filter((run) => run.kind === "league" && run.completed).length,
    ...(mapsPerHour === undefined ? {} : { mapsPerHour }),
    ...(avgMapMs === undefined ? {} : { avgMapMs }),
    ...(median(durations) === undefined ? {} : { medianMapMs: median(durations) }),
    deathsInMaps,
    ...(mapsCompleted > 0
      ? { deathsPerMap: Math.round((deathsInMaps / mapsCompleted) * 100) / 100 }
      : {}),
    deaths: state.deaths.length,
    levelsGained,
    levelUps: state.levelUps.length,
    ...(lastLevelUp ? { sinceLastLevelUpMs: msBetween(lastLevelUp.at, end) } : {}),
  };
}
