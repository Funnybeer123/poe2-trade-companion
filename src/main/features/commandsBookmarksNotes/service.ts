/**
 * The package's main-process brain: it keeps the four lists, contributes one
 * hotkey action per item, and turns one key press (or one button click) into
 * exactly ONE gesture — one chat line, one stash-search fill, one bookmark
 * open, or one overlay panel.
 *
 * Everything that touches the game goes through the chat command service
 * (kill switch, dry-run, rate limiter, foreground and allowlist checks, trace
 * line). Nothing here retries, chains, or repeats: a blocked attempt is
 * reported and forgotten.
 */
import {
  checkBookmarkUrl,
  checkStashSearchText,
  commandPreview,
  hotkeyActionId,
  HOTKEY_GROUPS,
  imageDimensions,
  ITEM_ID_PATTERN,
  newItemId,
  normalizeBookmarksSettings,
  normalizeCommandsSettings,
  normalizeNotesSettings,
  NOTES_PANEL_ACTION_ID,
  parseImageDataUri,
  placeholderContextFrom,
  RUN_DEBOUNCE_MS,
  STARTER_ISSUE,
  starterCommands,
  starterStashSearches,
  STASH_SEARCH_PANEL_ACTION_ID,
  type ItemKind,
} from "../../../core/commandsBookmarksNotes.js";
import type { ClientLogEvent } from "../../../core/clientLog.js";
import type { ChatCommandService } from "../../chatCommandService.js";
import type { HotkeyAction, HotkeyService } from "../../hotkeyService.js";
import type { OverlayService } from "../../overlayWindow.js";
import type { SettingsNamespace } from "../../settingsStore.js";
import type { NoticePayload } from "../../../shared/overlay.js";
import {
  NOTES_PANEL_ID,
  STASH_SEARCH_PANEL_ID,
  type BookmarkMode,
  type BookmarkOpenOutcome,
  type BookmarksSavePayload,
  type BookmarkView,
  type BookmarksSettings,
  type BookmarksView,
  type CommandPreview,
  type CommandsSavePayload,
  type CommandsSettings,
  type CommandsView,
  type CommandView,
  type HotkeyRef,
  type NoteDetail,
  type NotesSavePayload,
  type NotesSettings,
  type NotesView,
  type NoteView,
  type PlaceholderSnapshot,
  type RunOutcome,
  type StashSearchView,
} from "../../../shared/commandsBookmarksNotes.js";
import { defaultWindowBounds, type BookmarkWebWindow } from "./webWindow.js";
import type { NoteImageStore } from "./noteImages.js";

/** The slice of the client-log foundation this package reads (optional). */
export interface ClientLogLike {
  status(): {
    character?: { name: string };
    area?: { info: { name: string } };
  };
  recent(kind?: "whisper", limit?: number): ClientLogEvent[];
}

export interface ServiceDeps {
  settings: {
    commands: SettingsNamespace<CommandsSettings>;
    bookmarks: SettingsNamespace<BookmarksSettings>;
    notes: SettingsNamespace<NotesSettings>;
  };
  hotkeys: HotkeyService;
  overlay: OverlayService;
  chat: ChatCommandService;
  /** Optional: registration order, or no Client.txt found. */
  clientLog?: ClientLogLike;
  /** The price feed's already-resolved league — a fallback for `{league}`. */
  league: () => string | undefined;
  dryRun: () => boolean;
  openExternal: (url: string) => Promise<void>;
  webWindow: BookmarkWebWindow;
  images: NoteImageStore;
  overlayDisplay: () => { x: number; y: number; width: number; height: number } | undefined;
  emit: (channel: string, payload: unknown) => void;
  log: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  now?: () => number;
  /** True on a first run: show the starter examples until the user saves. */
  seeded?: boolean;
}

interface Contributed {
  uncontribute: () => void;
  label: string;
  detail: string;
  group: string;
}

const BOUNDS_DEBOUNCE_MS = 500;
const NOTICE_TTL_MS = 2500;

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** New rows from the editor arrive with a placeholder id; give them a real one. */
function withIds(raw: unknown, kind: ItemKind): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id === "string" && ITEM_ID_PATTERN.test(id)) return entry;
    return { ...record, id: newItemId(kind) };
  });
}

export class CommandsBookmarksNotesService {
  private readonly deps: ServiceDeps;
  private readonly now: () => number;
  private readonly contributed = new Map<string, Contributed>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly lastRuns = new Map<string, RunOutcome>();
  private readonly lastOpened = new Map<string, string>();
  private commandIssues: string[] = [];
  private bookmarkIssues: string[] = [];
  private noteIssues: string[] = [];
  private seeded: boolean;
  private currentNoteId: string | undefined;
  private boundsTimer: ReturnType<typeof setTimeout> | undefined;
  private stopBounds: (() => void) | undefined;
  private stopPanelEvents: (() => void) | undefined;
  private disposed = false;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.seeded = deps.seeded === true;
    this.currentNoteId = deps.settings.notes.get().lastNoteId;
  }

  /** Subscribes to the overlay and the bookmark window; contributes the hotkeys. */
  start(): void {
    this.stopPanelEvents = this.deps.overlay.onPanelEvent((event) => {
      if (event.panelId === NOTES_PANEL_ID) this.emitNotes();
      if (event.panelId === STASH_SEARCH_PANEL_ID) this.emitCommands();
    });
    this.stopBounds = this.deps.webWindow.onBoundsChanged((bounds) => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => {
        this.boundsTimer = undefined;
        if (this.disposed) return;
        const current = this.deps.settings.bookmarks.get();
        this.deps.settings.bookmarks.set({ window: { ...current.window, ...bounds } });
        this.emitBookmarks();
      }, BOUNDS_DEBOUNCE_MS);
      this.boundsTimer.unref?.();
    });
    this.syncHotkeys();
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private hotkeyRefs(): Map<string, HotkeyRef> {
    const refs = new Map<string, HotkeyRef>();
    for (const binding of this.deps.hotkeys.list()) {
      const ref: HotkeyRef = {
        actionId: binding.id,
        accelerator: binding.accelerator,
        registered: binding.registered,
      };
      if (binding.error) ref.error = binding.error;
      refs.set(binding.id, ref);
    }
    return refs;
  }

  private refFor(refs: Map<string, HotkeyRef>, kind: ItemKind, id: string): HotkeyRef {
    const actionId = hotkeyActionId(kind, id);
    return refs.get(actionId) ?? { actionId, accelerator: null, registered: false };
  }

  private showingStarters(settings: CommandsSettings): boolean {
    return this.seeded && settings.commands.length === 0 && settings.searches.length === 0;
  }

  commandsView(): CommandsView {
    const settings = this.deps.settings.commands.get();
    const refs = this.hotkeyRefs();
    const starters = this.showingStarters(settings);
    const commands = starters ? starterCommands() : settings.commands;
    const searches = starters ? starterStashSearches() : settings.searches;
    let chatEnabled = true;
    try {
      chatEnabled = this.deps.chat.status().enabled;
    } catch (error) {
      this.deps.log("warn", "chat status unavailable", error);
    }
    return {
      commands: commands.map((item): CommandView => {
        const view: CommandView = { ...item, hotkey: this.refFor(refs, "command", item.id) };
        const lastRun = this.lastRuns.get(hotkeyActionId("command", item.id));
        if (lastRun) view.lastRun = lastRun;
        return view;
      }),
      searches: searches.map((item): StashSearchView => {
        const view: StashSearchView = { ...item, hotkey: this.refFor(refs, "search", item.id) };
        const lastRun = this.lastRuns.get(hotkeyActionId("search", item.id));
        if (lastRun) view.lastRun = lastRun;
        return view;
      }),
      feedbackNotices: settings.feedbackNotices,
      placeholders: this.placeholders(),
      chatEnabled,
      dryRun: this.deps.dryRun(),
      issues: starters ? [...this.commandIssues, STARTER_ISSUE] : [...this.commandIssues],
    };
  }

  bookmarksView(): BookmarksView {
    const settings = this.deps.settings.bookmarks.get();
    const refs = this.hotkeyRefs();
    return {
      bookmarks: settings.bookmarks.map((item): BookmarkView => {
        const view: BookmarkView = { ...item, hotkey: this.refFor(refs, "bookmark", item.id) };
        const at = this.lastOpened.get(item.id);
        if (at) view.lastOpenedAt = at;
        return view;
      }),
      window: settings.window,
      windowOpen: this.deps.webWindow.isOpen(),
      windowVisible: this.deps.webWindow.isVisible(),
      issues: [...this.bookmarkIssues],
    };
  }

  notesView(): NotesView {
    const settings = this.deps.settings.notes.get();
    const refs = this.hotkeyRefs();
    const view: NotesView = {
      notes: settings.notes.map((item): NoteView => ({ ...item, hotkey: this.refFor(refs, "note", item.id) })),
      panel: settings.panel,
      panelVisible: this.deps.overlay.isVisible(NOTES_PANEL_ID),
      issues: [...this.noteIssues],
    };
    if (settings.lastNoteId) view.lastNoteId = settings.lastNoteId;
    return view;
  }

  noteDetail(id: string): NoteDetail | undefined {
    const settings = this.deps.settings.notes.get();
    const note = settings.notes.find((entry) => entry.id === id);
    if (!note) return undefined;
    const refs = this.hotkeyRefs();
    const detail: NoteDetail = { note: { ...note, hotkey: this.refFor(refs, "note", note.id) } };
    if (note.image) {
      const dataUri = this.deps.images.get(note.id, note.image);
      if (dataUri) detail.imageDataUri = dataUri;
    }
    return detail;
  }

  placeholders(): PlaceholderSnapshot {
    let status: { character?: { name: string }; area?: { info: { name: string } } } | undefined;
    let whispers: Array<Extract<ClientLogEvent, { kind: "whisper" }>> = [];
    try {
      const log = this.deps.clientLog;
      status = log?.status();
      whispers = (log?.recent("whisper", 50) ?? []).filter(
        (event): event is Extract<ClientLogEvent, { kind: "whisper" }> => event.kind === "whisper",
      );
    } catch (error) {
      this.deps.log("warn", "client log unavailable for placeholders", error);
    }
    const input: Parameters<typeof placeholderContextFrom>[0] = { whispers };
    if (status) input.status = status;
    const league = this.deps.league();
    if (league) input.league = league;
    return placeholderContextFrom(input);
  }

  preview(template: string): CommandPreview {
    return commandPreview(String(template ?? ""), this.placeholders());
  }

  // -------------------------------------------------------------------------
  // Saves
  // -------------------------------------------------------------------------

  saveCommands(payload: CommandsSavePayload): CommandsView {
    const current = this.deps.settings.commands.get();
    // While the starter examples are on screen the tool promised "save to keep
    // them". A save that carries only ONE of the two lists (or only the
    // notices switch) must therefore keep the OTHER list's examples instead of
    // falling back to the still-empty persisted value and losing them.
    const starters = this.showingStarters(current);
    const keptCommands = starters ? starterCommands() : current.commands;
    const keptSearches = starters ? starterStashSearches() : current.searches;
    const sanitized = normalizeCommandsSettings({
      commands: payload.commands === undefined ? keptCommands : withIds(payload.commands, "command"),
      searches: payload.searches === undefined ? keptSearches : withIds(payload.searches, "search"),
      feedbackNotices: payload.feedbackNotices === undefined ? current.feedbackNotices : payload.feedbackNotices,
    });
    this.commandIssues = sanitized.issues;
    this.seeded = false;
    this.deps.settings.commands.set(() => sanitized.value);
    this.syncHotkeys();
    return this.emitCommands();
  }

  saveBookmarks(payload: BookmarksSavePayload): BookmarksView {
    const current = this.deps.settings.bookmarks.get();
    const sanitized = normalizeBookmarksSettings({
      bookmarks: payload.bookmarks === undefined ? current.bookmarks : withIds(payload.bookmarks, "bookmark"),
      window: payload.window === undefined ? current.window : payload.window,
    });
    this.bookmarkIssues = sanitized.issues;
    this.deps.settings.bookmarks.set(() => sanitized.value);
    this.syncHotkeys();
    return this.emitBookmarks();
  }

  saveNotes(payload: NotesSavePayload): NotesView {
    const current = this.deps.settings.notes.get();
    const sanitized = normalizeNotesSettings({
      notes: payload.notes === undefined ? current.notes : withIds(payload.notes, "note"),
      panel: payload.panel === undefined ? current.panel : payload.panel,
      lastNoteId: current.lastNoteId,
    });
    this.noteIssues = sanitized.issues;
    const keptIds = new Set(sanitized.value.notes.map((note) => note.id));
    // Only the notes the USER removed lose their bytes. A row the sanitizer
    // dropped (over the 40-note cap, unreadable) is still in the payload, so
    // its image survives and can be recovered by saving again; the start-up
    // sweep collects it later if the note never comes back.
    const submittedIds = new Set(
      (Array.isArray(payload.notes) ? payload.notes : []).flatMap((entry) => {
        const id = (entry as { id?: unknown })?.id;
        return typeof id === "string" ? [id] : [];
      }),
    );
    for (const note of current.notes) {
      if (!keptIds.has(note.id) && !submittedIds.has(note.id)) this.deps.images.remove(note.id);
    }
    this.deps.settings.notes.set(() => sanitized.value);
    this.syncHotkeys();
    return this.emitNotes();
  }

  /** `null` removes the image; anything else must be an allowlisted data URI ≤ 2 MB. */
  setNoteImage(id: string, dataUri: string | null): NoteView | undefined {
    const settings = this.deps.settings.notes.get();
    const note = settings.notes.find((entry) => entry.id === id);
    if (!note) return undefined;
    let next = { ...note };
    if (dataUri === null) {
      this.deps.images.remove(id);
      delete next.image;
    } else {
      const parsed = parseImageDataUri(dataUri);
      if (!parsed.ok) throw new Error(parsed.reason);
      const meta = this.deps.images.put(id, parsed.image);
      const size = imageDimensions(parsed.image.bytes, parsed.image.mime);
      next = { ...next, image: size ? { ...meta, width: size.width, height: size.height } : meta };
    }
    const notes = settings.notes.map((entry) => (entry.id === id ? next : entry));
    this.deps.settings.notes.set({ notes });
    const view = this.emitNotes();
    return view.notes.find((entry) => entry.id === id);
  }

  // -------------------------------------------------------------------------
  // Runs — one gesture each
  // -------------------------------------------------------------------------

  private blocked(resolved: string, blockedBy: RunOutcome["blockedBy"], error: string): RunOutcome {
    return { ok: false, dryRun: this.deps.dryRun(), at: isoOf(this.now()), resolved, blockedBy, error };
  }

  /** Key auto-repeat and double taps must not become two chat lines. */
  private debounced(actionId: string): boolean {
    const previous = this.lastRunAt.get(actionId);
    const now = this.now();
    if (previous !== undefined && now - previous < RUN_DEBOUNCE_MS) return true;
    this.lastRunAt.set(actionId, now);
    return false;
  }

  async runCommand(id: string, options: { focus?: boolean; fromHotkey?: boolean } = {}): Promise<RunOutcome> {
    const settings = this.deps.settings.commands.get();
    const item = (this.showingStarters(settings) ? starterCommands() : settings.commands).find(
      (entry) => entry.id === id,
    );
    const actionId = hotkeyActionId("command", id);
    if (!item) return this.finishRun("command", id, this.blocked("", "unknown-item", "that command no longer exists"), options);
    if (!item.enabled) {
      return this.finishRun("command", id, this.blocked(item.template, "disabled", "the command is switched off"), options);
    }
    if (this.debounced(actionId)) {
      return this.finishRun("command", id, this.blocked(item.template, "debounced", "ignored a repeated key press"), options);
    }
    const snapshot = this.placeholders();
    const resolved = this.deps.chat.resolvePlaceholders(item.template, snapshot.context);
    const outcome = await this.deps.chat.send({
      text: resolved,
      reason: `command "${item.label}"`,
      source: "command",
      focus: options.focus === true,
    });
    const run: RunOutcome = {
      ok: outcome.ok,
      dryRun: outcome.dryRun,
      at: outcome.at,
      resolved,
      ...(outcome.sent !== undefined ? { sent: outcome.sent } : {}),
      ...(outcome.blockedBy !== undefined ? { blockedBy: outcome.blockedBy } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
    return this.finishRun("command", id, run, options);
  }

  async runSearch(id: string, options: { focus?: boolean; fromHotkey?: boolean; fromPanel?: boolean } = {}): Promise<RunOutcome> {
    const settings = this.deps.settings.commands.get();
    const item = (this.showingStarters(settings) ? starterStashSearches() : settings.searches).find(
      (entry) => entry.id === id,
    );
    if (!item) return this.finishRun("search", id, this.blocked("", "unknown-item", "that search no longer exists"), options);
    if (!item.enabled) {
      return this.finishRun("search", id, this.blocked(item.text, "disabled", "the search is switched off"), options);
    }
    const actionId = hotkeyActionId("search", id);
    if (this.debounced(actionId)) {
      return this.finishRun("search", id, this.blocked(item.text, "debounced", "ignored a repeated key press"), options);
    }
    const run = await this.searchGesture(item.text, `stash search "${item.label}"`, options);
    return this.finishRun("search", id, run, options);
  }

  async runSearchText(
    text: string,
    options: { focus?: boolean; fromHotkey?: boolean; fromPanel?: boolean; reason?: string } = {},
  ): Promise<RunOutcome> {
    if (this.debounced("stash-search.text")) {
      return this.finishRun("search", undefined, this.blocked(String(text ?? ""), "debounced", "ignored a repeated key press"), options);
    }
    const run = await this.searchGesture(String(text ?? ""), options.reason ?? "stash search (panel)", options);
    return this.finishRun("search", undefined, run, options);
  }

  /**
   * One stash-search fill. The Alt+F panel holds keyboard focus while the user
   * types, so it hands focus back to the game first; the chat service then
   * fronts Path of Exile itself and verifies before typing.
   */
  private async searchGesture(
    text: string,
    reason: string,
    options: { focus?: boolean; fromPanel?: boolean },
  ): Promise<RunOutcome> {
    const check = checkStashSearchText(text);
    if (!check.ok) {
      return this.blocked(check.text, "empty", check.reason ?? "the search text cannot be typed");
    }
    if (options.fromPanel) {
      try {
        this.deps.overlay.setFocus(STASH_SEARCH_PANEL_ID, false);
      } catch (error) {
        this.deps.log("warn", "could not hand focus back to the game", error);
      }
    }
    const focus = options.focus === true || options.fromPanel === true;
    const outcome = await this.deps.chat.stashSearch(check.text, reason, { focus });
    return {
      ok: outcome.ok,
      dryRun: outcome.dryRun,
      at: outcome.at,
      resolved: check.text,
      ...(outcome.sent !== undefined ? { sent: outcome.sent } : {}),
      ...(outcome.blockedBy !== undefined ? { blockedBy: outcome.blockedBy } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  private finishRun(
    kind: "command" | "search",
    id: string | undefined,
    outcome: RunOutcome,
    options: { fromHotkey?: boolean },
  ): RunOutcome {
    // The view's `lastRun` must agree with the `commands:ran` event — the
    // refusals this service makes itself (unknown-item / disabled / debounced)
    // are attempts too, not only the ones the chat service answered.
    if (id !== undefined) this.lastRuns.set(hotkeyActionId(kind, id), outcome);
    this.deps.emit("commands:ran", { kind, ...(id !== undefined ? { id } : {}), outcome });
    this.emitCommands();
    if (options.fromHotkey) void this.notify(kind, outcome);
    return outcome;
  }

  /** A 2.5 s toast, only for hotkey-driven runs (a button shows the same text inline). */
  private async notify(kind: "command" | "search", outcome: RunOutcome): Promise<void> {
    if (!this.deps.settings.commands.get().feedbackNotices) return;
    const verb = kind === "command" ? "send" : "type";
    let payload: NoticePayload;
    if (outcome.dryRun) {
      payload = { title: "Dry-run", body: `would ${verb}: ${outcome.resolved}`, tone: "info", ttlMs: NOTICE_TTL_MS };
    } else if (outcome.ok) {
      payload = {
        title: kind === "command" ? "Sent" : "Typed",
        body: outcome.sent ?? outcome.resolved,
        tone: "ok",
        ttlMs: NOTICE_TTL_MS,
      };
    } else {
      payload = {
        title: `Blocked: ${outcome.blockedBy ?? "unknown"}`,
        body: outcome.error ?? "",
        tone: "danger",
        ttlMs: NOTICE_TTL_MS,
      };
    }
    try {
      await this.deps.overlay.show("notice", { anchor: "top-right", payload });
    } catch (error) {
      this.deps.log("warn", "notice could not be shown", error);
    }
  }

  // -------------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------------

  async openBookmark(id: string, options: { fromHotkey?: boolean } = {}): Promise<BookmarkOpenOutcome> {
    const settings = this.deps.settings.bookmarks.get();
    const item = settings.bookmarks.find((entry) => entry.id === id);
    if (!item) {
      return { ok: false, mode: "external", url: "", at: isoOf(this.now()), error: "that bookmark no longer exists" };
    }
    const outcome = await this.openUrl(item.url, item.mode, item.label);
    if (outcome.ok) {
      this.lastOpened.set(id, outcome.at);
      this.emitBookmarks();
    }
    if (options.fromHotkey && !outcome.ok) {
      try {
        await this.deps.overlay.show("notice", {
          anchor: "top-right",
          payload: { title: "Bookmark blocked", body: outcome.error ?? "", tone: "danger", ttlMs: NOTICE_TTL_MS },
        });
      } catch (error) {
        this.deps.log("warn", "notice could not be shown", error);
      }
    }
    return outcome;
  }

  async openUrl(url: string, mode: BookmarkMode = "external", title?: string): Promise<BookmarkOpenOutcome> {
    const at = isoOf(this.now());
    // Defence in depth: the stored value was checked on save, check it again.
    const check = checkBookmarkUrl(url);
    if (!check.ok || !check.url) {
      return { ok: false, mode, url: String(url ?? ""), at, error: check.reason ?? "the address cannot be opened" };
    }
    try {
      if (mode === "window") {
        const settings = this.deps.settings.bookmarks.get();
        const bounds = defaultWindowBounds(settings.window, this.deps.overlayDisplay());
        await this.deps.webWindow.toggle(check.url, title ?? "Bookmark", bounds, settings.window.alwaysOnTop);
        this.emitBookmarks();
      } else {
        await this.deps.openExternal(check.url);
      }
      return { ok: true, mode, url: check.url, at };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", `bookmark could not be opened: ${message}`);
      return { ok: false, mode, url: check.url, at, error: message };
    }
  }

  closeWindow(): boolean {
    const closed = this.deps.webWindow.close();
    if (closed) this.emitBookmarks();
    return closed;
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  private noteIdToShow(noteId?: string): string | undefined {
    const settings = this.deps.settings.notes.get();
    if (noteId && settings.notes.some((note) => note.id === noteId)) return noteId;
    if (this.currentNoteId && settings.notes.some((note) => note.id === this.currentNoteId)) return this.currentNoteId;
    if (settings.lastNoteId && settings.notes.some((note) => note.id === settings.lastNoteId)) return settings.lastNoteId;
    return settings.notes[0]?.id;
  }

  private rememberNote(noteId: string | undefined): void {
    this.currentNoteId = noteId;
    const settings = this.deps.settings.notes.get();
    if (noteId && settings.lastNoteId !== noteId) this.deps.settings.notes.set({ lastNoteId: noteId });
  }

  async showNotes(noteId?: string): Promise<void> {
    const settings = this.deps.settings.notes.get();
    const selected = this.noteIdToShow(noteId);
    this.rememberNote(selected);
    await this.deps.overlay.show(NOTES_PANEL_ID, {
      anchor: settings.panel.anchor,
      width: settings.panel.width,
      height: settings.panel.height,
      payload: selected ? { noteId: selected } : {},
    });
    this.emitNotes();
  }

  async toggleNotes(noteId?: string): Promise<void> {
    if (this.deps.overlay.isVisible(NOTES_PANEL_ID)) {
      const selected = this.noteIdToShow(noteId);
      if (noteId && selected === noteId && noteId !== this.currentNoteId) {
        this.rememberNote(noteId);
        this.deps.overlay.update(NOTES_PANEL_ID, { noteId });
        this.emitNotes();
        return;
      }
      this.hideNotes();
      return;
    }
    await this.showNotes(noteId);
  }

  hideNotes(): void {
    this.deps.overlay.hide(NOTES_PANEL_ID);
    this.emitNotes();
  }

  async showSearchPanel(prefill?: string): Promise<void> {
    await this.deps.overlay.show(STASH_SEARCH_PANEL_ID, {
      anchor: "cursor",
      width: 380,
      height: 220,
      focus: true,
      payload: prefill ? { prefill } : {},
    });
    this.emitCommands();
  }

  async toggleSearchPanel(): Promise<void> {
    if (this.deps.overlay.isVisible(STASH_SEARCH_PANEL_ID)) {
      this.deps.overlay.hide(STASH_SEARCH_PANEL_ID);
      this.emitCommands();
      return;
    }
    await this.showSearchPanel();
  }

  // -------------------------------------------------------------------------
  // Hotkeys
  // -------------------------------------------------------------------------

  /**
   * Contributes one action per enabled item plus the two fixed panel actions.
   * A renamed item is un-contributed and contributed again; the registry
   * restores the user's accelerator by id, so the binding round-trips.
   */
  syncHotkeys(): void {
    const desired = new Map<string, HotkeyAction>();
    desired.set(NOTES_PANEL_ACTION_ID, {
      id: NOTES_PANEL_ACTION_ID,
      label: "Notes",
      detail: "Show or hide the cheat-sheet notes panel.",
      group: HOTKEY_GROUPS.overlay,
      defaultAccelerator: "Alt+N",
      run: () => this.toggleNotes(),
    });
    desired.set(STASH_SEARCH_PANEL_ACTION_ID, {
      id: STASH_SEARCH_PANEL_ACTION_ID,
      label: "Stash search",
      detail: "Type into the game's stash search box from a small panel.",
      group: HOTKEY_GROUPS.overlay,
      defaultAccelerator: "Alt+F",
      run: () => this.toggleSearchPanel(),
    });

    const commands = this.deps.settings.commands.get();
    for (const item of commands.commands) {
      if (!item.enabled) continue;
      desired.set(hotkeyActionId("command", item.id), {
        id: hotkeyActionId("command", item.id),
        label: item.label,
        detail: item.template.slice(0, 80),
        group: HOTKEY_GROUPS.command,
        defaultAccelerator: null,
        run: () => this.runCommand(item.id, { fromHotkey: true }).then(() => undefined),
      });
    }
    for (const item of commands.searches) {
      if (!item.enabled) continue;
      desired.set(hotkeyActionId("search", item.id), {
        id: hotkeyActionId("search", item.id),
        label: item.label,
        detail: item.text.slice(0, 80),
        group: HOTKEY_GROUPS.search,
        defaultAccelerator: null,
        run: () => this.runSearch(item.id, { fromHotkey: true }).then(() => undefined),
      });
    }
    for (const item of this.deps.settings.bookmarks.get().bookmarks) {
      if (!item.enabled) continue;
      let host = item.url;
      try {
        host = new URL(item.url).host;
      } catch {
        // checkBookmarkUrl already refused anything unparsable; keep the raw text.
      }
      desired.set(hotkeyActionId("bookmark", item.id), {
        id: hotkeyActionId("bookmark", item.id),
        label: item.label,
        detail: host,
        group: HOTKEY_GROUPS.bookmark,
        defaultAccelerator: null,
        run: () => this.openBookmark(item.id, { fromHotkey: true }).then(() => undefined),
      });
    }
    for (const item of this.deps.settings.notes.get().notes) {
      if (!item.enabled) continue;
      desired.set(hotkeyActionId("note", item.id), {
        id: hotkeyActionId("note", item.id),
        label: `${item.icon} ${item.title}`.trim(),
        detail: "Show this note in the overlay.",
        group: HOTKEY_GROUPS.note,
        defaultAccelerator: null,
        run: () => this.toggleNotes(item.id),
      });
    }

    for (const [actionId, entry] of [...this.contributed]) {
      const next = desired.get(actionId);
      if (next && next.label === entry.label && (next.detail ?? "") === entry.detail && next.group === entry.group) {
        continue;
      }
      entry.uncontribute();
      this.contributed.delete(actionId);
    }
    for (const [actionId, action] of desired) {
      if (this.contributed.has(actionId)) continue;
      try {
        // Contribute the action UNCHANGED: every `run` above answers a promise
        // and HotkeyService.trigger awaits it inside its own try/catch. A
        // `() => void action.run()` wrapper would resolve trigger early and
        // turn a rejection (overlay window gone, chat service throwing) into
        // an unhandled rejection in the main process.
        const uncontribute = this.deps.hotkeys.contribute(action);
        this.contributed.set(actionId, {
          uncontribute,
          label: action.label,
          detail: action.detail ?? "",
          group: action.group,
        });
      } catch (error) {
        this.deps.log("warn", `hotkey action "${actionId}" could not be contributed`, error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  emitCommands(): CommandsView {
    const view = this.commandsView();
    this.deps.emit("commands:changed", view);
    return view;
  }

  emitBookmarks(): BookmarksView {
    const view = this.bookmarksView();
    this.deps.emit("bookmarks:changed", view);
    return view;
  }

  emitNotes(): NotesView {
    const view = this.notesView();
    this.deps.emit("notes:changed", view);
    return view;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = undefined;
    this.stopBounds?.();
    this.stopPanelEvents?.();
    for (const entry of this.contributed.values()) {
      try {
        entry.uncontribute();
      } catch (error) {
        this.deps.log("warn", "hotkey could not be removed", error);
      }
    }
    this.contributed.clear();
    try {
      this.deps.webWindow.close();
    } catch (error) {
      this.deps.log("warn", "bookmark window could not be closed", error);
    }
    await Promise.resolve();
  }
}
