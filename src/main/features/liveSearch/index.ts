/**
 * Feature module "liveSearch": owns the trade2 live-search sockets, publishes
 * the service for later modules (Market starts searches through it) and the
 * list/stop/capacity channels plus the state event for the UI.
 *
 * Settings namespace "live-search": { maxOpen (≤ 20), sound }.
 */
import type { FeatureModule } from "../types.js";
import {
  createLiveSearchService,
  type LiveSearchService,
  type LiveSocketFactory,
} from "../../liveSearchService.js";
import { normalizeLiveSearchSettings, type LiveSearchSettings } from "../../../shared/liveSearch.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    liveSearch: LiveSearchService;
  }
}

export interface LiveSearchModuleOptions {
  /** Test seam: a fake socket factory instead of `ws`. */
  createSocket?: LiveSocketFactory;
}

export function createLiveSearchModule(options: LiveSearchModuleOptions = {}): FeatureModule {
  return {
    id: "liveSearch",
    register(ctx) {
      const settings = ctx.settings.namespace<LiveSearchSettings>(
        "live-search",
        (raw) => normalizeLiveSearchSettings(raw).value,
      );
      const service = createLiveSearchService({
        feed: ctx.core.priceFeed,
        maxOpen: settings.get().maxOpen,
        // Compliance: a live socket must never spend the trade2 budget that
        // price checks and the deals watcher share. A batch is dropped, never
        // queued, while the budget is short or a penalty window is open.
        budget: () => ctx.core.priceFeed.tradeBudget(),
        ...(options.createSocket ? { createSocket: options.createSocket } : {}),
        log: (level, message, detail) => ctx.log({ feature: "liveSearch", level, message, detail }),
      });
      const stopSettings = settings.onChange((next) => service.setMaxOpen(next.maxOpen));
      const stopWatching = service.onChange((handles) => ctx.emit("live-search:state", handles));
      ctx.provide("liveSearch", service);
      ctx.handle("live-search:list", () => service.list());
      ctx.handle("live-search:stop", (id: string) => {
        service.stop(String(id));
        return service.list();
      });
      ctx.handle("live-search:capacity", () => service.capacity());
      return {
        dispose() {
          stopSettings();
          stopWatching();
          service.dispose();
        },
      };
    },
  };
}

export const liveSearchModule: FeatureModule = createLiveSearchModule();
