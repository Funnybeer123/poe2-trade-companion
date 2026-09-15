/**
 * Finding the bundled route file.
 *
 * `tsconfig.node.json` has no `resolveJsonModule`, so main reads the dataset
 * with `fs` instead of importing it — and it must work both from the repo
 * (dev) and from `resources/app` (packaged), hence two candidates. No
 * Electron import: `ctx.appPath` already carries `app.getAppPath()`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CAMPAIGN_ROUTE_RELATIVE = path.join("src", "data", "campaign", "route.json");

/** [repoRoot/…, appPath/…] deduped with a Windows-safe case-insensitive compare. */
export function routeCandidates(repoRoot: string, appPath?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of [repoRoot, appPath]) {
    if (!root) continue;
    const file = path.join(root, CAMPAIGN_ROUTE_RELATIVE);
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

const realRead = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, "utf8") : undefined;

/** First readable candidate wins; `path` is the last one tried when none is. */
export function readBundledRoute(
  candidates: readonly string[],
  read: (file: string) => string | undefined = realRead,
): { text?: string; path: string } {
  let last = "";
  for (const file of candidates) {
    last = file;
    let text: string | undefined;
    try {
      text = read(file);
    } catch {
      text = undefined;
    }
    if (typeof text === "string" && text.trim()) return { text, path: file };
  }
  return { path: last };
}
