/**
 * Pure rules for chat commands: placeholder templates, the text rules a chat
 * line must satisfy before the input host may type it, the rate limiter, and
 * the settings sanitizer. No I/O — src/main/chatCommandService.ts wires them
 * to the host, the trace, and the feature context.
 *
 * Why the text rules are strict: the host's `type` op
 * (scripts/win-input-host.ps1) drops every character it has no key table for.
 * A dropped character would not just mangle the line — a whisper whose "@"
 * vanished becomes a public chat line — so anything the host cannot type is
 * refused here instead of being typed approximately.
 */
import type { ChatCommandSettings, PlaceholderContext } from "../shared/chatCommands.js";

export const CHAT_TEXT_MAX_CHARS = 300;
/** Compliance ceiling: settings may lower it, never raise it. */
export const CHAT_MAX_PER_MINUTE = 30;
export const CHAT_MIN_GAP_MS = 400;
export const CHAT_DEFAULT_IDLE_CLOSE_MS = 60_000;

export const CHAT_PLACEHOLDERS = [
  "player",
  "area",
  "latestWhisper",
  "char",
  "item",
  "price",
  "tab",
  "left",
  "top",
  "league",
] as const satisfies readonly (keyof PlaceholderContext)[];

export type ChatPlaceholder = (typeof CHAT_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function isKnownPlaceholder(name: string): name is ChatPlaceholder {
  return (CHAT_PLACEHOLDERS as readonly string[]).includes(name);
}

/** A placeholder value must never smuggle a second line into the chat box. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * Replace every known `{placeholder}` that has a value in `context`.
 * Unknown names and known names without a value are left verbatim so
 * `unresolvedPlaceholders` can refuse the line afterwards — a silent blank
 * would send "@ hi" to nobody.
 */
export function resolvePlaceholders(template: string, context: PlaceholderContext): string {
  return String(template ?? "").replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (!isKnownPlaceholder(name)) return match;
    const value = context[name];
    if (value === undefined || value === null) return match;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : match;
    const text = oneLine(String(value));
    return text.length > 0 ? text : match;
  });
}

/** Names of every `{placeholder}` still present in `text` (known or not), in order, deduplicated. */
export function unresolvedPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of String(text ?? "").matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Characters the host's `type` op can emit (US layout): mirrors the letter,
 * digit, space, `$OemKeys` and `$ShiftKeys` tables in
 * scripts/win-input-host.ps1. Keep in sync when that script grows a key.
 */
export const HOST_TYPABLE_CHARS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).filter((ch) =>
    /[A-Za-z0-9 ]/.test(ch),
  ),
  ..."-=[];',./\\`",
  ..."\":()|?~_+!#$%&*<>{}@^",
]);

/** Characters of `text` the host cannot type, deduplicated, in order. */
export function untypableChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (!HOST_TYPABLE_CHARS.has(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

export type ChatTextIssue =
  | "empty"
  | "too-long"
  | "multi-line"
  | "control-chars"
  | "unresolved-placeholder"
  | "untypable-chars";

export interface ChatTextCheck {
  /** Trimmed text (the line that would be typed when `blockedBy` is unset). */
  text: string;
  issues: ChatTextIssue[];
  /** The ChatBlockReason bucket: "too-long" for length, "empty" for every other refusal. */
  blockedBy?: "empty" | "too-long";
  /** Human explanation of the first issue, for the outcome's `error`. */
  error?: string;
}

/**
 * The text rules: one line, ≤ 300 characters, no control characters, no
 * unresolved `{placeholder}`, only characters the host can type, trimmed.
 * Nothing is repaired silently except surrounding whitespace.
 */
export function sanitizeChatText(raw: unknown): ChatTextCheck {
  const text = typeof raw === "string" ? raw.trim() : "";
  const issues: ChatTextIssue[] = [];
  const explanations: string[] = [];
  if (text.length === 0) {
    issues.push("empty");
    explanations.push("the chat line is empty");
  }
  if (/[\r\n]/.test(text)) {
    issues.push("multi-line");
    explanations.push("the chat line spans more than one line");
  }
  if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    issues.push("control-chars");
    explanations.push("the chat line contains control characters");
  }
  if (text.length > CHAT_TEXT_MAX_CHARS) {
    issues.push("too-long");
    explanations.push(`the chat line is ${text.length} characters (limit ${CHAT_TEXT_MAX_CHARS})`);
  }
  const unresolved = unresolvedPlaceholders(text);
  if (unresolved.length > 0) {
    issues.push("unresolved-placeholder");
    explanations.push(`unresolved placeholder(s): ${unresolved.map((name) => `{${name}}`).join(", ")}`);
  }
  const untypable = untypableChars(text.replace(/[\r\n]/g, ""));
  if (untypable.length > 0) {
    issues.push("untypable-chars");
    explanations.push(
      `the input host cannot type: ${untypable.map((ch) => JSON.stringify(ch)).join(" ")}`,
    );
  }
  if (issues.length === 0) return { text, issues };
  const blockedBy = issues.includes("too-long") && issues.length === 1 ? "too-long" : "empty";
  return { text, issues, blockedBy, error: explanations[0] };
}

export interface ChatRateLimiterOptions {
  maxPerMinute?: number;
  minGapMs?: number;
  /** Injectable clock (ms). */
  now?: () => number;
}

export type ChatRateCheck =
  | { ok: true }
  | { ok: false; reason: "per-minute" | "min-gap"; retryAfterMs: number };

/**
 * Sliding-window limiter: at most `maxPerMinute` lines in any 60 s and at
 * least `minGapMs` between two lines. `check` never mutates; `record` is
 * called only when input was really generated (dry-runs cost nothing).
 */
export class ChatRateLimiter {
  private readonly stamps: number[] = [];
  private readonly minGapMs: number;
  private readonly defaultMax: number;
  private readonly now: () => number;

  constructor(options: ChatRateLimiterOptions = {}) {
    this.minGapMs = Math.max(0, options.minGapMs ?? CHAT_MIN_GAP_MS);
    this.defaultMax = clampMaxPerMinute(options.maxPerMinute);
    this.now = options.now ?? (() => Date.now());
  }

  private prune(now: number): void {
    while (this.stamps.length > 0 && now - (this.stamps[0] as number) >= 60_000) this.stamps.shift();
  }

  check(overrides: { maxPerMinute?: number } = {}): ChatRateCheck {
    const now = this.now();
    this.prune(now);
    const max = overrides.maxPerMinute === undefined ? this.defaultMax : clampMaxPerMinute(overrides.maxPerMinute);
    const last = this.stamps.at(-1);
    if (last !== undefined && now - last < this.minGapMs) {
      return { ok: false, reason: "min-gap", retryAfterMs: this.minGapMs - (now - last) };
    }
    if (this.stamps.length >= max) {
      const oldest = this.stamps[this.stamps.length - max] as number;
      return { ok: false, reason: "per-minute", retryAfterMs: Math.max(1, 60_000 - (now - oldest)) };
    }
    return { ok: true };
  }

  record(): void {
    const now = this.now();
    this.prune(now);
    this.stamps.push(now);
  }

  sentThisMinute(): number {
    this.prune(this.now());
    return this.stamps.length;
  }

  reset(): void {
    this.stamps.length = 0;
  }
}

/** Only real numbers count: `Number(null)` is 0 and would clamp instead of being refused. */
function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function clampMaxPerMinute(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return CHAT_MAX_PER_MINUTE;
  return Math.min(CHAT_MAX_PER_MINUTE, Math.max(1, Math.floor(value)));
}

export const DEFAULT_CHAT_COMMAND_SETTINGS: ChatCommandSettings = {
  enabled: true,
  idleCloseMs: CHAT_DEFAULT_IDLE_CLOSE_MS,
  maxPerMinute: CHAT_MAX_PER_MINUTE,
};

/** Settings namespace "chat-commands": anything odd falls back to the default and is reported. */
export function normalizeChatCommandSettings(raw: unknown): {
  value: ChatCommandSettings;
  issues: string[];
} {
  const issues: string[] = [];
  const source = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  if (raw !== undefined && source !== raw) issues.push("settings must be an object; defaults used");

  let enabled = DEFAULT_CHAT_COMMAND_SETTINGS.enabled;
  if (source.enabled !== undefined) {
    if (typeof source.enabled === "boolean") enabled = source.enabled;
    else issues.push("enabled must be a boolean");
  }

  let idleCloseMs = DEFAULT_CHAT_COMMAND_SETTINGS.idleCloseMs;
  if (source.idleCloseMs !== undefined) {
    const value = finiteNumber(source.idleCloseMs);
    if (value === undefined) issues.push("idleCloseMs must be a number");
    else {
      idleCloseMs = Math.min(600_000, Math.max(5_000, Math.floor(value)));
      if (idleCloseMs !== Math.floor(value)) issues.push("idleCloseMs clamped to 5000–600000");
    }
  }

  let maxPerMinute = DEFAULT_CHAT_COMMAND_SETTINGS.maxPerMinute;
  if (source.maxPerMinute !== undefined) {
    const value = finiteNumber(source.maxPerMinute);
    if (value === undefined) issues.push("maxPerMinute must be a number");
    else {
      maxPerMinute = clampMaxPerMinute(value);
      if (maxPerMinute !== Math.floor(value)) issues.push(`maxPerMinute clamped to 1–${CHAT_MAX_PER_MINUTE}`);
    }
  }

  return { value: { enabled, idleCloseMs, maxPerMinute }, issues };
}

/**
 * The host `hotkey` name that opens the stash search box. Default Ctrl+F;
 * when the game settings file names a letter virtual-key for search, that
 * letter is used with Ctrl instead. Only letters are mapped — the host has
 * no key table for anything else, and it answers `unsupported-hotkey` for
 * names it lacks, which the service surfaces as `host-error`.
 */
export function stashSearchHotkey(searchKey?: number): string {
  if (typeof searchKey === "number" && searchKey >= 0x41 && searchKey <= 0x5a) {
    return `ctrl${String.fromCharCode(searchKey).toLowerCase()}`;
  }
  return "ctrlf";
}
