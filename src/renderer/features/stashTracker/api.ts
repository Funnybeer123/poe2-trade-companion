/**
 * Renderer client for the "stash-tracker" package (Tools → Stash tracker and
 * the `stash-prices` overlay legend). Returns null in the browser preview so
 * both surfaces render their "desktop app only" state.
 */
import type { StashTrackerContract, StashTrackerEvents } from "../../../shared/stashTracker.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type StashTrackerApi = FeatureApi<StashTrackerContract, StashTrackerEvents>;

export function getStashTrackerApi(): StashTrackerApi | null {
  return createFeatureApi<StashTrackerContract, StashTrackerEvents>();
}
