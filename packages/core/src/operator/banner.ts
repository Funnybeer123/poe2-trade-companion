import type { RuntimeCapabilities } from "../capabilities/createCapabilities.js";

export function isQaBannerRequired(
  capabilities: Pick<RuntimeCapabilities, "qaBannerRequired" | "mode">,
): boolean {
  return capabilities.mode === "authorized-qa" && capabilities.qaBannerRequired === true;
}
