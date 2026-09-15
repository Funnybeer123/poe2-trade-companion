/**
 * Renderer client for the "inspect" package.
 *
 * In the desktop app the analysis runs in main, where the learned tier
 * store, the stat catalogue and the current area live. In the browser
 * preview there is no bridge, so the same pure function runs locally with
 * no learned data — the card then says its tiers come from hand
 * thresholds instead of pretending to know more.
 */
import { inspectItemText } from "@core/inspect";
import type { InspectContract, InspectEvents, InspectReport } from "../../../shared/inspect.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type InspectApi = FeatureApi<InspectContract, InspectEvents>;

export function getInspectApi(): InspectApi | null {
  return createFeatureApi<InspectContract, InspectEvents>();
}

/** Analyse one item text: through main when it is there, locally otherwise. */
export async function analyzeInspect(text: string): Promise<InspectReport | null> {
  const api = getInspectApi();
  if (api) return api.invoke("inspect:analyze", text);
  return inspectItemText(text) ?? null;
}

/** Open a wiki / poe2db link; main validates the URL again before opening it. */
export async function openInspectLink(url: string): Promise<boolean> {
  const api = getInspectApi();
  if (!api) return false;
  const outcome = await api.invoke("inspect:open-link", url);
  return outcome.ok;
}
