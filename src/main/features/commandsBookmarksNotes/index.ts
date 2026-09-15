/**
 * Feature module "commandsBookmarksNotes": the Tools → Commands & notes
 * entry, the `notes` and `stash-search` overlay panels, and one hotkey action
 * per saved command / stash search / bookmark / note.
 *
 * It owns three settings namespaces (`commands`, `bookmarks`, `notes`) and
 * the `notes-images/` sidecar folder; it reaches the game ONLY through the
 * chat command service (one line or one search fill per gesture) and never
 * touches the network.
 */
import {
  normalizeBookmarksSettings,
  normalizeCommandsSettings,
  normalizeNotesSettings,
} from "../../../core/commandsBookmarksNotes.js";
import type {
  BookmarkMode,
  BookmarksSavePayload,
  BookmarksSettings,
  CommandsSavePayload,
  CommandsSettings,
  NotesSavePayload,
  NotesSettings,
  RunOptions,
  SearchTextOptions,
} from "../../../shared/commandsBookmarksNotes.js";
import type { FeatureContext, FeatureModule } from "../types.js";
// Importing the client-log module's types brings its FeatureServiceMap
// augmentation into scope; the module registers fine without the service.
import type { ClientLogService } from "../clientLog/index.js";
import { NoteImageStore, noteImagesDir, type NoteImageFs } from "./noteImages.js";
import { CommandsBookmarksNotesService, type ClientLogLike } from "./service.js";
import { electronBookmarkWebWindow, type BookmarkWebWindowFactory } from "./webWindow.js";

export const COMMANDS_SETTINGS_ID = "commands";
export const BOOKMARKS_SETTINGS_ID = "bookmarks";
export const NOTES_SETTINGS_ID = "notes";

export interface CommandsBookmarksNotesModuleDeps {
  /** Defaults to the Electron BrowserWindow factory in webWindow.ts. */
  webWindow?: BookmarkWebWindowFactory;
  /** Defaults to node:fs; tests inject a memory fs for the note images. */
  imageFs?: NoteImageFs;
  now?: () => number;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The price feed's resolved league, without ever touching the network. */
function leagueOf(ctx: FeatureContext): string | undefined {
  try {
    return ctx.core?.priceFeed?.status?.().resolvedLeague;
  } catch {
    return undefined;
  }
}

export function createCommandsBookmarksNotesModule(
  deps: CommandsBookmarksNotesModuleDeps = {},
): FeatureModule {
  return {
    id: "commandsBookmarksNotes",
    register(ctx) {
      const log = (level: "info" | "warn" | "error", message: string, detail?: unknown): void =>
        ctx.log({ feature: "commandsBookmarksNotes", level, message, detail });

      // First run = the namespace has never been written: the tool shows the
      // starter examples until the user saves them.
      const snapshot = ctx.settings.snapshot();
      const seeded = snapshot[COMMANDS_SETTINGS_ID] === undefined;

      const commands = ctx.settings.namespace<CommandsSettings>(COMMANDS_SETTINGS_ID, (raw) => {
        const { value, issues } = normalizeCommandsSettings(raw);
        if (issues.length > 0) log("warn", "commands settings sanitized", issues);
        return value;
      });
      const bookmarks = ctx.settings.namespace<BookmarksSettings>(BOOKMARKS_SETTINGS_ID, (raw) => {
        const { value, issues } = normalizeBookmarksSettings(raw);
        if (issues.length > 0) log("warn", "bookmark settings sanitized", issues);
        return value;
      });
      const notes = ctx.settings.namespace<NotesSettings>(NOTES_SETTINGS_ID, (raw) => {
        const { value, issues } = normalizeNotesSettings(raw);
        if (issues.length > 0) log("warn", "notes settings sanitized", issues);
        return value;
      });

      const overlay = ctx.require("overlay");
      const hotkeys = ctx.require("hotkeys");
      const chat = ctx.require("chatCommands");
      const clientLog = ctx.get("clientLog") as ClientLogService | undefined;

      const images = new NoteImageStore(noteImagesDir(ctx.userDataDir), deps.imageFs);
      const removed = images.sweep(new Set(notes.get().notes.map((note) => note.id)));
      if (removed.length > 0) log("info", `removed ${removed.length} orphan note image(s)`, removed);

      const webWindow = (deps.webWindow ?? electronBookmarkWebWindow)({
        openExternal: (url) => ctx.openExternal(url),
        log,
      });

      const service = new CommandsBookmarksNotesService({
        settings: { commands, bookmarks, notes },
        hotkeys,
        overlay,
        chat,
        ...(clientLog ? { clientLog: clientLog as unknown as ClientLogLike } : {}),
        league: () => leagueOf(ctx),
        dryRun: () => ctx.dryRun(),
        openExternal: (url) => ctx.openExternal(url),
        webWindow,
        images,
        overlayDisplay: () => overlay.state().display?.bounds,
        emit: (channel, payload) => ctx.emit(channel, payload),
        log,
        ...(deps.now ? { now: deps.now } : {}),
        seeded,
      });
      service.start();

      // ---- commands + stash searches -------------------------------------
      ctx.handle("commands:list", () => service.commandsView());
      ctx.handle("commands:save", (payload: CommandsSavePayload) =>
        service.saveCommands(asRecord(payload) as CommandsSavePayload),
      );
      ctx.handle("commands:preview", (template: string) => service.preview(String(template ?? "")));
      ctx.handle("commands:run", (id: string, options?: RunOptions) =>
        service.runCommand(String(id ?? ""), { focus: options?.focus === true }),
      );
      ctx.handle("commands:run-search", (id: string, options?: SearchTextOptions) =>
        service.runSearch(String(id ?? ""), {
          focus: options?.focus === true,
          fromPanel: options?.fromPanel === true,
        }),
      );
      ctx.handle("commands:search-text", (text: string, options?: SearchTextOptions) =>
        service.runSearchText(String(text ?? ""), {
          focus: options?.focus === true,
          fromPanel: options?.fromPanel === true,
        }),
      );
      ctx.handle("commands:placeholders", () => service.placeholders());
      ctx.handle("commands:show-search-panel", (prefill?: string) =>
        service.showSearchPanel(typeof prefill === "string" && prefill ? prefill : undefined),
      );

      // ---- bookmarks ------------------------------------------------------
      ctx.handle("bookmarks:list", () => service.bookmarksView());
      ctx.handle("bookmarks:save", (payload: BookmarksSavePayload) =>
        service.saveBookmarks(asRecord(payload) as BookmarksSavePayload),
      );
      ctx.handle("bookmarks:open", (id: string) => service.openBookmark(String(id ?? "")));
      ctx.handle("bookmarks:open-url", (url: string, mode?: BookmarkMode) =>
        service.openUrl(String(url ?? ""), mode === "window" ? "window" : "external"),
      );
      ctx.handle("bookmarks:close-window", () => service.closeWindow());

      // ---- notes ----------------------------------------------------------
      ctx.handle("notes:list", () => service.notesView());
      ctx.handle("notes:get", (id: string) => service.noteDetail(String(id ?? "")));
      ctx.handle("notes:save", (payload: NotesSavePayload) => service.saveNotes(asRecord(payload) as NotesSavePayload));
      ctx.handle("notes:set-image", (id: string, dataUri: string | null) =>
        service.setNoteImage(String(id ?? ""), typeof dataUri === "string" ? dataUri : null),
      );
      ctx.handle("notes:show", (id?: string) => service.showNotes(typeof id === "string" && id ? id : undefined));
      ctx.handle("notes:hide", () => service.hideNotes());

      // A `settings:set` from anywhere else (P10, a hand edit + reload) must
      // reach the hotkey registry too.
      const stopCommands = commands.onChange(() => {
        service.syncHotkeys();
        service.emitCommands();
      });
      const stopBookmarks = bookmarks.onChange(() => {
        service.syncHotkeys();
        service.emitBookmarks();
      });
      const stopNotes = notes.onChange(() => {
        service.syncHotkeys();
        service.emitNotes();
      });

      return {
        dispose: async () => {
          stopCommands();
          stopBookmarks();
          stopNotes();
          await service.dispose();
        },
      };
    },
  };
}

export const commandsBookmarksNotesModule: FeatureModule = createCommandsBookmarksNotesModule();
