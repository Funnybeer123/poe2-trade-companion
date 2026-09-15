/**
 * Renderer client for the "market" package (the /market view). Returns null
 * in the browser preview so the view renders its "desktop app only" state.
 */
import type { MarketContract, MarketEvents } from "../../../shared/market.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type MarketApi = FeatureApi<MarketContract, MarketEvents>;

export function getMarketApi(): MarketApi | null {
  return createFeatureApi<MarketContract, MarketEvents>();
}
