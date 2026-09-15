/**
 * Renderer ↔ main contract for the Client.txt service (feature "clientLog",
 * channels `client-log:*`). The event and area types live in src/core so
 * the parser stays pure; they are re-exported here so renderer code has one
 * import.
 */
import type { FeatureCall } from "./features.js";
import type { ClientLogEvent } from "../core/clientLog.js";
import type { GameSettings } from "../core/gameSettingsFile.js";

export type {
  AreaCategory,
  AreaInfo,
  ChatChannel,
  ClientLogEvent,
  ClientLogEventKind,
  TradeWhisper,
} from "../core/clientLog.js";
export type { GameSettings } from "../core/gameSettingsFile.js";

export type ClientLogSource = "override" | "steam" | "standalone" | "epic" | "none";

export interface ClientLogStatus {
  file?: string;
  source: ClientLogSource;
  watching: boolean;
  sizeBytes?: number;
  lastLineAt?: string;
  error?: string;
  /** From the latest level-up line seen (backfill included). */
  character?: { name: string; className: string; level: number; seenAt: string };
  /** The latest area event seen (backfill included). */
  area?: Extract<ClientLogEvent, { kind: "area" }>;
  gameSettings?: GameSettings;
}

/** Settings namespace "client-log". */
export interface ClientLogSettings {
  /** User override for the Client.txt path; undefined = auto-locate. */
  file?: string;
  /** Gate for `client-log:inject` (parse + emit an arbitrary line). Off by default. */
  allowInject: boolean;
}

export interface ClientLogContract {
  "client-log:status": FeatureCall<[], ClientLogStatus>;
  "client-log:recent": FeatureCall<[kind?: string, limit?: number], ClientLogEvent[]>;
  "client-log:set-file": FeatureCall<[file: string | null], ClientLogStatus>;
  /** OS open dialog; the chosen file becomes the override. */
  "client-log:browse-file": FeatureCall<[], ClientLogStatus>;
  /** Dev/testing: parse + emit one line. Refused unless settings "client-log".allowInject is true. */
  "client-log:inject": FeatureCall<[line: string], ClientLogEvent | undefined>;
  /**
   * Re-read poe2_production_Config.ini and return the refreshed status —
   * for after the user changed the game's resolution or chat key. Reads a
   * file; starts nothing.
   */
  "client-log:reload-settings": FeatureCall<[], ClientLogStatus>;
}

export interface ClientLogEvents {
  "client-log:event": ClientLogEvent;
  "client-log:status": ClientLogStatus;
}
