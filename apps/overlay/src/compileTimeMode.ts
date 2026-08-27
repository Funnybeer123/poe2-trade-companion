import type { RuntimeMode } from "@poe2tc/core/operator";

export function overlayCompileTimeMode(): RuntimeMode {
  const env = import.meta as ImportMeta & { env?: { POE2TC_MODE?: string } };
  return env.env?.POE2TC_MODE === "authorized-qa" ? "authorized-qa" : "public-companion";
}
