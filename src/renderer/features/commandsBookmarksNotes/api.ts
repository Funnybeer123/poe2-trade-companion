/**
 * Renderer clients for the "commandsBookmarksNotes" package. Each returns
 * null in the browser preview so the tool and the panels render their
 * "needs the desktop app" state instead of throwing.
 */
import type { AppFeatureContract, AppFeatureEvents } from "../../../shared/features.js";
import type {
  BookmarksContract,
  BookmarksEvents,
  CommandsContract,
  CommandsEvents,
  NotesContract,
  NotesEvents,
} from "../../../shared/commandsBookmarksNotes.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type CommandsApi = FeatureApi<CommandsContract, CommandsEvents>;
export type BookmarksApi = FeatureApi<BookmarksContract, BookmarksEvents>;
export type NotesApi = FeatureApi<NotesContract, NotesEvents>;
export type AppApi = FeatureApi<AppFeatureContract, AppFeatureEvents>;

export function getCommandsApi(): CommandsApi | null {
  return createFeatureApi<CommandsContract, CommandsEvents>();
}

export function getBookmarksApi(): BookmarksApi | null {
  return createFeatureApi<BookmarksContract, BookmarksEvents>();
}

export function getNotesApi(): NotesApi | null {
  return createFeatureApi<NotesContract, NotesEvents>();
}

/** The scaffold's channels — used only for the top-bar Dry-run mirror. */
export function getAppApi(): AppApi | null {
  return createFeatureApi<AppFeatureContract, AppFeatureEvents>();
}
