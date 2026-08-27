import type { QaArmingState } from "../capabilities/createCapabilities.js";

export const DEFAULT_ALLOWLISTED_PROCESS_NAMES = [
  "PathOfExile.exe",
  "PathOfExile_x64.exe",
  "PathOfExileSteam.exe",
] as const;

export const DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES = ["Path of Exile 2"] as const;

export interface ProcessIdentity {
  name?: string;
  title?: string;
}

export function isProcessAllowlistedByArming(
  process: ProcessIdentity,
  arming: Pick<QaArmingState, "allowlistedProcessNames" | "allowlistedWindowTitleIncludes">,
): boolean {
  const names = arming.allowlistedProcessNames;
  const titles = arming.allowlistedWindowTitleIncludes;
  const nameConfigured = names.length > 0;
  const titleConfigured = titles.length > 0;
  if (!nameConfigured && !titleConfigured) {
    return false;
  }

  const nameOk =
    !nameConfigured || (process.name !== undefined && names.includes(process.name));
  const titleOk =
    !titleConfigured ||
    (process.title !== undefined && titles.some((fragment) => process.title!.includes(fragment)));
  return nameOk && titleOk;
}
