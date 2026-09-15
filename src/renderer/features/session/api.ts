/**
 * Renderer clients for the "session" package (Home, recap, deaths) and for
 * the one channel Home borrows from the app-settings package.
 *
 * Both return null in the browser preview so the views render their
 * "desktop app only" state instead of throwing.
 */
import type { SessionContract, SessionEvents, HomeChecklistContract } from "../../../shared/session";
import { createFeatureApi, type FeatureApi } from "../../services/featureApi";

export type SessionApi = FeatureApi<SessionContract, SessionEvents>;
export type HomeChecklistApi = FeatureApi<HomeChecklistContract>;

export function getSessionApi(): SessionApi | null {
  return createFeatureApi<SessionContract, SessionEvents>();
}

/**
 * The setup checklist is owned by the app-settings package; Home only
 * renders it, so it is reached over the channel with a structural contract
 * rather than by importing another feature.
 */
export function getHomeChecklistApi(): HomeChecklistApi | null {
  return createFeatureApi<HomeChecklistContract>();
}
