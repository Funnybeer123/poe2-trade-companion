/**
 * Where Client.txt lives. Candidates, in order: the user's override, the
 * Steam install (default library plus every library in
 * `steamapps/libraryfolders.vdf`), the standalone client, then Epic. The
 * first candidate that exists wins; nothing here reads the log itself.
 */
import path from "node:path";
import type { ClientLogSource } from "../../../shared/clientLog.js";

export interface LocatorEnv {
  programFilesX86: string;
  programFiles: string;
}

export interface LocatorFs {
  exists(file: string): boolean;
  /** Small text files only (the vdf); undefined when unreadable. */
  readText(file: string): string | undefined;
}

export interface LocatedClientLog {
  file?: string;
  source: ClientLogSource;
  /** Every path that was tried, for diagnostics. */
  candidates: Array<{ file: string; source: ClientLogSource }>;
}

export const CLIENT_LOG_RELATIVE = path.join("logs", "Client.txt");

export function defaultLocatorEnv(env: NodeJS.ProcessEnv = process.env): LocatorEnv {
  return {
    programFilesX86: env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    programFiles: env.ProgramFiles ?? "C:\\Program Files",
  };
}

/** Library roots from Steam's `libraryfolders.vdf` (`"path"  "D:\\Games\\Steam"` lines). */
export function parseSteamLibraryFolders(text: string): string[] {
  const roots: string[] = [];
  const line = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = line.exec(text)) !== null) {
    const root = match[1].replace(/\\\\/g, "\\").trim();
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

export function clientLogCandidates(
  env: LocatorEnv,
  fs: LocatorFs,
  override?: string,
): Array<{ file: string; source: ClientLogSource }> {
  const out: Array<{ file: string; source: ClientLogSource }> = [];
  const push = (file: string, source: ClientLogSource) => {
    if (!out.some((entry) => entry.file.toLowerCase() === file.toLowerCase())) out.push({ file, source });
  };
  if (override) push(override, "override");

  const steamRoot = path.join(env.programFilesX86, "Steam");
  const steamLibraries = [steamRoot];
  const vdf = fs.readText(path.join(steamRoot, "steamapps", "libraryfolders.vdf"));
  if (vdf) steamLibraries.push(...parseSteamLibraryFolders(vdf));
  for (const library of steamLibraries) {
    push(path.join(library, "steamapps", "common", "Path of Exile 2", CLIENT_LOG_RELATIVE), "steam");
  }

  push(path.join(env.programFilesX86, "Grinding Gear Games", "Path of Exile 2", CLIENT_LOG_RELATIVE), "standalone");
  push(path.join(env.programFiles, "Grinding Gear Games", "Path of Exile 2", CLIENT_LOG_RELATIVE), "standalone");
  push(path.join(env.programFiles, "Epic Games", "Path of Exile 2", CLIENT_LOG_RELATIVE), "epic");
  push(path.join(env.programFiles, "Epic Games", "PathOfExile2", CLIENT_LOG_RELATIVE), "epic");
  return out;
}

export function locateClientLog(env: LocatorEnv, fs: LocatorFs, override?: string): LocatedClientLog {
  const candidates = clientLogCandidates(env, fs, override);
  const found = candidates.find((candidate) => fs.exists(candidate.file));
  return found ? { file: found.file, source: found.source, candidates } : { source: "none", candidates };
}

/** Both places the game config lands: plain Documents and the OneDrive-redirected one. */
export function gameSettingsCandidates(userProfile: string): string[] {
  const tail = path.join("Documents", "My Games", "Path of Exile 2", "poe2_production_Config.ini");
  return [path.join(userProfile, tail), path.join(userProfile, "OneDrive", tail)];
}
