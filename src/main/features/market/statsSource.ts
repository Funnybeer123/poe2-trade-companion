/**
 * The stat autocomplete's source: the trade2 `/data/stats` payload.
 *
 * PriceFeedService owns the acquisition (memory → `trade-stats.json` →
 * one unpaced GET, cached a week), so Market never reads that file itself
 * and never spends a search or fetch slot on it. The options are memoised
 * per process because the payload holds thousands of entries.
 */
import { statOptionsFromPayload, type MarketStatOption } from "../../../core/marketStatSearch.js";

/** The slice of PriceFeedService the loader needs (structural, for tests). */
export interface MarketStatsFeed {
  statsPayloadCached(): unknown | undefined;
  fetchStats(): Promise<unknown>;
}

export interface StatsSource {
  load(): Promise<MarketStatOption[]>;
  /** True once a payload has been indexed (drives `statsReady`). */
  ready(): boolean;
  reset(): void;
}

export function createStatsSource(feed: MarketStatsFeed): StatsSource {
  let cached: MarketStatOption[] | undefined;
  let inflight: Promise<MarketStatOption[]> | undefined;

  async function fetchOptions(): Promise<MarketStatOption[]> {
    let payload = feed.statsPayloadCached();
    if (payload === undefined) {
      // fetchStats() owns the network path and the stale-beats-nothing
      // rule; it leaves the payload where statsPayloadCached can see it.
      await feed.fetchStats();
      payload = feed.statsPayloadCached();
    }
    if (payload === undefined) return [];
    const options = statOptionsFromPayload(payload);
    if (options.length > 0) cached = options;
    return options;
  }

  return {
    async load() {
      if (cached) return cached;
      if (!inflight) {
        inflight = fetchOptions().finally(() => {
          inflight = undefined;
        });
      }
      return inflight;
    },
    ready: () => cached !== undefined && cached.length > 0,
    reset() {
      cached = undefined;
      inflight = undefined;
    },
  };
}
