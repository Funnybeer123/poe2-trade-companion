/**
 * Favourite searches in folders — the model behind
 * `%APPDATA%/poe2-trade-companion/market-favorites.json`.
 *
 * Every operation is pure and returns a NEW file, so the service can decide
 * when to persist and the renderer can diff. The sanitizer never throws: a
 * favourites file is hand-editable and survives app versions.
 */
import { defaultColour, isMarketColour, sanitizeDraft, type MarketDraft } from "./marketQuery.js";

export interface MarketFolder {
  id: string;
  name: string;
  colour: string;
  order: number;
  expanded: boolean;
}

export interface MarketFavorite {
  id: string;
  /** null = the root group (favourites outside any folder). */
  folderId: string | null;
  name: string;
  colour: string;
  draft: MarketDraft;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarketFavoritesFile {
  schemaVersion: 1;
  folders: MarketFolder[];
  favorites: MarketFavorite[];
}

export const MAX_FOLDERS = 50;
export const MAX_FAVORITES = 300;
const MAX_NAME = 60;

export function emptyFavorites(): MarketFavoritesFile {
  return { schemaVersion: 1, folders: [], favorites: [] };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function newFavoriteId(): string {
  return `fav_${Date.now().toString(36)}_${randomSuffix()}`;
}

export function newFolderId(): string {
  return `fld_${Date.now().toString(36)}_${randomSuffix()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function name(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_NAME) : fallback;
}

function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/** Renumber `order` 0..n-1 in the current array order. */
function renumber<T extends { order: number }>(rows: T[]): T[] {
  rows.forEach((row, index) => {
    row.order = index;
  });
  return rows;
}

/**
 * Sanitize `market-favorites.json`. Orphan folder references fall back to
 * the root group, duplicate ids keep the first row, and the caps are
 * applied before anything else so a huge file cannot stall the UI.
 */
export function normalizeMarketFavorites(raw: unknown): { value: MarketFavoritesFile; issues: string[] } {
  const issues: string[] = [];
  const source = isRecord(raw) ? raw : {};
  const nowIso = new Date(0).toISOString();

  const folders: MarketFolder[] = [];
  const folderIds = new Set<string>();
  for (const entry of Array.isArray(source.folders) ? source.folders : []) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || folderIds.has(id)) {
      if (id) issues.push(`duplicate folder id "${id}" dropped`);
      continue;
    }
    if (folders.length >= MAX_FOLDERS) {
      issues.push(`more than ${MAX_FOLDERS} folders; extra dropped`);
      break;
    }
    folderIds.add(id);
    folders.push({
      id,
      name: name(entry.name, "Folder"),
      colour: isMarketColour(entry.colour) ? entry.colour : "grey",
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : folders.length,
      expanded: entry.expanded !== false,
    });
  }
  folders.sort((left, right) => left.order - right.order);
  renumber(folders);

  const favorites: MarketFavorite[] = [];
  const favoriteIds = new Set<string>();
  for (const entry of Array.isArray(source.favorites) ? source.favorites : []) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || favoriteIds.has(id)) {
      if (id) issues.push(`duplicate favourite id "${id}" dropped`);
      continue;
    }
    const draft = sanitizeDraft(entry.draft);
    if (!draft) {
      issues.push(`favourite "${id}" has no usable query; dropped`);
      continue;
    }
    if (favorites.length >= MAX_FAVORITES) {
      issues.push(`more than ${MAX_FAVORITES} favourites; extra dropped`);
      break;
    }
    favoriteIds.add(id);
    let folderId: string | null = null;
    if (typeof entry.folderId === "string" && entry.folderId) {
      if (folderIds.has(entry.folderId)) folderId = entry.folderId;
      else issues.push(`favourite "${id}" pointed at a missing folder; moved to the root`);
    }
    const createdAt = isoOr(entry.createdAt, nowIso);
    favorites.push({
      id,
      folderId,
      name: name(entry.name, "Saved search"),
      colour: isMarketColour(entry.colour) ? entry.colour : defaultColour(draft),
      draft,
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : favorites.length,
      createdAt,
      updatedAt: isoOr(entry.updatedAt, createdAt),
    });
  }
  favorites.sort((left, right) => left.order - right.order);
  renumberPerFolder(favorites);

  return { value: { schemaVersion: 1, folders, favorites }, issues };
}

function renumberPerFolder(favorites: MarketFavorite[]): MarketFavorite[] {
  const counters = new Map<string, number>();
  for (const favorite of favorites) {
    const key = favorite.folderId ?? "";
    const next = counters.get(key) ?? 0;
    favorite.order = next;
    counters.set(key, next + 1);
  }
  return favorites;
}

export function parseMarketFavorites(text: string | undefined): MarketFavoritesFile {
  if (!text) return emptyFavorites();
  try {
    return normalizeMarketFavorites(JSON.parse(text)).value;
  } catch {
    return emptyFavorites();
  }
}

export function serializeMarketFavorites(file: MarketFavoritesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function clone(file: MarketFavoritesFile): MarketFavoritesFile {
  return {
    schemaVersion: 1,
    folders: file.folders.map((folder) => ({ ...folder })),
    favorites: file.favorites.map((favorite) => ({ ...favorite })),
  };
}

export interface SaveFavoriteInput {
  /** Present = update that favourite in place ("Update favorite"). */
  id?: string;
  folderId?: string | null;
  name?: string;
  colour?: string;
  draft: MarketDraft;
}

/**
 * Save a new favourite, or overwrite the named one in place (keeping its
 * position in the tree so "Update favorite" never reshuffles the list).
 */
export function saveFavorite(
  file: MarketFavoritesFile,
  input: SaveFavoriteInput,
  now: string,
): { file: MarketFavoritesFile; favorite: MarketFavorite; refused?: "favorite-limit" } {
  const next = clone(file);
  const existing = input.id ? next.favorites.find((favorite) => favorite.id === input.id) : undefined;
  if (existing) {
    existing.draft = input.draft;
    if (input.name !== undefined) existing.name = name(input.name, existing.name);
    if (input.colour !== undefined && isMarketColour(input.colour)) existing.colour = input.colour;
    if (input.folderId !== undefined) {
      existing.folderId = input.folderId && next.folders.some((folder) => folder.id === input.folderId)
        ? input.folderId
        : null;
    }
    existing.updatedAt = now;
    renumberPerFolder(next.favorites);
    return { file: next, favorite: { ...existing } };
  }
  if (next.favorites.length >= MAX_FAVORITES) {
    const fallback = next.favorites[0]!;
    return { file: next, favorite: { ...fallback }, refused: "favorite-limit" };
  }
  const folderId =
    input.folderId && next.folders.some((folder) => folder.id === input.folderId) ? input.folderId : null;
  const favorite: MarketFavorite = {
    id: input.id ?? newFavoriteId(),
    folderId,
    name: name(input.name, "Saved search"),
    colour: isMarketColour(input.colour) ? input.colour : defaultColour(input.draft),
    draft: input.draft,
    order: next.favorites.filter((entry) => entry.folderId === folderId).length,
    createdAt: now,
    updatedAt: now,
  };
  next.favorites.push(favorite);
  renumberPerFolder(next.favorites);
  return { file: next, favorite: { ...favorite } };
}

export function removeFavorite(file: MarketFavoritesFile, id: string): MarketFavoritesFile {
  const next = clone(file);
  next.favorites = next.favorites.filter((favorite) => favorite.id !== id);
  renumberPerFolder(next.favorites);
  return next;
}

export interface MoveFavoriteInput {
  id: string;
  folderId: string | null;
  /** Position inside the target group; clamped. */
  index: number;
}

export function moveFavorite(file: MarketFavoritesFile, input: MoveFavoriteInput): MarketFavoritesFile {
  const next = clone(file);
  const moving = next.favorites.find((favorite) => favorite.id === input.id);
  if (!moving) return next;
  const folderId =
    input.folderId && next.folders.some((folder) => folder.id === input.folderId) ? input.folderId : null;
  const rest = next.favorites.filter((favorite) => favorite.id !== input.id);
  const target = rest.filter((favorite) => favorite.folderId === folderId);
  const others = rest.filter((favorite) => favorite.folderId !== folderId);
  moving.folderId = folderId;
  const at = Math.max(0, Math.min(target.length, Math.floor(Number(input.index) || 0)));
  target.splice(at, 0, moving);
  next.favorites = [...others, ...target];
  renumberPerFolder(next.favorites);
  next.favorites.sort(byTreeOrder(next.folders));
  return next;
}

export interface SaveFolderInput {
  id?: string;
  name: string;
  colour?: string;
  expanded?: boolean;
}

export function saveFolder(
  file: MarketFavoritesFile,
  input: SaveFolderInput,
): { file: MarketFavoritesFile; folder: MarketFolder; refused?: "folder-limit" } {
  const next = clone(file);
  const existing = input.id ? next.folders.find((folder) => folder.id === input.id) : undefined;
  if (existing) {
    existing.name = name(input.name, existing.name);
    if (input.colour !== undefined && isMarketColour(input.colour)) existing.colour = input.colour;
    if (input.expanded !== undefined) existing.expanded = input.expanded;
    return { file: next, folder: { ...existing } };
  }
  if (next.folders.length >= MAX_FOLDERS) {
    const fallback = next.folders[0]!;
    return { file: next, folder: { ...fallback }, refused: "folder-limit" };
  }
  const folder: MarketFolder = {
    id: input.id ?? newFolderId(),
    name: name(input.name, "Folder"),
    colour: isMarketColour(input.colour) ? input.colour : "grey",
    order: next.folders.length,
    expanded: input.expanded !== false,
  };
  next.folders.push(folder);
  renumber(next.folders);
  return { file: next, folder: { ...folder } };
}

/** Remove a folder; its favourites move to the root group, order preserved. */
export function removeFolder(file: MarketFavoritesFile, id: string): MarketFavoritesFile {
  const next = clone(file);
  next.folders = next.folders.filter((folder) => folder.id !== id);
  for (const favorite of next.favorites) {
    if (favorite.folderId === id) favorite.folderId = null;
  }
  renumber(next.folders);
  renumberPerFolder(next.favorites);
  return next;
}

export function moveFolder(file: MarketFavoritesFile, input: { id: string; index: number }): MarketFavoritesFile {
  const next = clone(file);
  const moving = next.folders.find((folder) => folder.id === input.id);
  if (!moving) return next;
  const rest = next.folders.filter((folder) => folder.id !== input.id);
  const at = Math.max(0, Math.min(rest.length, Math.floor(Number(input.index) || 0)));
  rest.splice(at, 0, moving);
  next.folders = renumber(rest);
  next.favorites.sort(byTreeOrder(next.folders));
  return next;
}

function byTreeOrder(folders: readonly MarketFolder[]) {
  const rank = new Map<string, number>();
  folders.forEach((folder, index) => rank.set(folder.id, index + 1));
  return (left: MarketFavorite, right: MarketFavorite): number => {
    const leftGroup = left.folderId ? (rank.get(left.folderId) ?? Number.MAX_SAFE_INTEGER) : 0;
    const rightGroup = right.folderId ? (rank.get(right.folderId) ?? Number.MAX_SAFE_INTEGER) : 0;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return left.order - right.order;
  };
}

export interface FavoritesGroup {
  /** null = the root group, which is always rendered first. */
  folder: MarketFolder | null;
  favorites: MarketFavorite[];
}

/** The explorer's rows: root favourites first, then each folder in order. */
export function favoritesTree(file: MarketFavoritesFile): FavoritesGroup[] {
  const groups: FavoritesGroup[] = [
    {
      folder: null,
      favorites: file.favorites.filter((favorite) => favorite.folderId === null).sort((a, b) => a.order - b.order),
    },
  ];
  for (const folder of [...file.folders].sort((a, b) => a.order - b.order)) {
    groups.push({
      folder,
      favorites: file.favorites.filter((favorite) => favorite.folderId === folder.id).sort((a, b) => a.order - b.order),
    });
  }
  return groups;
}
