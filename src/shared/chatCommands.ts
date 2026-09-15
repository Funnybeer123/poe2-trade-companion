/**
 * Chat command contract (feature package "chatCommands", channels `chat:*`).
 *
 * One chat line per user gesture: the service types exactly one line into
 * the game (Enter, text, Enter), fills the stash search box once, or copies
 * the hovered item with a single Ctrl+C (`chat:copy-hovered` — the one
 * audited capture path Evaluate and Inspect share). Every
 * attempt — emitted, blocked, or dry-run — produces one ChatCommandOutcome,
 * is appended to the QA action trace, and is announced as `chat:sent` and
 * `chat:status` events. Pure types only: no Electron, no DOM.
 */
import type { FeatureCall } from "./features.js";

export type ChatSource =
  | "trade"
  | "command"
  | "market"
  | "stash-search"
  | "notes"
  | "evaluate"
  | "inspect"
  | "other";

export interface ChatCommandRequest {
  text: string;
  /** Free-text reason for the trace ("invite buyer", "hideout from listing", …). */
  reason: string;
  source: ChatSource;
  /**
   * Bring Path of Exile to the foreground first (host `focus`), then verify.
   * Off by default: a hotkey pressed in the game already has it foreground,
   * while a button in the desktop app needs the hand-off. Still one gesture.
   */
  focus?: boolean;
}

/** Options for `chat:stash-search` (the text and reason stay positional). */
export interface StashSearchOptions {
  /**
   * Bring Path of Exile to the foreground first (host `focus`), then verify —
   * exactly what `ChatCommandRequest.focus` does for a chat line. Needed when
   * the gesture starts in the desktop app instead of in the game.
   */
  focus?: boolean;
}

/** Payload of `chat:copy-hovered`: one audited Ctrl+C over the hovered item. */
export interface ChatCopyRequest {
  /** Free-text reason for the trace ("evaluate hovered item", "inspect", …). */
  reason: string;
  source: ChatSource;
}

export type ChatBlockReason =
  | "kill-switch"
  | "another-host"
  | "not-foreground"
  | "process-not-allowed"
  | "rate-limit"
  | "disabled"
  | "empty"
  | "too-long"
  /** The clipboard never showed item text within the copy window (copy-hovered). */
  | "timeout"
  | "host-error";

export interface ChatCommandOutcome {
  ok: boolean;
  dryRun: boolean;
  /** The sanitized line that was (or would have been) typed. */
  sent?: string;
  blockedBy?: ChatBlockReason;
  error?: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

/**
 * `copyHoveredItem`'s answer. `text` is the item text Path of Exile put on
 * the clipboard (left there for the caller); it is never written to the QA
 * trace, the status, or the `chat:sent` event.
 */
export type ChatCopyOutcome = ChatCommandOutcome & { text?: string };

export interface ChatCommandStatus {
  enabled: boolean;
  hostRunning: boolean;
  lastOutcome?: ChatCommandOutcome;
  sentThisMinute: number;
  maxPerMinute: number;
  dryRun: boolean;
}

export interface PlaceholderContext {
  player?: string;
  area?: string;
  latestWhisper?: string;
  char?: string;
  item?: string;
  price?: string;
  tab?: string;
  left?: number;
  top?: number;
  league?: string;
}

/** Settings namespace "chat-commands" (sanitized by normalizeChatCommandSettings). */
export interface ChatCommandSettings {
  enabled: boolean;
  /** Close the idle input host after this long without a chat attempt. */
  idleCloseMs: number;
  /** Hard ceiling 30: the compliance budget, never raised by settings. */
  maxPerMinute: number;
}

export interface ChatContract {
  "chat:send": FeatureCall<[request: ChatCommandRequest], ChatCommandOutcome>;
  "chat:stash-search": FeatureCall<
    [text: string, reason: string, options?: StashSearchOptions],
    ChatCommandOutcome
  >;
  "chat:copy-hovered": FeatureCall<[request: ChatCopyRequest], ChatCopyOutcome>;
  "chat:status": FeatureCall<[], ChatCommandStatus>;
  "chat:resolve": FeatureCall<[template: string, context: PlaceholderContext], string>;
}

export interface ChatEvents {
  "chat:sent": ChatCommandOutcome;
  "chat:status": ChatCommandStatus;
}
