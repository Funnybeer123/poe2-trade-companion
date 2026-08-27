import {
  LISTING_STATES,
  LISTING_TRANSITIONS,
  evaluateListingPredicate,
  stepListingMachine,
  type ListingObservation,
  type ListingState,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

function obs(overrides: Partial<ListingObservation> = {}): ListingObservation {
  return {
    emergencyStop: false,
    hasCandidate: true,
    confidenceOk: true,
    quoteAvailable: true,
    marketThrottled: false,
    cachedQuoteAvailable: false,
    listingUiOpen: false,
    priceMatches: false,
    currentListingStale: false,
    verifyAttempts: 0,
    maxVerifyAttempts: 2,
    openAttempts: 0,
    maxOpenAttempts: 2,
    ...overrides,
  };
}

describe("listing state machine", () => {
  it("is table-driven and includes emergency-stop from every listing state", () => {
    expect(LISTING_TRANSITIONS.length).toBeGreaterThan(LISTING_STATES.length);
    for (const state of LISTING_STATES) {
      const emergency = LISTING_TRANSITIONS.find(
        (rule) => rule.from === state && rule.when === "emergency-stop",
      );
      expect(emergency?.event).toBe("emergency-stop");
      expect(stepListingMachine(state, obs({ emergencyStop: true })).event).toBe("emergency-stop");
    }
  });

  it("skips Idle work when confidence is below the policy floor", () => {
    const result = stepListingMachine("Idle", obs({ confidenceOk: false }));
    expect(result.next).toBe("Done");
    expect(result.event).toBe("skip-low-confidence");
    expect(result.reason).toContain("listing-skip:low-confidence");
  });

  it("uses cache instead of skipping when the market is throttled", () => {
    const skipped = stepListingMachine(
      "Idle",
      obs({ marketThrottled: true, cachedQuoteAvailable: false, quoteAvailable: false, confidenceOk: false }),
    );
    expect(skipped.event).toBe("skip-throttled");
    const cached = stepListingMachine(
      "Idle",
      obs({ marketThrottled: true, cachedQuoteAvailable: true, quoteAvailable: true }),
    );
    expect(cached.event).toBe("select-item");
  });

  it("detects a stale open listing and reprices", () => {
    const result = stepListingMachine(
      "Idle",
      obs({ listingUiOpen: true, currentListingStale: true, priceMatches: false }),
    );
    expect(result.event).toBe("stale-reprice");
    expect(result.next).toBe("VerifyPrice");
    expect(evaluateListingPredicate("ui-open-price-stale", obs({ listingUiOpen: true, currentListingStale: true }))).toBe(
      true,
    );
  });

  it("retries a verify mismatch once then FailedOrTimedOut", () => {
    const retry = stepListingMachine("VerifyPrice", obs({ priceMatches: false, verifyAttempts: 1 }));
    expect(retry.event).toBe("verify-mismatch-retry");
    expect(retry.next).toBe("VerifyPrice");
    const failed = stepListingMachine("VerifyPrice", obs({ priceMatches: false, verifyAttempts: 2 }));
    expect(failed.event).toBe("verify-mismatch-fail");
    expect(failed.next).toBe("FailedOrTimedOut");
    expect(failed.reason).toContain("FailedOrTimedOut");
  });

  it("has no unbounded edge: unknown combinations fail closed", () => {
    const result = stepListingMachine("ReadCurrentPrice" as ListingState, {
      ...obs(),
      emergencyStop: false,
    });
    expect(result.next === "VerifyPrice" || result.next === "FailedOrTimedOut" || result.next === "Done").toBe(true);
  });
});
