/**
 * Gitignored perception fixtures recorded from the live game. Suites that
 * need them guard with `describe.skipIf(missingLiveFixture(...))` so a fresh
 * clone, a worktree or CI skips them visibly instead of failing.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_DIR = path.join(REPO_ROOT, "fixtures", "perception", "templates");
/** The user's real calibration (gitignored; recorded with Tools → Calibrate). */
export const LIVE_CALIBRATION = path.join(TEMPLATE_DIR, "calibration.json");
/** Live 4K deposit capture with a thin 1x3 wand left in the last bag column. */
export const LIVE_WAND_BMP = path.join(REPO_ROOT, "fixtures", "perception", "live", "deposit-1787705758242.bmp");

/**
 * Returns the first missing fixture (so the result is truthy for
 * `describe.skipIf`) after warning once which file the suite is waiting for.
 */
export function missingLiveFixture(suite: string, files: string[]): string | undefined {
  const missing = files.find((file) => !existsSync(file));
  if (missing) {
    console.warn(
      `[${suite}] skipped: missing gitignored fixture ${path.relative(REPO_ROOT, missing).replaceAll("\\", "/")} ` +
        "(copy it from a calibrated checkout or record it in-game)",
    );
  }
  return missing;
}
