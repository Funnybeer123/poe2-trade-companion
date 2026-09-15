/**
 * Renderer client for the "pricing-history" package (Tools → Pricing).
 * Returns null in the browser preview so the tool renders its
 * "desktop app only" state.
 */
import type { PricingContract, PricingEvents } from "../../../shared/pricingHistory.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type PricingApi = FeatureApi<PricingContract, PricingEvents>;

export function getPricingApi(): PricingApi | null {
  return createFeatureApi<PricingContract, PricingEvents>();
}
