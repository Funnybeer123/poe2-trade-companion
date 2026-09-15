/**
 * Renderer client for the "hotkeys" package (Tools → Hotkeys section).
 * Returns null in the browser preview so the section renders its
 * "desktop app only" state.
 */
import type { HotkeysContract, HotkeysEvents } from "../../../shared/hotkeys.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type HotkeysApi = FeatureApi<HotkeysContract, HotkeysEvents>;

export function getHotkeysApi(): HotkeysApi | null {
  return createFeatureApi<HotkeysContract, HotkeysEvents>();
}
