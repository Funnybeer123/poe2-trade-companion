/**
 * Stash tracker contract (package "stash-tracker").
 *
 * Renderer-safe: types, the settings sanitizer, the channel/event maps and
 * the two file names. No Electron, no fs, no DOM — the tool, the overlay
 * legend panel and the main-process service all read the shapes from here.
 *
 * Every value in these payloads is an ESTIMATE derived from the local price
 * table and the sorter's appraisals; nothing is a guaranteed sale price.
 */
import type { FeatureCall } from "./features.js";
import {
  MAX_EXCLUDED,
  MAX_AUTO_SNAPSHOTS,
  type SessionGains,
  type SnapshotDelta,
  type SnapshotDiff,
  type SnapshotItem,
  type SnapshotKind,
  type SnapshotMeta,
  type WealthSnapshot,
} from "../core/stashTrackerSnapshot.js";

export type {
  SessionGains,
  SnapshotDelta,
  SnapshotDiff,
  SnapshotItem,
  SnapshotKind,
  SnapshotMeta,
  WealthSnapshot,
};

export interface StashTrackerOverlaySettings {
  /** The tab labelled last; restored on the next Alt+P. */
  lastTab?: string;
  /** Tabs the user marked as top-level (T1…T99 are detected automatically). */
  topLevelTabs: string[];
  fadeByValue: boolean;
  showUnpriced: boolean;
  minLabelExalted: number;
  showLegend: boolean;
}

export interface StashTrackerSettings {
  excludedFingerprints: string[];
  autoSnapshot: boolean;
  maxAutoSnapshots: number;
  overlay: StashTrackerOverlaySettings;
}

export const DEFAULT_STASH_TRACKER_SETTINGS: StashTrackerSettings = {
  excludedFingerprints: [],
  autoSnapshot: true,
  maxAutoSnapshots: MAX_AUTO_SNAPSHOTS,
  overlay: {
    topLevelTabs: [],
    fadeByValue: true,
    showUnpriced: true,
    minLabelExalted: 0,
    showLegend: true,
  },
};

const FINGERPRINT = /^[0-9a-f]{16}$/i;
const MAX_TOP_LEVEL_TABS = 200;
const MAX_TAB_LABEL = 80;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stringList(raw: unknown, limit: number, maxLength: number, pattern?: RegExp): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().slice(0, maxLength);
    if (!value || seen.has(value)) continue;
    if (pattern && !pattern.test(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Never throws: a hand-edited settings file can only ever shrink what the
 * tracker does, never make it draw somewhere impossible or grow unbounded.
 */
export function normalizeStashTrackerSettings(raw: unknown): StashTrackerSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof StashTrackerSettings, unknown>
  >;
  const overlayRaw = (typeof source.overlay === "object" && source.overlay !== null
    ? source.overlay
    : {}) as Partial<Record<keyof StashTrackerOverlaySettings, unknown>>;
  const lastTab =
    typeof overlayRaw.lastTab === "string" && overlayRaw.lastTab.trim()
      ? overlayRaw.lastTab.trim().slice(0, MAX_TAB_LABEL)
      : undefined;
  return {
    excludedFingerprints: stringList(source.excludedFingerprints, MAX_EXCLUDED, 64, FINGERPRINT),
    autoSnapshot: source.autoSnapshot !== false,
    maxAutoSnapshots: Math.round(
      clampNumber(source.maxAutoSnapshots, 20, 500, DEFAULT_STASH_TRACKER_SETTINGS.maxAutoSnapshots),
    ),
    overlay: {
      ...(lastTab ? { lastTab } : {}),
      topLevelTabs: stringList(overlayRaw.topLevelTabs, MAX_TOP_LEVEL_TABS, MAX_TAB_LABEL),
      fadeByValue: overlayRaw.fadeByValue !== false,
      showUnpriced: overlayRaw.showUnpriced !== false,
      minLabelExalted: clampNumber(overlayRaw.minLabelExalted, 0, 1_000_000, 0),
      showLegend: overlayRaw.showLegend !== false,
    },
  };
}

/** What `stash-tracker:configure` accepts: a deep-partial of the settings. */
export interface StashTrackerSettingsPatch {
  excludedFingerprints?: string[];
  autoSnapshot?: boolean;
  maxAutoSnapshots?: number;
  overlay?: Partial<StashTrackerOverlaySettings>;
}

export interface LedgerStatus {
  file: string;
  exists: boolean;
  recordCount: number;
  observationCount: number;
  newestAt?: string;
  ageMs?: number;
  locations: string[];
  error?: string;
}

export interface PriceOverlayStatus {
  visible: boolean;
  legendVisible: boolean;
  tab?: string;
  topLevel: boolean;
  tabs: string[];
  lastScanAt?: string;
  ageMs?: number;
  totalExalted?: number;
  priced: number;
  unpriced: number;
  items: number;
  geometrySource?: string;
  error?: string;
  poeRunning: boolean;
}

export interface StashTrackerOverview {
  generatedAt: string;
  sessionId: string;
  ledger: LedgerStatus;
  /** The unsaved snapshot of the live ledger (raw — exclusions not applied). */
  current?: SnapshotMeta;
  /** Newest first. */
  snapshots: SnapshotMeta[];
  session: SessionGains;
  settings: StashTrackerSettings;
  overlay: PriceOverlayStatus;
  files: { snapshots: string; summary: string };
  /** Last write/read failure; never thrown from a tick. */
  lastError?: string;
}

export interface StashTrackerContract {
  "stash-tracker:overview": FeatureCall<[], StashTrackerOverview>;
  /** The live ledger as an unsaved snapshot (raw; the UI applies exclusions). */
  "stash-tracker:current": FeatureCall<[], WealthSnapshot | undefined>;
  "stash-tracker:snapshot": FeatureCall<[label?: string], StashTrackerOverview>;
  "stash-tracker:snapshot-get": FeatureCall<[id: string], WealthSnapshot | undefined>;
  "stash-tracker:rename": FeatureCall<[id: string, label: string], StashTrackerOverview>;
  "stash-tracker:delete": FeatureCall<[id: string], StashTrackerOverview>;
  "stash-tracker:compare": FeatureCall<[fromId: string, toId: string], SnapshotDiff | undefined>;
  "stash-tracker:session-start": FeatureCall<[], StashTrackerOverview>;
  "stash-tracker:session-gains": FeatureCall<[], SessionGains>;
  "stash-tracker:exclude": FeatureCall<
    [fingerprint: string, excluded: boolean],
    StashTrackerSettings
  >;
  "stash-tracker:configure": FeatureCall<
    [patch: StashTrackerSettingsPatch],
    StashTrackerSettings
  >;
  "stash-tracker:overlay-toggle": FeatureCall<[tab?: string], PriceOverlayStatus>;
  "stash-tracker:overlay-show": FeatureCall<[tab?: string], PriceOverlayStatus>;
  "stash-tracker:overlay-hide": FeatureCall<[], PriceOverlayStatus>;
  "stash-tracker:overlay-next": FeatureCall<[direction: number], PriceOverlayStatus>;
  "stash-tracker:overlay-top-level": FeatureCall<
    [tab: string, topLevel: boolean],
    PriceOverlayStatus
  >;
  "stash-tracker:overlay-status": FeatureCall<[], PriceOverlayStatus>;
}

export interface StashTrackerEvents {
  "stash-tracker:changed": StashTrackerOverview;
  "stash-tracker:overlay": PriceOverlayStatus;
}

/** `<userData>/stash-tracker/` — private state, never under artifacts/. */
export const STASH_TRACKER_DIR = "stash-tracker";
export const STASH_SNAPSHOTS_FILE = "snapshots.jsonl";
export const STASH_TRACKER_SUMMARY_FILE = "summary.json";
/**
 * A copy of the summary at the userData root under the name the Session /
 * Home package looks for. Keep both until that package pins one path.
 */
export const STASH_TRACKER_SUMMARY_MIRROR = "stash-tracker-summary.json";

/** The overlay legend panel id (registered in src/renderer/overlay/panels.ts). */
export const STASH_PRICES_PANEL = "stash-prices";
