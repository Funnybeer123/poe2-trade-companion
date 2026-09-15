/**
 * Read-only access to the stash tracker's (P6) files and the trade
 * package's (P3) history file.
 *
 * WHY the candidate lists: the compliance review moved P6's journal out of
 * `artifacts/` into `%APPDATA%/poe2-trade-companion/stash-tracker/`, while
 * the conflicts review still names the older `stash-tracker-summary.json`.
 * Home reads whichever exists — it never writes, renames or deletes any of
 * them, so probing a couple of paths is free and survives either outcome.
 *
 * Re-parsing is gated on size+mtime: the journal can hold a thousand full
 * snapshots and Home refreshes every 30 seconds.
 */
import path from "node:path";
import {
  parseStashSnapshotPoints,
  parseStashSummaryFile,
  parseTradeHistoryPoints,
  type StashSnapshotPoint,
  type StashSummaryFile,
  type TradeHistoryPoint,
} from "../../../core/sessionHome.js";

export interface StashFilesFs {
  exists(file: string): boolean;
  read(file: string): string | undefined;
  stat(file: string): { size: number; mtimeMs: number } | undefined;
}

/** Summary candidates, most current first. */
export const STASH_SUMMARY_CANDIDATES = [
  ["userData", path.join("stash-tracker", "summary.json")],
  ["userData", "stash-tracker-summary.json"],
  ["config", "stash-tracker-summary.json"],
] as const;

/** Snapshot journal candidates, most current first. */
export const STASH_SNAPSHOT_CANDIDATES = [
  ["userData", path.join("stash-tracker", "snapshots.jsonl")],
  ["userData", "stash-snapshots.jsonl"],
  ["config", "stash-snapshots.jsonl"],
] as const;

/** P3 writes this; Home reads sale/purchase totals from it. */
export const TRADE_HISTORY_FILE = "trade-history.json";

interface CacheEntry<T> {
  file: string;
  size: number;
  mtimeMs: number;
  value: T;
}

export interface StashFilesCache {
  summary?: CacheEntry<StashSummaryFile | undefined>;
  points?: CacheEntry<StashSnapshotPoint[]>;
  trades?: CacheEntry<TradeHistoryPoint[]>;
}

export interface StashFilesResult {
  summary?: StashSummaryFile;
  points: StashSnapshotPoint[];
  trades: TradeHistoryPoint[];
  files: { summary?: string; snapshots?: string; trades?: string };
  /** At least one stash tracker file exists on disk. */
  exists: boolean;
  cache: StashFilesCache;
}

function firstExisting(
  fs: StashFilesFs,
  dirs: { userData: string; config: string },
  candidates: ReadonlyArray<readonly [keyof typeof dirs, string]>,
): string | undefined {
  for (const [root, name] of candidates) {
    const file = path.join(dirs[root], name);
    if (fs.exists(file)) return file;
  }
  return undefined;
}

function readCached<T>(
  fs: StashFilesFs,
  file: string | undefined,
  previous: CacheEntry<T> | undefined,
  parse: (text: string) => T,
  empty: T,
): { entry?: CacheEntry<T>; value: T } {
  if (!file) return { value: empty };
  const stat = fs.stat(file);
  if (previous && previous.file === file && stat && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
    return { entry: previous, value: previous.value };
  }
  const text = fs.read(file);
  if (text === undefined) return { value: empty };
  const value = parse(text);
  return {
    entry: { file, size: stat?.size ?? text.length, mtimeMs: stat?.mtimeMs ?? 0, value },
    value,
  };
}

/**
 * Parse whichever of P6's and P3's files exist. Never throws; a missing file
 * is a normal state (those packages may not have run yet).
 */
export function readStashFiles(
  fs: StashFilesFs,
  dirs: { userData: string; config: string },
  cache: StashFilesCache = {},
): StashFilesResult {
  const summaryFile = firstExisting(fs, dirs, STASH_SUMMARY_CANDIDATES);
  const snapshotFile = firstExisting(fs, dirs, STASH_SNAPSHOT_CANDIDATES);
  const tradeFile = path.join(dirs.userData, TRADE_HISTORY_FILE);

  const summary = readCached(fs, summaryFile, cache.summary, parseStashSummaryFile, undefined);
  const points = readCached<StashSnapshotPoint[]>(
    fs,
    snapshotFile,
    cache.points,
    parseStashSnapshotPoints,
    [],
  );
  const trades = readCached<TradeHistoryPoint[]>(
    fs,
    fs.exists(tradeFile) ? tradeFile : undefined,
    cache.trades,
    parseTradeHistoryPoints,
    [],
  );

  return {
    ...(summary.value ? { summary: summary.value } : {}),
    points: points.value,
    trades: trades.value,
    files: {
      ...(summaryFile ? { summary: summaryFile } : {}),
      ...(snapshotFile ? { snapshots: snapshotFile } : {}),
      ...(fs.exists(tradeFile) ? { trades: tradeFile } : {}),
    },
    exists: Boolean(summaryFile ?? snapshotFile),
    cache: {
      ...(summary.entry ? { summary: summary.entry } : {}),
      ...(points.entry ? { points: points.entry } : {}),
      ...(trades.entry ? { trades: trades.entry } : {}),
    },
  };
}
