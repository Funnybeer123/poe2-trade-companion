/**
 * Renderer client for the "campaignGuide" package (Tools → Campaign guide and
 * the overlay panel). Returns null in the browser preview so both surfaces
 * render their "desktop app only" state instead of throwing.
 */
import type { CampaignContract, CampaignEvents } from "../../../shared/campaignGuide.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type CampaignApi = FeatureApi<CampaignContract, CampaignEvents>;

export function getCampaignApi(): CampaignApi | null {
  return createFeatureApi<CampaignContract, CampaignEvents>();
}
