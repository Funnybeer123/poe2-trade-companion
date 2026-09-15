/**
 * Renderer client for the "evaluate" package.
 *
 * Everything Evaluate does needs main (the paced trade2 client, the stat
 * catalogue, the audited Ctrl+C), so there is no browser-preview fallback:
 * `null` here means "desktop app only" and the components render that state.
 */
import type { EvaluateContract, EvaluateEvents } from "../../../shared/evaluate.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type EvaluateApi = FeatureApi<EvaluateContract, EvaluateEvents>;

export function getEvaluateApi(): EvaluateApi | null {
  return createFeatureApi<EvaluateContract, EvaluateEvents>();
}
