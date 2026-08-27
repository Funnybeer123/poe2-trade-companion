import type { RuntimeMode } from "./types.js";

export function canArmFromUi(mode: RuntimeMode, buildAllowsQa: boolean): boolean {
  if (mode === "assistive-access") return true;
  return buildAllowsQa && mode === "authorized-qa";
}
