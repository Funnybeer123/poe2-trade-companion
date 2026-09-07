/**
 * Bound the artifacts tree.
 *
 * Every CLI and service drops uncompressed 4K captures (24-33 MB each) under
 * artifacts/<tool>/, and the repo lives in a OneDrive-synced folder, so an
 * unbounded tree quietly costs tens of gigabytes. This applies the same
 * retention rule the app services use (core/artifactRetention) to every
 * directory under artifacts/.
 *
 *   npm run clean:artifacts -- [--keep=N] [--dry-run] [--root=REPO_DIR]
 *
 * - Image files (.bmp/.png/.jpg) are pruned per directory to the newest N
 *   (default 100). Journals, ledgers, calibrations -- .jsonl/.json and every
 *   other non-image file -- are never touched.
 * - artifacts/teach is skipped entirely (irreplaceable recordings).
 * - artifacts/scratch is removed (any .json/.jsonl inside it is kept).
 * - Stray root-level captures (artifacts/*.bmp|png|jpg) are removed.
 * - Prints the bytes freed.
 */
import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pruneArtifacts } from "../src/core/artifactRetention.js";

const PROTECTED = /\.jsonl?$/i;
const DEFAULT_KEEP = 100;

const argv = process.argv.slice(2);
const flagValue = (prefix: string): string | undefined =>
  argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);

const keepRaw = flagValue("--keep=");
const keep = keepRaw === undefined ? DEFAULT_KEEP : Number(keepRaw);
if (!Number.isInteger(keep) || keep < 0) {
  console.error(`--keep must be a non-negative integer (got "${keepRaw}")`);
  process.exit(2);
}
const dryRun = argv.includes("--dry-run");
const root = path.resolve(flagValue("--root=") ?? process.cwd());
const artifactsDir = path.join(root, "artifacts");
const teachDir = path.join(artifactsDir, "teach");
const scratchDir = path.join(artifactsDir, "scratch");

let freedBytes = 0;
let removedFiles = 0;
const report: string[] = [];

const rel = (file: string): string => path.relative(root, file).replace(/\\/g, "/") || ".";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Prune one directory's images to the newest `keepCount`. */
function pruneDir(dir: string, keepCount: number): void {
  let bytes = 0;
  const removed = pruneArtifacts(dir, keepCount, {
    dryRun,
    onRemoved: (_file, size) => {
      bytes += size;
    },
  });
  if (removed === 0) return;
  freedBytes += bytes;
  removedFiles += removed;
  report.push(`  ${rel(dir)}: -${removed} image(s), ${formatBytes(bytes)}`);
}

function walk(dir: string): void {
  const here = path.resolve(dir);
  if (here === path.resolve(teachDir) || here === path.resolve(scratchDir)) return;
  // The artifacts root itself is handled by the stray-capture sweep.
  if (here !== path.resolve(artifactsDir)) pruneDir(dir, keep);
  for (const child of subdirs(dir)) walk(child);
}

/** Remove scratch wholesale; .json/.jsonl are never deleted under artifacts/. */
function removeScratch(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  let bytes = 0;
  let count = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      removeScratch(file);
      continue;
    }
    if (!stat.isFile() || PROTECTED.test(name)) continue;
    if (!dryRun) {
      try {
        rmSync(file, { force: true });
      } catch {
        continue;
      }
    }
    bytes += stat.size;
    count += 1;
  }
  if (count > 0) {
    freedBytes += bytes;
    removedFiles += count;
    report.push(`  ${rel(dir)}: removed ${count} file(s), ${formatBytes(bytes)}`);
  }
  if (!dryRun) {
    try {
      rmdirSync(dir); // fails (and is kept) when a protected file remains
    } catch {
      // non-empty: a .json/.jsonl survives inside
    }
  }
}

walk(artifactsDir);
// Stray root-level captures: keep none.
pruneDir(artifactsDir, 0);
removeScratch(scratchDir);

const mode = dryRun ? "dry-run" : "applied";
console.log(`clean:artifacts (${rel(artifactsDir)}, keep=${keep}, ${mode})`);
for (const line of report) console.log(line);
console.log(
  `${dryRun ? "would free" : "freed"} ${formatBytes(freedBytes)} (${freedBytes} bytes) across ${removedFiles} file(s)`,
);
