/**
 * Pure model for the commands / stash searches / bookmarks / notes package:
 * ids, sanitizers for everything read from disk, the placeholder context the
 * chat service resolves against, the "would send" preview, and header-only
 * image readers for note images.
 *
 * Why so strict: every one of these values ends up either typed into the game
 * by the input host (a character the host cannot type would change the line's
 * meaning — a whisper whose "@" vanished becomes public chat) or rendered in
 * the overlay. Nothing here throws; every sanitizer collects `issues[]` so the
 * editor can explain what it dropped.
 *
 * No I/O, no Electron, no DOM — src/main/features/commandsBookmarksNotes/
 * wires this to the settings store, the hotkey registry and the chat service.
 */
import { CHAT_TEXT_MAX_CHARS, resolvePlaceholders, sanitizeChatText, unresolvedPlaceholders, untypableChars } from "./chatCommands.js";
import type { ClientLogEvent } from "./clientLog.js";
import type { PlaceholderContext } from "../shared/chatCommands.js";
import type {
  BookmarkItem,
  BookmarkMode,
  BookmarksSettings,
  BookmarkWindowSettings,
  CommandItem,
  CommandPreview,
  CommandsSettings,
  NoteImageMeta,
  NoteImageMime,
  NoteItem,
  NotesPanelSettings,
  NotesSettings,
  PlaceholderSnapshot,
  PlaceholderSource,
  StashSearchItem,
} from "../shared/commandsBookmarksNotes.js";
import type { OverlayAnchor } from "../shared/overlay.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_COMMANDS = 40;
export const MAX_SEARCHES = 40;
export const MAX_BOOKMARKS = 40;
export const MAX_NOTES = 40;
export const MAX_LABEL_CHARS = 60;
export const MAX_TITLE_CHARS = 80;
export const MAX_ICON_CHARS = 4;
/** = CHAT_TEXT_MAX_CHARS: the chat service refuses anything longer anyway. */
export const MAX_TEMPLATE_CHARS = CHAT_TEXT_MAX_CHARS;
/** The game's search box is happy well below this. */
export const MAX_SEARCH_CHARS = 250;
export const MAX_URL_CHARS = 2048;
export const MAX_MARKDOWN_CHARS = 20_000;
export const NOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const NOTE_IMAGE_MIMES: readonly NoteImageMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
/** Guards key auto-repeat and double taps; the chat service's 400 ms gap is the second net. */
export const RUN_DEBOUNCE_MS = 350;

export type ItemKind = "command" | "search" | "bookmark" | "note";

const ID_PREFIX: Record<ItemKind, string> = {
  command: "cmd",
  search: "srch",
  bookmark: "bm",
  note: "note",
};

const HOTKEY_GROUP_PREFIX: Record<ItemKind, string> = {
  command: "commands",
  search: "stash-searches",
  bookmark: "bookmarks",
  note: "notes",
};

export const ITEM_ID_PATTERN = /^[a-z]+_[a-z0-9]+_[a-z0-9]{4}$/i;
/**
 * Files the note-image store is allowed to delete (compliance: never touch a
 * user's own file). The store names a file `<noteId>.<ext>` and a note id is
 * whatever `sanitizeId` accepted — ITEM_ID_PATTERN, not only the `note_`
 * prefix the app itself generates — so a hand-edited settings file cannot
 * leave behind an image the sweep can never reclaim.
 */
export const NOTE_IMAGE_FILE_PATTERN = /^[a-z]+_[a-z0-9]+_[a-z0-9]{4}\.(png|jpg|webp|gif)$/i;

export const NOTES_PANEL_ACTION_ID = "notes.panel";
export const STASH_SEARCH_PANEL_ACTION_ID = "stash-search.panel";

export const HOTKEY_GROUPS = {
  overlay: "Overlay",
  command: "Commands",
  search: "Stash searches",
  bookmark: "Bookmarks",
  note: "Notes",
} as const;

function base36(value: number): string {
  return Math.max(0, Math.floor(value)).toString(36);
}

/** `cmd_<base36 ms>_<4 base36>` — stable, sortable, and matching ITEM_ID_PATTERN. */
export function newItemId(kind: ItemKind, now: number = Date.now(), rand: () => number = Math.random): string {
  const suffix = base36(Math.floor(rand() * 36 ** 4))
    .padStart(4, "0")
    .slice(-4);
  return `${ID_PREFIX[kind]}_${base36(now)}_${suffix}`;
}

/** The hotkey action id of one item: "commands.<id>", "stash-searches.<id>", … */
export function hotkeyActionId(kind: ItemKind, id: string): string {
  return `${HOTKEY_GROUP_PREFIX[kind]}.${id}`;
}

export interface Sanitized<T> {
  value: T;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** Strips control characters and collapses a value onto one line. */
function oneLine(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sanitizeId(raw: unknown, kind: ItemKind, fallbackId: string | undefined, issues: string[], what: string): string {
  if (typeof raw === "string" && ITEM_ID_PATTERN.test(raw)) return raw;
  const generated = fallbackId ?? newItemId(kind);
  issues.push(`${what}: missing or invalid id, generated "${generated}"`);
  return generated;
}

function sanitizeLabel(raw: unknown, max: number, fallback: string, issues: string[], what: string): string {
  const text = oneLine(raw);
  if (!text) {
    issues.push(`${what}: empty name, using "${fallback}"`);
    return fallback;
  }
  if (text.length > max) {
    issues.push(`${what}: name shortened to ${max} characters`);
    return text.slice(0, max);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function sanitizeCommand(raw: unknown, index: number, fallbackId?: string): Sanitized<CommandItem> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = asRecord(raw);
  const issues: string[] = [];
  const what = `command #${index + 1}`;
  const id = sanitizeId(source.id, "command", fallbackId, issues, what);
  const label = sanitizeLabel(source.label, MAX_LABEL_CHARS, `Command ${index + 1}`, issues, what);
  let template = oneLine(source.template);
  if (typeof source.template === "string" && source.template !== template && source.template.trim() !== template) {
    issues.push(`command "${label}": the line was collapsed onto one line`);
  }
  if (template.length > MAX_TEMPLATE_CHARS) {
    template = template.slice(0, MAX_TEMPLATE_CHARS);
    issues.push(`command "${label}": the line was cut to ${MAX_TEMPLATE_CHARS} characters`);
  }
  // Kept, not dropped: the editor shows the warning and the chat service
  // refuses the line with the same wording if it is ever run.
  const untypable = untypableChars(template);
  if (untypable.length > 0) {
    issues.push(
      `command "${label}": the input host cannot type ${untypable.map((ch) => JSON.stringify(ch)).join(" ")}`,
    );
  }
  return { value: { id, label, template, enabled: source.enabled !== false }, issues };
}

export interface StashSearchTextCheck {
  ok: boolean;
  text: string;
  reason?: string;
  untypable: string[];
}

/** The stash search box takes one line of typable characters — regex included. */
export function checkStashSearchText(raw: unknown): StashSearchTextCheck {
  const text = oneLine(raw);
  const untypable = untypableChars(text);
  if (!text) return { ok: false, text, reason: "the search text is empty", untypable };
  if (text.length > MAX_SEARCH_CHARS) {
    return {
      ok: false,
      text,
      reason: `the search text is ${text.length} characters (limit ${MAX_SEARCH_CHARS})`,
      untypable,
    };
  }
  if (untypable.length > 0) {
    return {
      ok: false,
      text,
      reason: `the input host cannot type: ${untypable.map((ch) => JSON.stringify(ch)).join(" ")}`,
      untypable,
    };
  }
  return { ok: true, text, untypable };
}

export function sanitizeStashSearch(raw: unknown, index: number, fallbackId?: string): Sanitized<StashSearchItem> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = asRecord(raw);
  const issues: string[] = [];
  const what = `stash search #${index + 1}`;
  const id = sanitizeId(source.id, "search", fallbackId, issues, what);
  const label = sanitizeLabel(source.label, MAX_LABEL_CHARS, `Search ${index + 1}`, issues, what);
  const check = checkStashSearchText(source.text);
  let enabled = source.enabled !== false;
  if (!check.ok) {
    issues.push(`stash search "${label}": ${check.reason} — the hotkey stays unbound`);
    enabled = false;
  }
  return { value: { id, label, text: check.text.slice(0, MAX_SEARCH_CHARS), enabled }, issues };
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export interface BookmarkUrlCheck {
  ok: boolean;
  url?: string;
  reason?: string;
}

/**
 * http(s) only, no credentials in the authority, no control characters. A
 * bookmark URL is loaded by a real browser window, so `javascript:`,
 * `file:` and `data:` must never survive.
 */
export function checkBookmarkUrl(raw: unknown): BookmarkUrlCheck {
  if (typeof raw !== "string") return { ok: false, reason: "the address is missing" };
  const text = raw.trim();
  if (!text) return { ok: false, reason: "the address is empty" };
  if (text.length > MAX_URL_CHARS) return { ok: false, reason: `the address is longer than ${MAX_URL_CHARS} characters` };
  if (/\s/.test(text)) return { ok: false, reason: "the address contains whitespace" };
  if (/[\x00-\x1f\x7f]/.test(text)) return { ok: false, reason: "the address contains control characters" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: "the address is not a URL (start it with https://)" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `only http and https addresses are allowed (got "${parsed.protocol}")` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "the address must not carry a user name or password" };
  }
  if (!parsed.hostname) return { ok: false, reason: "the address has no host" };
  return { ok: true, url: parsed.href };
}

export function sanitizeBookmark(raw: unknown, index: number, fallbackId?: string): Sanitized<BookmarkItem> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = asRecord(raw);
  const issues: string[] = [];
  const what = `bookmark #${index + 1}`;
  const id = sanitizeId(source.id, "bookmark", fallbackId, issues, what);
  const label = sanitizeLabel(source.label, MAX_LABEL_CHARS, `Bookmark ${index + 1}`, issues, what);
  const check = checkBookmarkUrl(source.url);
  if (!check.ok || !check.url) {
    // A bookmark without a usable address cannot do anything: drop it.
    return undefined;
  }
  const mode: BookmarkMode = source.mode === "window" ? "window" : "external";
  return { value: { id, label, url: check.url, mode, enabled: source.enabled !== false }, issues };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function sanitizeNoteImage(raw: unknown): NoteImageMeta | undefined {
  const source = asRecord(raw);
  const mime = source.mime;
  if (typeof mime !== "string" || !(NOTE_IMAGE_MIMES as readonly string[]).includes(mime)) return undefined;
  const bytes = Number(source.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > NOTE_IMAGE_MAX_BYTES) return undefined;
  const meta: NoteImageMeta = { mime: mime as NoteImageMime, bytes: Math.round(bytes) };
  const width = Number(source.width);
  const height = Number(source.height);
  if (Number.isFinite(width) && width > 0) meta.width = Math.round(width);
  if (Number.isFinite(height) && height > 0) meta.height = Math.round(height);
  return meta;
}

export function sanitizeNote(raw: unknown, index: number, fallbackId?: string): Sanitized<NoteItem> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = asRecord(raw);
  const issues: string[] = [];
  const what = `note #${index + 1}`;
  const id = sanitizeId(source.id, "note", fallbackId, issues, what);
  const title = sanitizeLabel(source.title, MAX_TITLE_CHARS, `Note ${index + 1}`, issues, what);
  const iconRaw = oneLine(source.icon);
  const icon = iconRaw ? [...iconRaw].slice(0, MAX_ICON_CHARS).join("") : "📝";
  let markdown = typeof source.markdown === "string" ? source.markdown.replace(/\r\n/g, "\n") : "";
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
    issues.push(`note "${title}": the text was cut to ${MAX_MARKDOWN_CHARS} characters`);
  }
  const note: NoteItem = { id, title, icon, markdown, enabled: source.enabled !== false };
  if (source.image !== undefined) {
    const image = sanitizeNoteImage(source.image);
    if (image) note.image = image;
    else issues.push(`note "${title}": the stored image record was unreadable and was dropped`);
  }
  return { value: note, issues };
}

// ---------------------------------------------------------------------------
// Settings namespaces
// ---------------------------------------------------------------------------

export const DEFAULT_COMMANDS_SETTINGS: CommandsSettings = {
  commands: [],
  searches: [],
  feedbackNotices: true,
};

export const DEFAULT_BOOKMARK_WINDOW: BookmarkWindowSettings = {
  width: 960,
  height: 720,
  alwaysOnTop: true,
};

export const DEFAULT_BOOKMARKS_SETTINGS: BookmarksSettings = {
  bookmarks: [],
  window: { ...DEFAULT_BOOKMARK_WINDOW },
};

/** Anchor "left": the game's left edge is the emptiest place for a cheat sheet. */
export const DEFAULT_NOTES_PANEL: NotesPanelSettings = { anchor: "left", width: 440, height: 380 };

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  notes: [],
  panel: { ...DEFAULT_NOTES_PANEL },
};

const ANCHOR_NAMES: readonly string[] = [
  "cursor",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "left",
  "right",
  "center",
];

function sanitizeAnchor(raw: unknown, issues: string[]): OverlayAnchor {
  if (typeof raw === "string" && ANCHOR_NAMES.includes(raw)) return raw as OverlayAnchor;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const point = asRecord(raw);
    const x = Number(point.x);
    const y = Number(point.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  }
  if (raw !== undefined) issues.push(`notes panel: unknown anchor, using "${DEFAULT_NOTES_PANEL.anchor as string}"`);
  return DEFAULT_NOTES_PANEL.anchor;
}

/**
 * Generic list sanitizer: caps the length, re-generates duplicate ids, and
 * reports every drop. `sanitize` returning undefined drops the entry.
 */
function sanitizeList<T extends { id: string }>(
  raw: unknown,
  max: number,
  what: string,
  sanitize: (entry: unknown, index: number, fallbackId?: string) => Sanitized<T> | undefined,
  issues: string[],
  kind: ItemKind,
): T[] {
  const entries = asArray(raw);
  if (entries.length > max) {
    issues.push(`${what}: ${entries.length} entries, kept the first ${max}`);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.slice(0, max).entries()) {
    const sanitized = sanitize(entry, index);
    if (!sanitized) {
      issues.push(`${what} #${index + 1}: unusable entry, dropped`);
      continue;
    }
    issues.push(...sanitized.issues);
    let value = sanitized.value;
    if (seen.has(value.id)) {
      const replacement = newItemId(kind);
      issues.push(`${what} #${index + 1}: duplicate id, re-generated as "${replacement}"`);
      value = { ...value, id: replacement };
    }
    seen.add(value.id);
    out.push(value);
  }
  return out;
}

export function normalizeCommandsSettings(raw: unknown): Sanitized<CommandsSettings> {
  const source = asRecord(raw);
  const issues: string[] = [];
  return {
    value: {
      commands: sanitizeList(source.commands, MAX_COMMANDS, "commands", sanitizeCommand, issues, "command"),
      searches: sanitizeList(source.searches, MAX_SEARCHES, "stash searches", sanitizeStashSearch, issues, "search"),
      feedbackNotices: source.feedbackNotices !== false,
    },
    issues,
  };
}

export function normalizeBookmarksSettings(raw: unknown): Sanitized<BookmarksSettings> {
  const source = asRecord(raw);
  const issues: string[] = [];
  const windowRaw = asRecord(source.window);
  const window: BookmarkWindowSettings = {
    width: clampInt(windowRaw.width, 480, 3840, DEFAULT_BOOKMARK_WINDOW.width),
    height: clampInt(windowRaw.height, 320, 2160, DEFAULT_BOOKMARK_WINDOW.height),
    alwaysOnTop: windowRaw.alwaysOnTop !== false,
  };
  const x = Number(windowRaw.x);
  const y = Number(windowRaw.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    window.x = Math.round(x);
    window.y = Math.round(y);
  }
  return {
    value: {
      bookmarks: sanitizeList(source.bookmarks, MAX_BOOKMARKS, "bookmarks", sanitizeBookmark, issues, "bookmark"),
      window,
    },
    issues,
  };
}

export function normalizeNotesSettings(raw: unknown): Sanitized<NotesSettings> {
  const source = asRecord(raw);
  const issues: string[] = [];
  const panelRaw = asRecord(source.panel);
  const panel: NotesPanelSettings = {
    anchor: sanitizeAnchor(panelRaw.anchor, issues),
    width: clampInt(panelRaw.width, 280, 1200, DEFAULT_NOTES_PANEL.width),
    height: clampInt(panelRaw.height, 200, 1000, DEFAULT_NOTES_PANEL.height),
  };
  const notes = sanitizeList(source.notes, MAX_NOTES, "notes", sanitizeNote, issues, "note");
  const value: NotesSettings = { notes, panel };
  const lastNoteId = typeof source.lastNoteId === "string" ? source.lastNoteId : undefined;
  if (lastNoteId && notes.some((note) => note.id === lastNoteId)) value.lastNoteId = lastNoteId;
  return { value, issues };
}

// ---------------------------------------------------------------------------
// Starter examples (shown until the user saves; never written on their own)
// ---------------------------------------------------------------------------

/** Single chat lines only — nothing that joins a channel or opens a UI. */
export function starterCommands(): CommandItem[] {
  return [
    { id: "cmd_starter_hide", label: "Hideout", template: "/hideout", enabled: true },
    { id: "cmd_starter_invt", label: "Invite buyer", template: "/invite {player}", enabled: true },
    { id: "cmd_starter_trad", label: "Trade with buyer", template: "/tradewith {player}", enabled: true },
    { id: "cmd_starter_kick", label: "Kick from party", template: "/kick {player}", enabled: true },
    { id: "cmd_starter_tyvm", label: "Thanks", template: "@{player} thanks, enjoy!", enabled: true },
  ];
}

export function starterStashSearches(): StashSearchItem[] {
  return [
    { id: "srch_starter_t15x", label: "Tier 15-16 (example)", text: '"tier: 1[5-6]"', enabled: true },
    { id: "srch_starter_ways", label: "Waystones (example)", text: '"^Waystone"', enabled: true },
    { id: "srch_starter_uniq", label: "Uniques (example)", text: "rarity: unique", enabled: true },
  ];
}

export const STARTER_ISSUE = "showing example commands — save to keep them";

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

type WhisperEvent = Extract<ClientLogEvent, { kind: "whisper" }>;

export interface PlaceholderInput {
  status?: { character?: { name: string }; area?: { info: { name: string } } };
  /** Newest LAST (ClientLogService.recent order). */
  whispers?: readonly WhisperEvent[];
  /** The price feed's already-resolved league (no network). */
  league?: string;
}

/**
 * Builds the chat service's PlaceholderContext from what the client-log
 * service saw. Keys without a value are omitted on purpose: the chat service
 * leaves `{x}` verbatim and refuses the line, which is far better than
 * whispering "@ hi" to nobody.
 */
export function placeholderContextFrom(input: PlaceholderInput): PlaceholderSnapshot {
  const context: PlaceholderContext = {};
  const sources: Partial<Record<keyof PlaceholderContext, PlaceholderSource>> = {};
  const snapshot: PlaceholderSnapshot = { context, sources };

  const character = input.status?.character?.name;
  if (character) {
    context.char = character;
    sources.char = "character";
  }
  const area = input.status?.area?.info.name;
  if (area) {
    context.area = area;
    sources.area = "area";
  }

  const whispers = input.whispers ?? [];
  for (let index = whispers.length - 1; index >= 0; index -= 1) {
    const event = whispers[index];
    if (!event || event.kind !== "whisper" || event.direction !== "in") continue;
    context.player = event.player;
    context.latestWhisper = event.text;
    sources.player = "whisper";
    sources.latestWhisper = "whisper";
    snapshot.whisperAt = event.at;
    break;
  }

  for (let index = whispers.length - 1; index >= 0; index -= 1) {
    const event = whispers[index];
    if (!event || event.kind !== "whisper" || event.direction !== "in" || !event.trade) continue;
    const trade = event.trade;
    const name = trade.itemName ?? trade.baseType;
    if (name) {
      const withBase = trade.itemName && trade.baseType && trade.itemName !== trade.baseType
        ? `${trade.itemName}, ${trade.baseType}`
        : name;
      context.item = trade.quantity !== undefined ? `${trade.quantity} ${name}` : withBase;
      sources.item = "trade-whisper";
    }
    context.price = `${trade.price.amount} ${trade.price.currency}`;
    sources.price = "trade-whisper";
    if (trade.stashTab) {
      context.tab = trade.stashTab;
      sources.tab = "trade-whisper";
    }
    if (trade.position) {
      context.left = trade.position.left;
      context.top = trade.position.top;
      sources.left = "trade-whisper";
      sources.top = "trade-whisper";
    }
    if (trade.league) {
      context.league = trade.league;
      sources.league = "trade-whisper";
    }
    snapshot.tradeWhisperAt = event.at;
    break;
  }

  if (context.league === undefined && input.league) {
    context.league = input.league;
    sources.league = "price-feed";
  }
  return snapshot;
}

/** What the user would send: the resolved line plus every reason it could be refused. */
export function commandPreview(template: string, snapshot: PlaceholderSnapshot): CommandPreview {
  const resolved = resolvePlaceholders(String(template ?? ""), snapshot.context);
  const check = sanitizeChatText(resolved);
  return {
    resolved,
    unresolved: unresolvedPlaceholders(resolved),
    untypable: untypableChars(resolved.replace(/[\r\n]/g, "")),
    issues: check.error ? [check.error] : [],
    ok: check.issues.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Note images (header readers only — nothing is decoded)
// ---------------------------------------------------------------------------

export interface ImageDataUri {
  mime: NoteImageMime;
  bytes: Uint8Array;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/** Pure base64 decode (no Buffer, no atob): src/core must stay renderer-safe. */
export function decodeBase64(text: string): Uint8Array | undefined {
  const clean = text.replace(/\s+/g, "");
  const body = clean.replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(body)) return undefined;
  if (body.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    const value = code < 128 ? BASE64_LOOKUP[code]! : -1;
    if (value < 0) return undefined;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_ALPHABET[(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6))];
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function toDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${encodeBase64(bytes)}`;
}

export type ImageDataUriResult = { ok: true; image: ImageDataUri } | { ok: false; reason: string };

/** `data:image/png;base64,…` with an allowlisted MIME and a hard size cap. */
export function parseImageDataUri(raw: unknown): ImageDataUriResult {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "no image data" };
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(raw.trim());
  if (!match) return { ok: false, reason: "the image must be a base64 data URI" };
  const mime = match[1]!.toLowerCase();
  if (!(NOTE_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return { ok: false, reason: `${mime} images are not supported (PNG, JPEG, WebP or GIF only)` };
  }
  const bytes = decodeBase64(match[2]!);
  if (!bytes || bytes.length === 0) return { ok: false, reason: "the image data could not be decoded" };
  if (bytes.length > NOTE_IMAGE_MAX_BYTES) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `the image is ${mb} MB (limit 2 MB)` };
  }
  return { ok: true, image: { mime: mime as NoteImageMime, bytes } };
}

function readU32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.length) return undefined;
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readU16LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.length) return undefined;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU16BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.length) return undefined;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]!);
  }
  return out;
}

/**
 * Width/height from the file header only — nothing is decoded, so a hostile
 * image cannot do more than produce `undefined`.
 */
export function imageDimensions(bytes: Uint8Array, mime: NoteImageMime): { width: number; height: number } | undefined {
  if (mime === "image/png") {
    if (bytes.length < 24 || ascii(bytes, 1, 3) !== "PNG") return undefined;
    const width = readU32BE(bytes, 16);
    const height = readU32BE(bytes, 20);
    return width && height ? { width, height } : undefined;
  }
  if (mime === "image/gif") {
    if (bytes.length < 10 || ascii(bytes, 0, 3) !== "GIF") return undefined;
    const width = readU16LE(bytes, 6);
    const height = readU16LE(bytes, 8);
    return width && height ? { width, height } : undefined;
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = readU16BE(bytes, offset + 2) ?? 0;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = readU16BE(bytes, offset + 5);
        const width = readU16BE(bytes, offset + 7);
        return width && height ? { width, height } : undefined;
      }
      if (length <= 0) return undefined;
      offset += 2 + length;
    }
    return undefined;
  }
  // WebP: RIFF container, then VP8 / VP8L / VP8X.
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  if (chunk === "VP8 ") {
    const width = (readU16LE(bytes, 26) ?? 0) & 0x3fff;
    const height = (readU16LE(bytes, 28) ?? 0) & 0x3fff;
    return width && height ? { width, height } : undefined;
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25) return undefined;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return undefined;
}

/** Extension the note-image store uses for one MIME. */
export function imageExtension(mime: NoteImageMime): "png" | "jpg" | "webp" | "gif" {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "gif";
  }
}
