/**
 * Market's three private files under Electron's userData
 * (`%APPDATA%/poe2-trade-companion/`). They hold queries, labels and live
 * search ids — never listings, never seller data, never the cookie.
 *
 * Nothing under `artifacts/` is written or pruned here; per-user state
 * belongs in userData (design brief rule 4).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKET_FAVORITES_FILE = "market-favorites.json";
export const MARKET_TABS_FILE = "market-tabs.json";
export const MARKET_LIVE_FILE = "market-live-searches.json";

export interface MarketFs {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
}

export function marketFilePath(userDataDir: string, name: string): string {
  return path.join(userDataDir, name);
}

/**
 * The real filesystem: tmp + rename, so a crash mid-write leaves the old
 * favourites file intact rather than a truncated one.
 */
export const realMarketFs: MarketFs = {
  read(file) {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  },
  write(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, file);
  },
};

/** A memory filesystem for tests (and for a read-only environment). */
export function memoryMarketFs(seed: Record<string, string> = {}): MarketFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    read: (file) => files.get(file),
    write: (file, text) => {
      files.set(file, text);
    },
  };
}

/** Read a JSON file through a sanitizer that never throws. */
export function readJsonFile<T>(fs: MarketFs, file: string, parse: (text: string | undefined) => T): T {
  try {
    return parse(fs.read(file));
  } catch {
    return parse(undefined);
  }
}

/** Write pretty JSON; a failure is reported, never thrown into a UI path. */
export function writeJsonFile(fs: MarketFs, file: string, text: string): string | undefined {
  try {
    fs.write(file, text);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
