/**
 * Typed renderer client for one feature package's channels.
 *
 *   import type { TradeContract, TradeEvents } from "../../../shared/trade";
 *   const api = createFeatureApi<TradeContract, TradeEvents>();
 *   if (!api) { /* browser preview: render the "desktop app only" state *\/ }
 *   const offers = await api.invoke("trade:offers");
 *   const stop = api.on("trade:changed", (next) => …);
 *
 * Returns null in the browser-only preview (no `window.poe2.features`), the
 * same way the other get*Api accessors return undefined there.
 */
import {
  bindFeatureApi,
  type AppFeatureContract,
  type AppFeatureEvents,
  type ContractShape,
  type EventsShape,
  type FeatureApi,
  type NoEvents,
} from "../../shared/features.js";

export type { FeatureApi } from "../../shared/features.js";

export function createFeatureApi<
  C extends ContractShape<C>,
  E extends EventsShape<E> = NoEvents,
>(): FeatureApi<C, E> | null {
  const bridge = globalThis.window?.poe2?.features;
  return bridge ? bindFeatureApi<C, E>(bridge) : null;
}

/** The scaffold's own channels: settings namespaces and the dry-run mirror. */
export function getAppFeatureApi(): FeatureApi<AppFeatureContract, AppFeatureEvents> | null {
  return createFeatureApi<AppFeatureContract, AppFeatureEvents>();
}
