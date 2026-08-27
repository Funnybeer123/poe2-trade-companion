import { readFileSync } from "node:fs";
import { parseReplayManifest } from "./parseReplayManifest.js";
import type { ReplayManifest } from "./types.js";

export function loadReplayManifestFile(filePath: string): ReplayManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`corrupt-manifest: cannot parse ${filePath}`, { cause: error });
  }
  return parseReplayManifest(raw);
}
