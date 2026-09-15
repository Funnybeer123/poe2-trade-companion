/**
 * Renderer ↔ main contract for the "inspect" package: the item insight
 * overlay (Alt+I) and its map warnings.
 *
 * The report shapes themselves are computed in `src/core/inspect.ts` and
 * only re-exported here, so the renderer has one import and the core stays
 * the single definition. What this file owns: the channels, the settings
 * namespace with its sanitizer, the payload guard the overlay panel uses
 * before rendering anything, and the panel/hotkey constants the module and
 * the integrator must agree on.
 *
 * Pure: no Electron, no DOM.
 */

import type { FeatureCall } from "./features.js";
import type { InspectReport } from "../core/inspect.js";
import type { DangerousMapMod, MapModSeverity } from "../core/inspectMapMods.js";

export type {
  AffixSide,
  InspectAffixSummary,
  InspectMaxTier,
  InspectMod,
  InspectRange,
  InspectReport,
  InspectTierInfo,
} from "../core/inspect.js";
export type {
  DangerousMapMod,
  MapModSeverity,
  MapWarning,
  MapWarningReport,
} from "../core/inspectMapMods.js";
export type { DefenceEntry, DefenceSummary, WeaponDps } from "../core/itemStats.js";
export type { InspectLink } from "../core/inspectLinks.js";

/** Settings namespace id and channel prefix. */
export const INSPECT_SETTINGS_ID = "inspect";

export interface InspectShowOutcome {
  shown: boolean;
  /** The same item was already on screen, so the hotkey closed the panel. */
  hidden?: boolean;
  /**
   * Why nothing was shown. `no-item-text` is an empty or non-item
   * clipboard; `text-too-large` is a paste past `MAX_INSPECT_TEXT_LENGTH`;
   * `analysis-failed` is item text the analyser could not read — three
   * different things to tell the user, and three different log trails.
   */
  reason?: "no-item-text" | "text-too-large" | "analysis-failed";
  fingerprint?: string;
}

/** One table row for the settings section: the entry plus the user's rating. */
export interface DangerousMapModView extends DangerousMapMod {
  effectiveSeverity: MapModSeverity | "ignore";
}

export interface InspectSettings {
  /** Where the panel opens. */
  anchor: "cursor" | "right" | "left" | "top-right";
  /** Show the "at 20 % quality" estimates next to DPS and defences. */
  showQualityNormalised: boolean;
  /** While the panel is pinned, follow the clipboard (1 Hz, read-only). */
  followClipboardWhilePinned: boolean;
  /**
   * Press the hotkey to copy the hovered item first (one audited Ctrl+C
   * through the chat-command gates). Off by default: the zero-input path is
   * "hover, Ctrl+C yourself, then Alt+I".
   */
  copyOnHotkey: boolean;
  /** Map-mod entry id → the user's own rating, or "ignore". */
  mapModOverrides: Record<string, MapModSeverity | "ignore">;
}

export const DEFAULT_INSPECT_SETTINGS: InspectSettings = {
  anchor: "cursor",
  showQualityNormalised: true,
  followClipboardWhilePinned: true,
  copyOnHotkey: false,
  mapModOverrides: {},
};

const ANCHORS: ReadonlyArray<InspectSettings["anchor"]> = ["cursor", "right", "left", "top-right"];
const SEVERITIES: ReadonlyArray<MapModSeverity | "ignore"> = [
  "deadly",
  "dangerous",
  "caution",
  "info",
  "ignore",
];
const OVERRIDE_KEY = /^[a-z0-9-]{1,64}$/;
const MAX_OVERRIDES = 200;

/**
 * Settings namespace "inspect". Never throws: a hand-edited file falls back
 * to the defaults field by field, and only well-formed override entries
 * survive (id charset, known severity, at most 200 rows).
 */
export function normalizeInspectSettings(raw: unknown): InspectSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof InspectSettings, unknown>
  >;
  const anchor = ANCHORS.find((candidate) => candidate === source.anchor) ?? DEFAULT_INSPECT_SETTINGS.anchor;
  const overrides: Record<string, MapModSeverity | "ignore"> = {};
  const rawOverrides = source.mapModOverrides;
  if (typeof rawOverrides === "object" && rawOverrides !== null && !Array.isArray(rawOverrides)) {
    for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (Object.keys(overrides).length >= MAX_OVERRIDES) break;
      if (!OVERRIDE_KEY.test(key)) continue;
      const severity = SEVERITIES.find((candidate) => candidate === value);
      if (!severity) continue;
      overrides[key] = severity;
    }
  }
  return {
    anchor,
    showQualityNormalised: source.showQualityNormalised !== false,
    followClipboardWhilePinned: source.followClipboardWhilePinned !== false,
    copyOnHotkey: source.copyOnHotkey === true,
    mapModOverrides: overrides,
  };
}

/**
 * Overlay payload guard. The panel renders whatever main sends it, so a
 * malformed payload must degrade to the empty state rather than throw
 * inside the overlay window.
 */
export function isInspectReport(value: unknown): value is InspectReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<InspectReport>;
  if (report.schemaVersion !== 1) return false;
  if (typeof report.fingerprint !== "string") return false;
  if (report.textKind !== "plain" && report.textKind !== "advanced") return false;
  if (typeof report.item !== "object" || report.item === null) return false;
  if (typeof report.item.itemClass !== "string" || typeof report.item.rarity !== "string") return false;
  if (!Array.isArray(report.mods)) return false;
  if (typeof report.affixes !== "object" || report.affixes === null) return false;
  if (!Array.isArray(report.links)) return false;
  if (!Array.isArray(report.notes)) return false;
  if (typeof report.knowledge !== "object" || report.knowledge === null) return false;
  return true;
}

export interface InspectContract {
  /** Pure analysis of one item text with main's learned tiers, catalogue and area. */
  "inspect:analyze": FeatureCall<[text: string], InspectReport | null>;
  /** Show (or re-show) the overlay panel; same item twice toggles it off. */
  "inspect:show": FeatureCall<[text?: string], InspectShowOutcome>;
  "inspect:hide": FeatureCall<[], void>;
  "inspect:last": FeatureCall<[], InspectReport | null>;
  /** Opens an allowlisted wiki / poe2db URL in the default browser. */
  "inspect:open-link": FeatureCall<[url: string], { ok: boolean; reason?: "not-allowed" | "failed" }>;
  /** The curated map-mod table merged with the user's overrides. */
  "inspect:map-mods": FeatureCall<[], DangerousMapModView[]>;
}

export interface InspectEvents {
  /** A new report was produced by the hotkey or the follow-while-pinned poll. */
  "inspect:report": InspectReport;
}

export const INSPECT_HOTKEY_ACTION = {
  id: "inspect.show",
  label: "Inspect item",
  detail:
    "Tiers, rolls, DPS and map warnings for the item on the clipboard — hover it and press Ctrl+C first.",
  group: "Overlay",
  defaultAccelerator: "Alt+I",
} as const;

export const INSPECT_PANEL_ID = "inspect";
export const INSPECT_PANEL_SIZE = { width: 440, height: 560 } as const;
