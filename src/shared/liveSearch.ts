/**
 * Live search (trade2 websocket) contract shared by main and the renderer.
 *
 * Starting a live search is a main-side service call (a wave-2 feature
 * such as Market owns the "start" gesture and its handlers); the channels
 * here only list, stop and report capacity, and the state event keeps the
 * UI in step. Pure: no Electron, no DOM, no `ws`.
 */
import type { FeatureCall } from "./features.js";
import type { TradeListing } from "../core/tradeListings.js";

export type LiveSearchState = "connecting" | "open" | "closed" | "error" | "needs-session";

export interface LiveSearchHandle {
  id: string;
  searchId: string;
  league: string;
  label: string;
  state: LiveSearchState;
  error?: string;
  resultsSeen: number;
  /**
   * Ids the socket announced that were never fetched because the trade2
   * budget was too thin (or a penalty window was in force). Absent until it
   * happens; those ids are dropped, never retried. The UI reads it as
   * "n results not fetched — trade2 budget".
   */
  skippedResults?: number;
  openedAt?: string;
}

export interface LiveSearchContract {
  "live-search:list": FeatureCall<[], LiveSearchHandle[]>;
  "live-search:stop": FeatureCall<[id: string], LiveSearchHandle[]>;
  "live-search:capacity": FeatureCall<[], { open: number; max: number }>;
}

export interface LiveSearchEvents {
  "live-search:state": LiveSearchHandle[];
  /** Extra: every listing a live search produced, for sounds/notifications in the UI. */
  "live-search:listing": { handleId: string; listing: TradeListing };
}

/** The site allows twenty simultaneous live searches; so do we, never more. */
export const LIVE_SEARCH_MAX_OPEN = 20;

/** Settings namespace "live-search". */
export interface LiveSearchSettings {
  /** Simultaneous sockets allowed (1–20; default 20). */
  maxOpen: number;
  /** Play a sound when a live search produces a listing (the UI honours it). */
  sound: boolean;
}

export const DEFAULT_LIVE_SEARCH_SETTINGS: Readonly<LiveSearchSettings> = { maxOpen: LIVE_SEARCH_MAX_OPEN, sound: true };

/** Sanitize whatever the settings file holds; issues explain what was dropped. */
export function normalizeLiveSearchSettings(raw: unknown): { value: LiveSearchSettings; issues: string[] } {
  const issues: string[] = [];
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let maxOpen = DEFAULT_LIVE_SEARCH_SETTINGS.maxOpen;
  if (source.maxOpen !== undefined) {
    const parsed = Number(source.maxOpen);
    if (Number.isFinite(parsed)) {
      maxOpen = Math.min(LIVE_SEARCH_MAX_OPEN, Math.max(1, Math.floor(parsed)));
      if (maxOpen !== parsed) issues.push(`maxOpen clamped to ${maxOpen}`);
    } else {
      issues.push("maxOpen is not a number; default kept");
    }
  }
  let sound = DEFAULT_LIVE_SEARCH_SETTINGS.sound;
  if (source.sound !== undefined) {
    if (typeof source.sound === "boolean") sound = source.sound;
    else issues.push("sound is not a boolean; default kept");
  }
  return { value: { maxOpen, sound }, issues };
}
