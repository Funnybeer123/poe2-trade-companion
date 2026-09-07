import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_ARTIFACT_KEEP = 300;

export interface PruneArtifactsOptions {
  /** Count (and report) what would go without deleting anything. */
  dryRun?: boolean;
  /** Called for every pruned — or, in dryRun, would-be-pruned — file with its size. */
  onRemoved?: (file: string, bytes: number) => void;
}

interface ImageEntry {
  file: string;
  mtime: number;
  bytes: number;
}

/**
 * Bound a capture-artifact directory: keep the newest `keep` image files and
 * delete the rest. Uncompressed 4K captures are ~24MB each, and an unbounded
 * artifact folder inside a cloud-synced tree quietly costs gigabytes.
 * Trace files (.jsonl) are never touched.
 */
export function pruneArtifacts(
  dir: string,
  keep = DEFAULT_ARTIFACT_KEEP,
  options: PruneArtifactsOptions = {},
): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const images = entries
    .filter((name) => /\.(bmp|png|jpe?g)$/i.test(name))
    .map((name): ImageEntry | null => {
      const file = path.join(dir, name);
      try {
        const stat = statSync(file);
        return { file, mtime: stat.mtimeMs, bytes: stat.size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ImageEntry => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const entry of images.slice(Math.max(0, keep))) {
    try {
      if (!options.dryRun) rmSync(entry.file, { force: true });
      removed += 1;
      options.onRemoved?.(entry.file, entry.bytes);
    } catch {
      // A locked or already-deleted file must not abort the sweep.
    }
  }
  return removed;
}
