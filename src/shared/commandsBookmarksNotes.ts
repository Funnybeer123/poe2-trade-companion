/**
 * Contract for the feature package "commandsBookmarksNotes" (channels
 * `commands:*`, `bookmarks:*`, `notes:*`).
 *
 * Four small user-kept lists — chat commands, stash searches, bookmarks and
 * cheat-sheet notes — each item bindable to a global hotkey, each hotkey
 * doing exactly ONE thing per press: one chat line through the chat command
 * service, one stash-search fill, one bookmark open, or one overlay panel.
 *
 * Pure types: no Electron, no DOM, no Node — the renderer, the main process
 * and the tests share this file.
 */
import type { FeatureCall } from "./features.js";
import type { ChatBlockReason, PlaceholderContext } from "./chatCommands.js";
import type { OverlayAnchor } from "./overlay.js";

// ---------------------------------------------------------------------------
// Persisted item shapes (sanitized by src/core/commandsBookmarksNotes.ts)
// ---------------------------------------------------------------------------

export interface CommandItem {
  id: string;
  label: string;
  /** A chat line, possibly with `{player}`-style placeholders. */
  template: string;
  enabled: boolean;
}

export interface StashSearchItem {
  id: string;
  label: string;
  /** Typed into the game's stash search box exactly as written. */
  text: string;
  enabled: boolean;
}

export type BookmarkMode = "external" | "window";

export interface BookmarkItem {
  id: string;
  label: string;
  url: string;
  mode: BookmarkMode;
  enabled: boolean;
}

export type NoteImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface NoteImageMeta {
  mime: NoteImageMime;
  bytes: number;
  width?: number;
  height?: number;
}

export interface NoteItem {
  id: string;
  title: string;
  /** One short glyph shown in the panel rail (an emoji). */
  icon: string;
  markdown: string;
  image?: NoteImageMeta;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Settings namespaces
// ---------------------------------------------------------------------------

export interface CommandsSettings {
  commands: CommandItem[];
  searches: StashSearchItem[];
  /** Show a 2.5 s overlay toast after every hotkey-driven run (default true). */
  feedbackNotices: boolean;
}

export interface BookmarkWindowSettings {
  width: number;
  height: number;
  x?: number;
  y?: number;
  alwaysOnTop: boolean;
}

export interface BookmarksSettings {
  bookmarks: BookmarkItem[];
  window: BookmarkWindowSettings;
}

export interface NotesPanelSettings {
  anchor: OverlayAnchor;
  width: number;
  height: number;
}

export interface NotesSettings {
  notes: NoteItem[];
  panel: NotesPanelSettings;
  lastNoteId?: string;
}

// ---------------------------------------------------------------------------
// Views (what the renderer receives)
// ---------------------------------------------------------------------------

export interface HotkeyRef {
  actionId: string;
  accelerator: string | null;
  registered: boolean;
  error?: string;
}

export interface RunOutcome {
  ok: boolean;
  dryRun: boolean;
  at: string;
  /** The line after placeholder resolution — what would be typed. */
  resolved: string;
  sent?: string;
  blockedBy?: ChatBlockReason | "unknown-item" | "disabled" | "debounced";
  error?: string;
}

export interface CommandView extends CommandItem {
  hotkey: HotkeyRef;
  lastRun?: RunOutcome;
}

export interface StashSearchView extends StashSearchItem {
  hotkey: HotkeyRef;
  lastRun?: RunOutcome;
}

export interface BookmarkView extends BookmarkItem {
  hotkey: HotkeyRef;
  lastOpenedAt?: string;
}

/** markdown + image META only; the image bytes come from `notes:get`. */
export interface NoteView extends NoteItem {
  hotkey: HotkeyRef;
}

export type PlaceholderSource = "whisper" | "trade-whisper" | "area" | "character" | "price-feed";

export interface PlaceholderSnapshot {
  context: PlaceholderContext;
  sources: Partial<Record<keyof PlaceholderContext, PlaceholderSource>>;
  whisperAt?: string;
  tradeWhisperAt?: string;
}

export interface CommandsView {
  commands: CommandView[];
  searches: StashSearchView[];
  feedbackNotices: boolean;
  placeholders: PlaceholderSnapshot;
  /** Chat commands enabled in settings (the F3 kill switch is separate). */
  chatEnabled: boolean;
  dryRun: boolean;
  issues: string[];
}

export interface BookmarksView {
  bookmarks: BookmarkView[];
  window: BookmarkWindowSettings;
  /** A bookmark window exists (it may be hidden behind its own toggle hotkey). */
  windowOpen: boolean;
  /** …and it is on screen right now. */
  windowVisible: boolean;
  issues: string[];
}

export interface NotesView {
  notes: NoteView[];
  panel: NotesPanelSettings;
  lastNoteId?: string;
  panelVisible: boolean;
  issues: string[];
}

export interface NoteDetail {
  note: NoteView;
  imageDataUri?: string;
}

export interface BookmarkOpenOutcome {
  ok: boolean;
  mode: BookmarkMode;
  url: string;
  error?: string;
  at: string;
}

export interface CommandPreview {
  resolved: string;
  unresolved: string[];
  untypable: string[];
  issues: string[];
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Save payloads (raw; main sanitizes and answers with what it kept + issues)
// ---------------------------------------------------------------------------

export interface CommandsSavePayload {
  commands?: unknown;
  searches?: unknown;
  feedbackNotices?: unknown;
}

export interface BookmarksSavePayload {
  bookmarks?: unknown;
  window?: unknown;
}

export interface NotesSavePayload {
  notes?: unknown;
  panel?: unknown;
}

export interface RunOptions {
  /** Bring Path of Exile to the front first — for gestures started in the app. */
  focus?: boolean;
}

export interface SearchTextOptions extends RunOptions {
  /** The gesture came from the focused Alt+F overlay panel (hand focus back first). */
  fromPanel?: boolean;
}

export interface CommandsContract {
  "commands:list": FeatureCall<[], CommandsView>;
  "commands:save": FeatureCall<[payload: CommandsSavePayload], CommandsView>;
  "commands:preview": FeatureCall<[template: string], CommandPreview>;
  "commands:run": FeatureCall<[id: string, options?: RunOptions], RunOutcome>;
  "commands:run-search": FeatureCall<[id: string, options?: SearchTextOptions], RunOutcome>;
  "commands:search-text": FeatureCall<[text: string, options?: SearchTextOptions], RunOutcome>;
  "commands:placeholders": FeatureCall<[], PlaceholderSnapshot>;
  "commands:show-search-panel": FeatureCall<[prefill?: string], void>;
}

export interface CommandsEvents {
  "commands:changed": CommandsView;
  "commands:ran": { kind: "command" | "search"; id?: string; outcome: RunOutcome };
}

export interface BookmarksContract {
  "bookmarks:list": FeatureCall<[], BookmarksView>;
  "bookmarks:save": FeatureCall<[payload: BookmarksSavePayload], BookmarksView>;
  "bookmarks:open": FeatureCall<[id: string], BookmarkOpenOutcome>;
  /** Links inside a note (and the tests) open through here: main validates again. */
  "bookmarks:open-url": FeatureCall<[url: string, mode?: BookmarkMode], BookmarkOpenOutcome>;
  "bookmarks:close-window": FeatureCall<[], boolean>;
}

export interface BookmarksEvents {
  "bookmarks:changed": BookmarksView;
}

export interface NotesContract {
  "notes:list": FeatureCall<[], NotesView>;
  "notes:get": FeatureCall<[id: string], NoteDetail | undefined>;
  "notes:save": FeatureCall<[payload: NotesSavePayload], NotesView>;
  "notes:set-image": FeatureCall<[id: string, dataUri: string | null], NoteView | undefined>;
  /** Desktop UI → overlay panel. */
  "notes:show": FeatureCall<[id?: string], void>;
  "notes:hide": FeatureCall<[], void>;
}

export interface NotesEvents {
  "notes:changed": NotesView;
}

export const NOTES_PANEL_ID = "notes";
export const STASH_SEARCH_PANEL_ID = "stash-search";

export interface NotesPanelPayload {
  noteId?: string;
}

export interface StashSearchPanelPayload {
  prefill?: string;
}
