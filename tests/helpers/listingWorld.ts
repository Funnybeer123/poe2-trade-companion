import {
  createEmptyWorldState,
  FrozenClock,
  type ListingCatalogItem,
  type ListingQuoteSnapshot,
  type WorldState,
} from "@poe2tc/core";

export const LISTING_CLOCK_MS = 10_000;
export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function highConfidenceQuote(overrides: Partial<ListingQuoteSnapshot> = {}): ListingQuoteSnapshot {
  return {
    providerId: "fixture",
    quotedAtMs: LISTING_CLOCK_MS,
    currency: "divine",
    low: 12,
    fair: 15,
    high: 18,
    candidateCount: 8,
    comparableCount: 7,
    confidence: "high",
    ...overrides,
  };
}

export function listingCatalogItem(overrides: Partial<ListingCatalogItem> = {}): ListingCatalogItem {
  const { quote, ...rest } = overrides;
  return {
    fingerprint: "astramentis-1",
    screenPoint: { x: 1400, y: 220 },
    quote: highConfidenceQuote(quote),
    ...rest,
  };
}

export function createListingWorld(patch?: (world: WorldState) => void): WorldState {
  const world = createEmptyWorldState({
    clock: new FrozenClock(LISTING_CLOCK_MS),
    runtimeMode: "authorized-qa",
    activeScenarioId: "list-and-reprice",
    selectedState: "Listing",
    previousState: "Idle",
    tickId: 1,
  });
  world.process = {
    value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
    confidence: 1,
    observedAtMs: LISTING_CLOCK_MS,
    freshness: "fresh",
  };
  world.flags.listingSessionActive = true;
  world.flags.listingCatalog = [listingCatalogItem()];
  world.ui = {
    value: { kind: "listing" },
    confidence: 0.9,
    observedAtMs: LISTING_CLOCK_MS,
    freshness: "fresh",
  };
  patch?.(world);
  return world;
}
