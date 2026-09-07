/**
 * Resolves how to launch a `scripts/*.ts` CLI through tsx.
 *
 * `npx --yes tsx …` re-resolves the package and checks the registry on every
 * call (~1.2 s on the dev machine before the script even starts), which was
 * the dominant latency of a numpad action. When tsx is installed locally we
 * run its CLI entry (`node_modules/tsx/dist/cli.mjs`) with a node executable
 * directly — exactly what the `node_modules/.bin/tsx` shim does. The shim
 * itself is not spawned: on Windows it is a `.cmd` batch file, which Node
 * ≥ 20.12 refuses to spawn without `shell: true` (EINVAL), and a shell would
 * both need the space in this repo's path quoted and leave the script running
 * when the wrapper is killed.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export interface TsxLaunch {
  command: string;
  args: string[];
  /** Only the Windows npx fallback needs a shell: `npx.cmd` is a batch file. */
  shell: boolean;
  source: "local" | "npx";
}

export interface TsxLaunchOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Node executable that runs a local tsx; defaults to `process.execPath`.
   * Pass "node" from Electron's main process, whose execPath is Electron.
   */
  node?: string;
  /** File-existence probe, injectable for tests. */
  exists?: (file: string) => boolean;
}

export function localTsxEntry(
  root: string,
  exists: (file: string) => boolean = existsSync,
): string | undefined {
  const entry = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  return exists(entry) ? entry : undefined;
}

export function resolveTsxLaunch(
  root: string,
  scriptArgs: readonly string[],
  options: TsxLaunchOptions = {},
): TsxLaunch {
  const entry = localTsxEntry(root, options.exists);
  if (entry) {
    return {
      command: options.node ?? process.execPath,
      args: [entry, ...scriptArgs],
      shell: false,
      source: "local",
    };
  }
  const win32 = (options.platform ?? process.platform) === "win32";
  return {
    command: win32 ? "npx.cmd" : "npx",
    args: ["--yes", "tsx", ...scriptArgs],
    shell: win32,
    source: "npx",
  };
}
