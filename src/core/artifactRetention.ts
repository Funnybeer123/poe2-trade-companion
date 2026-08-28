import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_ARTIFACT_KEEP = 300;

/**
 * Bound a capture-artifact directory: keep the newest `keep` image files and
 * delete the rest. Uncompressed 4K captures are ~24MB each, and an unbounded
 * artifact folder inside a cloud-synced tree quietly costs gigabytes.
 * Trace files (.jsonl) are never touched.
 */
export function pruneArtifacts(dir: string, keep = DEFAULT_ARTIFACT_KEEP): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const images = entries
    .filter((name) => /\.(bmp|png|jpe?g)$/i.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, mtime: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { file: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const entry of images.slice(Math.max(0, keep))) {
    try {
      rmSync(entry.file, { force: true });
      removed += 1;
    } catch {
      // A locked or already-deleted file must not abort the sweep.
    }
  }
  return removed;
}
