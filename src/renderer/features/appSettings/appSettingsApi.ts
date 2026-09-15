/**
 * Renderer client for the "appSettings" package (the Tools → Settings
 * sections). Returns null in the browser preview so the block renders its
 * "desktop app only" state instead of faking settings.
 */
import type { AppSettingsContract, AppSettingsEvents } from "../../../shared/appSettings.js";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type AppSettingsApi = FeatureApi<AppSettingsContract, AppSettingsEvents>;

export function getAppSettingsApi(): AppSettingsApi | null {
  return createFeatureApi<AppSettingsContract, AppSettingsEvents>();
}
