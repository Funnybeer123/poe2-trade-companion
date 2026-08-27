import { readFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeMode } from "@poe2tc/core";
import { readCompileTimeMode } from "@poe2tc/core";

export interface PackagedAppMeta {
  poe2tcMode?: string;
}

export function readBakedCompileTimeMode(
  env: NodeJS.ProcessEnv = process.env,
  packagedMeta?: PackagedAppMeta,
): RuntimeMode {
  return readCompileTimeMode(env, packagedMeta?.poe2tcMode);
}

export function loadPackagedMeta(appPath: string): PackagedAppMeta | undefined {
  try {
    const raw = readFileSync(path.join(appPath, "package.json"), "utf8");
    return JSON.parse(raw) as PackagedAppMeta;
  } catch {
    return undefined;
  }
}
