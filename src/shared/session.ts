/**
 * Renderer ↔ main contract for the "session" package (Home, character,
 * mapping, recap, death screenshots). Channels are `session:*`; the settings
 * namespace is `session`; the overlay panel is `session-recap`.
 *
 * Nothing here does input or network: every number is derived from
 * Client.txt, from files other packages wrote, or from the local caches.
 */
import type { FeatureCall } from "./features.js";
import type {
  CampaignProgress,
  MapRun,
  SessionCharacter,
  SessionMetrics,
  SessionState,
} from "../core/sessionTracker.js";
import type { SessionSummary } from "../core/sessionHistory.js";
import type {
  HomeRecommendation,
  MarketMovers,
  StashGains,
  TradeEarnings,
} from "../core/sessionHome.js";
import type { CaptureSkipReason, DeathCapture } from "../core/sessionDeaths.js";

export type {
  AfkSpan,
  AreaVisit,
  CampaignProgress,
  DeathMark,
  LevelUp,
  MapRun,
  RunEndedBy,
  RunKind,
  SessionCharacter,
  SessionEndReason,
  SessionMetrics,
  SessionState,
} from "../core/sessionTracker.js";
export type { SessionRecord, SessionSummary } from "../core/sessionHistory.js";
export type {
  HomeRecommendation,
  MarketMovers,
  MoverView,
  StashGains,
  TradeEarnings,
} from "../core/sessionHome.js";
export type { CaptureSkipReason, DeathCapture } from "../core/sessionDeaths.js";

export type RecapMode = "afk" | "full" | "mini";

export interface SessionRecapPayload {
  mode: RecapMode;
  at: string;
  summary: SessionSummary;
  metrics: SessionMetrics;
  campaign?: CampaignProgress & { levelDelta?: number; hint?: string };
  stash?: StashGains;
  trade?: TradeEarnings;
  recentRuns: MapRun[];
  trades: { accepted: number; cancelled: number };
  whispers: { in: number; out: number };
}

export interface SessionOverview {
  active: boolean;
  poeDetected: boolean;
  /** Trimmed for IPC (stateForView). */
  session?: SessionState;
  metrics?: SessionMetrics;
  character?: SessionCharacter;
  lastRecap?: SessionRecapPayload;
  lastError?: string;
  overlayAvailable: boolean;
  files: { current: string; history: string; deathsDir: string };
}

/** Numbers that would need an account link the app deliberately does not have. */
export interface AccountLinkedStat {
  available: false;
  reason: "needs account link (not available)";
}

export const ACCOUNT_LINKED_STAT: AccountLinkedStat = {
  available: false,
  reason: "needs account link (not available)",
};

export interface HomeOverview {
  generatedAt: string;
  clientLog: { watching: boolean; source: string; file?: string; error?: string; lastLineAt?: string };
  character?: SessionCharacter;
  area?: { areaId: string; name: string; category: string; level: number; enteredAt: string; unverified?: boolean };
  campaign?: CampaignProgress & {
    levelDelta?: number;
    hint?: string;
    tone: "safe" | "warning" | "neutral";
  };
  session: SessionOverview;
  recentMaps: MapRun[];
  xpPerHour: AccountLinkedStat;
  xpPerMap: AccountLinkedStat;
  goldPerMap: AccountLinkedStat;
  timeToLevel: AccountLinkedStat;
  stash: StashGains;
  trade: TradeEarnings;
  market: MarketMovers;
  recommendations: HomeRecommendation[];
  deathsRecent: number;
}

/**
 * The setup checklist belongs to the app-settings package (P10). Home only
 * RENDERS it, so the shape is declared here structurally instead of
 * importing another feature package.
 */
export interface HomeChecklistStep {
  id: string;
  label: string;
  state: "ok" | "todo" | "warn" | "optional" | "unknown";
  detail: string;
  optional: boolean;
  action?: string;
}

export interface HomeChecklistView {
  steps: HomeChecklistStep[];
  done: number;
  required: number;
  complete: boolean;
  dismissedAt?: string;
}

export interface HomeChecklistContract {
  "app:setup-checklist": FeatureCall<[], HomeChecklistView>;
}

/** Checklist `action` → the route Home links it to. */
export const CHECKLIST_ACTION_ROUTES: Record<string, string> = {
  "browse-log": "/tools/settings",
  "open-settings": "/tools/settings",
  "open-market-data": "/tools/settings",
  "check-leagues": "/tools/settings",
  "refresh-feed": "/tools/settings",
  "test-overlay": "/tools/settings",
  "open-hotkeys": "/tools/hotkeys",
  "open-calibration": "/tools/calibration",
};

export interface SessionSettings {
  afkRecap: boolean;
  afkRecapAutoClose: boolean;
  postGameRecap: boolean;
  postGameNotification: boolean;
  deathScreenshots: boolean;
  /**
   * Capture the whole screen when the Path of Exile window source is not
   * offered. Off by default: a screen grab can include Discord, a browser
   * and other people's chat.
   */
  allowScreenFallback: boolean;
  maxDeathScreenshots: number;
  idleEndMinutes: number;
  characterOverride?: { name: string; className?: string; level?: number };
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  afkRecap: true,
  afkRecapAutoClose: true,
  postGameRecap: true,
  postGameNotification: true,
  deathScreenshots: true,
  allowScreenFallback: false,
  maxDeathScreenshots: 60,
  idleEndMinutes: 30,
};

export const MIN_DEATH_SCREENSHOTS = 1;
export const MAX_DEATH_SCREENSHOTS = 500;
export const MIN_IDLE_END_MINUTES = 5;
export const MAX_IDLE_END_MINUTES = 240;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** SettingsStore sanitizer shape `(raw) => T`; never throws. */
export function normalizeSessionSettings(raw: unknown): SessionSettings {
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const maxShots = Number(source.maxDeathScreenshots);
  const idle = Number(source.idleEndMinutes);
  const override =
    typeof source.characterOverride === "object" &&
    source.characterOverride !== null &&
    !Array.isArray(source.characterOverride)
      ? (source.characterOverride as Record<string, unknown>)
      : undefined;
  const name = typeof override?.name === "string" ? override.name.trim().slice(0, 40) : "";
  const className =
    typeof override?.className === "string" ? override.className.trim().slice(0, 40) : "";
  const level = Number(override?.level);
  return {
    afkRecap: boolOr(source.afkRecap, DEFAULT_SESSION_SETTINGS.afkRecap),
    afkRecapAutoClose: boolOr(source.afkRecapAutoClose, DEFAULT_SESSION_SETTINGS.afkRecapAutoClose),
    postGameRecap: boolOr(source.postGameRecap, DEFAULT_SESSION_SETTINGS.postGameRecap),
    postGameNotification: boolOr(
      source.postGameNotification,
      DEFAULT_SESSION_SETTINGS.postGameNotification,
    ),
    deathScreenshots: boolOr(source.deathScreenshots, DEFAULT_SESSION_SETTINGS.deathScreenshots),
    allowScreenFallback: boolOr(source.allowScreenFallback, DEFAULT_SESSION_SETTINGS.allowScreenFallback),
    maxDeathScreenshots: Number.isFinite(maxShots)
      ? clamp(maxShots, MIN_DEATH_SCREENSHOTS, MAX_DEATH_SCREENSHOTS)
      : DEFAULT_SESSION_SETTINGS.maxDeathScreenshots,
    idleEndMinutes: Number.isFinite(idle)
      ? clamp(idle, MIN_IDLE_END_MINUTES, MAX_IDLE_END_MINUTES)
      : DEFAULT_SESSION_SETTINGS.idleEndMinutes,
    ...(name
      ? {
          characterOverride: {
            name,
            ...(className ? { className } : {}),
            ...(Number.isFinite(level) && level > 0 ? { level: clamp(level, 1, 100) } : {}),
          },
        }
      : {}),
  };
}

/** The same rules, reported for the settings UI (the store returns only the value). */
export function sessionSettingsIssues(raw: unknown): string[] {
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const issues: string[] = [];
  const maxShots = Number(source.maxDeathScreenshots);
  if (source.maxDeathScreenshots !== undefined && !Number.isFinite(maxShots)) {
    issues.push("Max screenshots must be a number; the default 60 was kept.");
  } else if (
    Number.isFinite(maxShots) &&
    (maxShots < MIN_DEATH_SCREENSHOTS || maxShots > MAX_DEATH_SCREENSHOTS)
  ) {
    issues.push(`Max screenshots was clamped to ${MIN_DEATH_SCREENSHOTS}–${MAX_DEATH_SCREENSHOTS}.`);
  }
  const idle = Number(source.idleEndMinutes);
  if (source.idleEndMinutes !== undefined && !Number.isFinite(idle)) {
    issues.push("Idle end minutes must be a number; the default 30 was kept.");
  } else if (Number.isFinite(idle) && (idle < MIN_IDLE_END_MINUTES || idle > MAX_IDLE_END_MINUTES)) {
    issues.push(`Idle end was clamped to ${MIN_IDLE_END_MINUTES}–${MAX_IDLE_END_MINUTES} minutes.`);
  }
  const override =
    typeof source.characterOverride === "object" &&
    source.characterOverride !== null &&
    !Array.isArray(source.characterOverride)
      ? (source.characterOverride as Record<string, unknown>)
      : undefined;
  if (override) {
    const name = typeof override.name === "string" ? override.name.trim() : "";
    if (!name) issues.push("The character override needs a name; it was dropped.");
    else if (name.length > 40) issues.push("The override name was cut to 40 characters.");
    const level = Number(override.level);
    if (override.level !== undefined && (!Number.isFinite(level) || level < 1 || level > 100)) {
      issues.push("The override level must be 1–100; it was clamped or dropped.");
    }
  }
  return issues;
}

export interface SessionContract {
  "session:overview": FeatureCall<[], SessionOverview>;
  "session:home": FeatureCall<[], HomeOverview>;
  /** Newest first, default 50. */
  "session:history": FeatureCall<[limit?: number], SessionSummary[]>;
  "session:history-get": FeatureCall<[id: string], SessionRecordView | undefined>;
  "session:history-delete": FeatureCall<[id: string], SessionSummary[]>;
  /** Manual end; the next log event or process sighting starts a new one. */
  "session:end": FeatureCall<[], SessionOverview>;
  /** Opens the recap panel from the desktop; false when the overlay is absent. */
  "session:recap-show": FeatureCall<[mode: RecapMode], boolean>;
  "session:deaths": FeatureCall<[limit?: number], DeathCapture[]>;
  /** data:image/jpeg;base64,… for one thumbnail, or undefined. */
  "session:death-thumbnail": FeatureCall<[id: string], string | undefined>;
  "session:death-open": FeatureCall<[id: string], boolean>;
  "session:death-delete": FeatureCall<[id: string], DeathCapture[]>;
  "session:deaths-open-folder": FeatureCall<[], boolean>;
  "session:capture-now": FeatureCall<[], DeathCapture | { skipped: CaptureSkipReason }>;
}

/** What `session:history-get` returns: the record with its state trimmed for IPC. */
export interface SessionRecordView {
  version: 1;
  state: SessionState;
  metrics: SessionMetrics;
  stash?: StashGains;
  savedAt: string;
  summary: SessionSummary;
}

export interface SessionEvents {
  /** Throttled to at most two a second. */
  "session:changed": SessionOverview;
  /** AFK on (mode "afk") or the post-game recap (mode "full"). */
  "session:recap": SessionRecapPayload;
  "session:death": DeathCapture;
}

export const SESSION_RECAP_PANEL_ID = "session-recap";
