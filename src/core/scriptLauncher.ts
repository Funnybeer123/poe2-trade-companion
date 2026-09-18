import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ScriptLaunch {
  command: string;
  args: string[];
  /** Only the Windows npx fallback needs a shell: `npx.cmd` is a batch file, which
   * Node >= 20.12 refuses to spawn directly (EINVAL). */
  shell: boolean;
  source: "bundle" | "local-tsx" | "npx";
}
export interface ScriptLaunchOptions {
  platform?: NodeJS.Platform;
  node?: string;
  /** Prebuilt CommonJS worker for this script, e.g. dist-electron/map-triage.cjs. */
  bundle?: string;
  /** Source roots the bundle is built from; a newer source file means the bundle is stale. */
  bundleSources?: string[];
}

function newestMtime(target: string): number {
  let newest = 0;
  const visit = (entry: string) => {
    const stat = statSync(entry);
    if (!stat.isDirectory()) { if (/\.(?:ts|ps1|json)$/.test(entry)) newest = Math.max(newest, stat.mtimeMs); return; }
    for (const child of readdirSync(entry)) visit(path.join(entry, child));
  };
  visit(target);
  return newest;
}

/** How a hotkey action starts a `scripts/*.ts` CLI. Preference order: the same prebuilt
 * worker the desktop app runs (when it is at least as new as its sources), a locally
 * installed tsx run by node itself, then `npx` through a shell with quoted arguments. */
export function resolveScriptLaunch(root: string, scriptArgs: readonly string[], options: ScriptLaunchOptions = {}): ScriptLaunch {
  const node = options.node ?? process.execPath;
  if (options.bundle) {
    const bundle = path.resolve(root, options.bundle);
    try {
      const built = statSync(bundle).mtimeMs;
      if ((options.bundleSources ?? []).every(source => newestMtime(path.resolve(root, source)) <= built))
        return { command: node, args: [bundle, ...scriptArgs.slice(1)], shell: false, source: "bundle" };
    } catch { /* A missing bundle or source root falls through to the TypeScript entry. */ }
  }
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsx)) return { command: node, args: [tsx, ...scriptArgs], shell: false, source: "local-tsx" };
  const win32 = (options.platform ?? process.platform) === "win32";
  const quote = (arg: string) => win32 && /[\s&|<>^"]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg;
  return { command: win32 ? "npx.cmd" : "npx", args: ["--yes", "tsx", ...scriptArgs.map(quote)], shell: win32, source: "npx" };
}
