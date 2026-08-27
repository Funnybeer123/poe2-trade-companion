import {
  ListingController,
  LISTING_APPLY_REASON,
  LISTING_SELECT_REASON,
  LISTING_SKIP_LOW_CONFIDENCE_REASON,
  LISTING_SKIP_THROTTLED_REASON,
  LISTING_STALE_REPRICE_REASON,
  LISTING_STATES,
  applyPostDecisionEffects,
  createMemoryMarketCache,
  failedQuote,
  marketCacheKey,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createListingWorld, listingCatalogItem, SIX_HOURS_MS } from "../../helpers/listingWorld.js";

describe("ListingController", () => {
  it("selects a catalog item when the listing UI is closed", () => {
    const world = createListingWorld();
    const decision = new ListingController().decide(world, createTestScenario());
    expect(decision.module).toBe("listing");
    expect(decision.reason).toBe(LISTING_SELECT_REASON);
    expect(decision.intendedActions[0]).toMatchObject({ type: "mouse-click", x: 1400, y: 220, button: "left" });
    const next = applyPostDecisionEffects(world, decision, world.clockMs);
    expect(next.flags.listingSession?.state).toBe("SelectItem");
    expect(next.flags.listingSessionActive).toBe(true);
  });

  it("skips with a reason when quote confidence is below medium", () => {
    const world = createListingWorld((next) => {
      next.flags.listingCatalog = [
        listingCatalogItem({
          quote: {
            providerId: "fixture",
            quotedAtMs: 10_000,
            currency: "divine",
            low: 12,
            fair: 15,
            high: 18,
            candidateCount: 2,
            comparableCount: 1,
            confidence: "low",
            lowConfidenceReason: "small-sample",
          },
        }),
      ];
    });
    const decision = new ListingController().decide(world, createTestScenario());
    expect(decision.reason).toContain(LISTING_SKIP_LOW_CONFIDENCE_REASON);
    expect(decision.reason).toContain("small-sample");
    expect(decision.intendedActions).toEqual([
      { type: "noop", reason: decision.reason },
    ]);
    const next = applyPostDecisionEffects(world, decision, world.clockMs);
    expect(next.flags.listingSessionActive).toBe(false);
    expect(next.flags.pendingListingHistory?.result).toBe("skipped-low-confidence");
  });

  it("reprices a stale open listing through visible UI actions", () => {
    const world = createListingWorld((next) => {
      next.clockMs = 10_000 + SIX_HOURS_MS;
      next.listing = {
        value: { open: true, itemFingerprint: "astramentis-1", priceText: "20 divine", currency: "divine" },
        confidence: 0.9,
        observedAtMs: next.clockMs,
        freshness: "fresh",
      };
      next.flags.listingCatalog = [listingCatalogItem({ listedAtMs: 10_000 })];
    });
    const decision = new ListingController().decide(world, createTestScenario());
    expect(decision.reason).toBe(LISTING_STALE_REPRICE_REASON);
    expect(decision.intendedActions.some((action) => action.type === "key-tap" && action.key === "1")).toBe(true);
    expect(decision.intendedActions.some((action) => action.type === "key-tap" && action.key === ".")).toBe(true);
    expect(decision.intendedActions.map((action) => (action.type === "key-tap" ? action.key : "")).join("")).toContain(
      "14.55",
    );
  });

  it("applies the recommended price when the listing UI is already open", () => {
    const world = createListingWorld((next) => {
      next.listing = {
        value: { open: true, itemFingerprint: "astramentis-1" },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    });
    const decision = new ListingController().decide(world, createTestScenario());
    expect(decision.reason).toBe(LISTING_APPLY_REASON);
    expect(decision.intendedActions[0]?.type).toBe("mouse-click");
    expect(decision.intendedActions.some((action) => action.type === "key-tap")).toBe(true);
  });

  it("uses a cached quote when the live quote is a 429", () => {
    const cache = createMemoryMarketCache();
    const key = marketCacheKey({
      providerId: "fixture",
      league: "Standard",
      realm: "poe2",
      fingerprint: "astramentis-1",
    });
    cache.set(
      key,
      {
        providerId: "fixture",
        quotedAtMs: 9_000,
        currency: "divine",
        low: 12,
        fair: 15,
        high: 18,
        candidateCount: 8,
        comparableCount: 7,
        confidence: "high",
        comparables: [],
      },
      9_000,
      100_000,
    );
    const world = createListingWorld((next) => {
      next.flags.listingCatalog = [
        {
          fingerprint: "astramentis-1",
          screenPoint: { x: 1400, y: 220 },
          quote: failedQuote("fixture", 10_000, "http-429"),
        },
      ];
    });
    const decision = new ListingController({ cache }).decide(world, createTestScenario());
    expect(decision.reason).toBe(LISTING_SELECT_REASON);
    const skipped = new ListingController().decide(world, createTestScenario());
    expect(skipped.reason).toBe(LISTING_SKIP_THROTTLED_REASON);
  });

  it("returns emergency-stop from every listing machine state", () => {
    for (const state of LISTING_STATES) {
      const world = createListingWorld((next) => {
        next.flags.emergencyStopLatched = true;
        next.flags.listingSession = { state, verifyAttempts: 0, fingerprint: "astramentis-1" };
      });
      const decision = new ListingController().decide(world, createTestScenario());
      expect(decision.state).toBe("EmergencyStop");
      expect(decision.reason).toBe("emergency-stop");
      expect(decision.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    }
  });

  it("retries a verify mismatch once then FailedOrTimedOut", () => {
    const controller = new ListingController();
    const scenario = createTestScenario();
    const mismatch = createListingWorld((next) => {
      next.listing = {
        value: { open: true, itemFingerprint: "astramentis-1", priceText: "20 divine", currency: "divine" },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
      next.flags.listingSession = {
        state: "VerifyPrice",
        fingerprint: "astramentis-1",
        verifyAttempts: 1,
        recommendedPrice: 14.55,
        currency: "divine",
      };
    });
    const retry = controller.decide(mismatch, scenario);
    expect(retry.reason).toBe("listing-verify-mismatch");
    expect(retry.recoveryOf).toBe("listing.verify-mismatch");
    expect(retry.intendedActions.some((action) => action.type === "key-tap")).toBe(true);

    mismatch.flags.listingSession = {
      state: "VerifyPrice",
      fingerprint: "astramentis-1",
      verifyAttempts: 2,
      recommendedPrice: 14.55,
      currency: "divine",
    };
    const failed = controller.decide(mismatch, scenario);
    expect(failed.state).toBe("SafetyHold");
    expect(failed.reason).toContain("FailedOrTimedOut");
    expect(failed.intendedActions).toEqual([{ type: "noop", reason: failed.reason }]);
  });
});
