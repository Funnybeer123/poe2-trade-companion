/**
 * The tiny file surface the trade stores and the notifier need: the settings
 * store's read/write pair plus `stat` (so the shop ledger is only re-parsed
 * when it actually changed) and `remove` (so clearing every webhook secret
 * deletes the file instead of leaving an empty one behind).
 *
 * Injectable so every test runs in memory; `realTradeFs` writes atomically
 * (tmp + rename) exactly like `SettingsStore`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TradeFs {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  stat(file: string): { size: number; mtimeMs: number } | undefined;
  remove(file: string): void;
}

export const realTradeFs: TradeFs = {
  read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
  stat: (file) => {
    try {
      const stats = statSync(file);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  },
  remove: (file) => {
    rmSync(file, { force: true });
  },
};

export function memoryTradeFs(seed: Record<string, string> = {}): TradeFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  let clock = 1;
  const mtimes = new Map<string, number>();
  for (const key of files.keys()) mtimes.set(key, clock);
  return {
    files,
    read: (file) => files.get(file),
    write: (file, text) => {
      files.set(file, text);
      clock += 1;
      mtimes.set(file, clock);
    },
    stat: (file) => {
      const text = files.get(file);
      return text === undefined ? undefined : { size: text.length, mtimeMs: mtimes.get(file) ?? 1 };
    },
    remove: (file) => {
      files.delete(file);
      mtimes.delete(file);
    },
  };
}
