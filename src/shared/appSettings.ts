/**
 * Contract for the "appSettings" feature package: the Tools → Settings
 * sections, the first-run checklist, the changelog tab, the admin-rights
 * hint and the window/overlay options.
 *
 * Everything here is desktop-side configuration and read-outs. The package
 * sends NO game input, opens no network connection of its own and stores no
 * secret — `normalizeAppSettings` drops every key it does not know, so a
 * token can never land in the `app` namespace of companion-settings.json.
 *
 * Pure module (no Electron, no DOM): both processes and the tests share it.
 */
import type { FeatureCall, SettingsSnapshot } from "./features.js";
import {
  DEFAULT_MAIN_WINDOW_SIZE,
  sanitizeWindowBounds,
  type DisplayArea,
  type WindowBounds,
} from "../core/appSettingsWindow.js";

export type { DisplayArea, WindowBounds };
export { DEFAULT_MAIN_WINDOW_SIZE };

/** Settings namespace id and channel prefix. */
export const APP_SETTINGS_ID = "app" as const;

export interface AppWindowSettings {
  /** Restore the desktop window's last position and size on start. */
  rememberBounds: boolean;
  /** Today's behaviour: the companion window stays above the game. */
  alwaysOnTop: boolean;
  /** Show the (hidden or minimised) companion window when PoE2 appears. */
  showOnGameStart: boolean;
  bounds?: WindowBounds;
}

export interface AppSetupSettings {
  /** Set when the user dismissed the first-run checklist. */
  dismissedAt?: string;
  /** Set the first time an overlay test panel was actually shown. */
  overlayTestedAt?: string;
}

export interface AppChangelogSettings {
  /** "" = the changelog was never opened; everything counts as new. */
  lastSeenVersion: string;
}

export interface AppSettings {
  window: AppWindowSettings;
  setup: AppSetupSettings;
  changelog: AppChangelogSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  window: { rememberBounds: true, alwaysOnTop: true, showOnGameStart: false },
  setup: {},
  changelog: { lastSeenVersion: "" },
};

/** Longest version string we keep; anything longer is a bug or an attack. */
const MAX_VERSION_LENGTH = 32;
const VERSION_CHARS = /^[0-9A-Za-z.\-+]+$/;

function boolOr(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

/** ISO timestamps are kept only when they actually parse. */
function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function sanitizeVersion(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VERSION_LENGTH) return "";
  return VERSION_CHARS.test(trimmed) ? trimmed : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Sanitizer for the settings namespace "app". Never throws; junk falls back
 * to the defaults and every unknown key is dropped — a stray `sounds`,
 * `notifications`, `currencyDisplay` or `webhooks` object from an older draft
 * build is not persisted, and no secret can survive a round trip.
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const source = record(raw);
  const window = record(source.window);
  const setup = record(source.setup);
  const changelog = record(source.changelog);
  const bounds = sanitizeWindowBounds(window.bounds);
  const dismissedAt = isoOrUndefined(setup.dismissedAt);
  const overlayTestedAt = isoOrUndefined(setup.overlayTestedAt);
  return {
    window: {
      rememberBounds: boolOr(window.rememberBounds, DEFAULT_APP_SETTINGS.window.rememberBounds),
      alwaysOnTop: boolOr(window.alwaysOnTop, DEFAULT_APP_SETTINGS.window.alwaysOnTop),
      showOnGameStart: boolOr(window.showOnGameStart, DEFAULT_APP_SETTINGS.window.showOnGameStart),
      ...(bounds ? { bounds } : {}),
    },
    setup: {
      ...(dismissedAt ? { dismissedAt } : {}),
      ...(overlayTestedAt ? { overlayTestedAt } : {}),
    },
    changelog: { lastSeenVersion: sanitizeVersion(changelog.lastSeenVersion) },
  };
}

// ---------------------------------------------------------------------------
// Read-outs
// ---------------------------------------------------------------------------

export interface AppInfo {
  version: string;
  buildMode: "public-companion" | "assistive-access" | "authorized-qa";
  packaged: boolean;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
  userDataDir: string;
  configDir: string;
  appPath: string;
  settingsFile: string;
  hotkeysFile: string;
  changelogFile: string;
}

export interface ChangelogPayload {
  markdown: string;
  source: string;
  missing: boolean;
}

/** How confident the probe is that Path of Exile runs elevated. */
export type ElevationVerdict = "no" | "likely" | "unknown";

export interface ElevationProcessRow {
  name: string;
  pid: number;
  access: "ok" | "denied" | "error";
}

export interface ElevationReport {
  appElevated: boolean | "unknown";
  poeRunning: boolean;
  poeElevated: ElevationVerdict;
  processes: ElevationProcessRow[];
  /** Set only for the actionable case: the game is elevated and the app is not. */
  hint?: string;
  checkedAt: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Setup checklist — the shape is FROZEN: P7's Home renders the same steps
// from its own structural type. Field names never change without a P7 note.
// ---------------------------------------------------------------------------

export type SetupStepId =
  | "game-detected"
  | "client-log"
  | "league"
  | "price-feed"
  | "session-cookie"
  | "hotkeys"
  | "overlay"
  | "admin-rights"
  | "calibration"
  | "chat-commands";

export type SetupStepState = "ok" | "todo" | "warn" | "optional" | "unknown";

export type SetupStepAction =
  | "browse-log"
  | "check-leagues"
  | "refresh-feed"
  | "open-hotkeys"
  | "test-overlay"
  | "open-settings"
  | "open-calibration"
  | "open-market-data";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  detail: string;
  optional: boolean;
  action?: SetupStepAction;
}

export interface SetupChecklist {
  steps: SetupStep[];
  done: number;
  required: number;
  complete: boolean;
  dismissedAt?: string;
  generatedAt: string;
}

export interface ResetWindowsResult {
  mainWindow: WindowBounds | null;
  overlayPanelsHidden: number;
}

export interface OpenFolderResult {
  ok: boolean;
  error?: string;
}

/** The only namespaces `app:reset-settings` will touch. */
export type ResettableNamespace = "app" | "overlay";

export interface AppSettingsContract {
  "app:info": FeatureCall<[], AppInfo>;
  "app:changelog": FeatureCall<[], ChangelogPayload>;
  "app:setup-checklist": FeatureCall<[], SetupChecklist>;
  "app:dismiss-checklist": FeatureCall<[dismissed: boolean], SetupChecklist>;
  /** Memoised in main (≤ 1 PowerShell launch per 30 s); `force` bypasses the memo. */
  "app:elevation": FeatureCall<[force?: boolean], ElevationReport>;
  "app:relaunch-elevated": FeatureCall<[], { ok: boolean; error?: string }>;
  "app:reset-windows": FeatureCall<[], ResetWindowsResult>;
  "app:test-overlay": FeatureCall<[], void>;
  "app:open-folder": FeatureCall<[which: "userData" | "configDir" | "settingsFile"], OpenFolderResult>;
  "app:reset-settings": FeatureCall<[namespaces: ResettableNamespace[]], SettingsSnapshot>;
}

export interface AppSettingsEvents {
  /** Only when a probe's verdict differs from the previous one. */
  "app:elevation-changed": ElevationReport;
  /** After dismiss / overlay test / settings reset. */
  "app:checklist-changed": SetupChecklist;
}
