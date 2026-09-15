/**
 * One JSON file per league under
 * `%APPDATA%/poe2-trade-companion/pricing-history/<league-slug>.json`,
 * holding the daily bars merged out of the Market trends cache.
 *
 * App-private (no CLI reads it), written tmp + rename like the settings
 * store, and never thrown from: a read-only disk leaves `lastError` set and
 * the tool keeps serving the 7 bars the feed cache already has.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  emptyStoredHistory,
  historyBarCount,
  mergeHistory,
  parseStoredHistory,
  serializeStoredHistory,
  trimHistoryToBudget,
  type MergeHistoryResult,
  type StoredHistory,
  type StoredHistorySeries,
} from "../../../core/pricingHistory.js";
import type { TrendSeries } from "../../../core/priceTrends.js";

/** The slice of the filesystem the store uses (injected in tests). */
export interface PricingHistoryFs {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  remove(file: string): void;
  list(dir: string): string[];
}

export interface PricingHistoryStoreOptions {
  dir: string;
  fs?: PricingHistoryFs;
  now?: () => Date;
}

export interface PricingHistoryStats {
  since: string;
  keys: number;
  bars: number;
  file: string;
  bytes: number;
}

export interface PricingLeagueFileInfo extends PricingHistoryStats {
  league: string;
}

export const realPricingHistoryFs: PricingHistoryFs = {
  read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
  remove: (file) => {
    rmSync(file, { force: true });
  },
  list: (dir) => {
    try {
      return existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  },
};

/** "Runes of Aldur" → "runes-of-aldur"; an empty name still gets a file. */
export function leagueSlug(league: string): string {
  const slug = league
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "unknown-league";
}

interface Cached {
  history: StoredHistory;
  bytes: number;
}

export class PricingHistoryStore {
  private readonly io: PricingHistoryFs;
  private readonly cache = new Map<string, Cached>();
  /** The last write failure, surfaced in the expert section instead of thrown. */
  lastError: string | undefined;

  constructor(private readonly options: PricingHistoryStoreOptions) {
    this.io = options.fs ?? realPricingHistoryFs;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  file(league: string): string {
    return path.join(this.options.dir, `${leagueSlug(league)}.json`);
  }

  private entry(league: string): Cached {
    const slug = leagueSlug(league);
    const cached = this.cache.get(slug);
    if (cached) return cached;
    let text: string | undefined;
    try {
      text = this.io.read(this.file(league));
    } catch (error) {
      this.lastError = describe(error);
      text = undefined;
    }
    const history = parseStoredHistory(text, league, this.now().toISOString());
    const fresh: Cached = { history, bytes: text?.length ?? 0 };
    this.cache.set(slug, fresh);
    return fresh;
  }

  load(league: string): StoredHistory {
    return this.entry(league).history;
  }

  /**
   * Merge one trends snapshot. Idempotent on the snapshot's `fetchedAt`, so
   * two overlapping overview calls (or a poll landing on a refresh) can
   * never double-count a bar.
   */
  merge(league: string, series: readonly TrendSeries[], fetchedAt: string): MergeHistoryResult {
    const entry = this.entry(league);
    if (entry.history.sourceFetchedAt === fetchedAt) {
      return { history: entry.history, addedBars: 0, changed: false };
    }
    const now = this.now().toISOString();
    const merged = mergeHistory(entry.history, series, fetchedAt, now);
    const trimmed = trimHistoryToBudget(merged.history);
    const text = serializeStoredHistory(trimmed.history);
    entry.history = trimmed.history;
    entry.bytes = text.length;
    if (merged.changed) {
      try {
        this.io.write(this.file(league), text);
        this.lastError = undefined;
      } catch (error) {
        this.lastError = describe(error);
      }
    }
    return { history: trimmed.history, addedBars: merged.addedBars, changed: merged.changed };
  }

  read(league: string, key: string): StoredHistorySeries | undefined {
    return this.load(league).series[key];
  }

  stats(league: string): PricingHistoryStats | undefined {
    const entry = this.entry(league);
    const keys = Object.keys(entry.history.series).length;
    if (keys === 0) return undefined;
    return {
      since: entry.history.since,
      keys,
      bars: historyBarCount(entry.history),
      file: this.file(league),
      bytes: entry.bytes,
    };
  }

  /** Every league file on disk (the "all leagues" picker). */
  leagues(): PricingLeagueFileInfo[] {
    const out: PricingLeagueFileInfo[] = [];
    for (const name of this.io.list(this.options.dir)) {
      if (!name.toLowerCase().endsWith(".json")) continue;
      const file = path.join(this.options.dir, name);
      let text: string | undefined;
      try {
        text = this.io.read(file);
      } catch {
        continue; // An unreadable file is simply not listed.
      }
      if (!text) continue;
      let league = "";
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          const raw = (parsed as { league?: unknown }).league;
          if (typeof raw === "string") league = raw;
        }
      } catch {
        continue; // Torn file: not a league we can offer.
      }
      if (!league) continue;
      const history = parseStoredHistory(text, league, this.now().toISOString());
      const keys = Object.keys(history.series).length;
      out.push({
        league,
        since: history.since,
        keys,
        bars: historyBarCount(history),
        file,
        bytes: text.length,
      });
    }
    return out.sort((a, b) => a.league.localeCompare(b.league));
  }

  /** Removes our own file(s) — never anything else in the directory. */
  clear(league?: string): number {
    const targets = league
      ? [this.file(league)]
      : this.io
          .list(this.options.dir)
          .filter((name) => name.toLowerCase().endsWith(".json"))
          .map((name) => path.join(this.options.dir, name));
    let removed = 0;
    for (const file of targets) {
      try {
        if (this.io.read(file) === undefined) continue;
        this.io.remove(file);
        removed += 1;
      } catch (error) {
        this.lastError = describe(error);
      }
    }
    if (league) this.cache.delete(leagueSlug(league));
    else this.cache.clear();
    return removed;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { emptyStoredHistory };
