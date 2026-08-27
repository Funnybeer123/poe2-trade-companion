import {
  LISTING_ALREADY_LISTED_REASON,
  LISTING_APPLY_REASON,
  LISTING_DONE_REASON,
  LISTING_FAILED_OR_TIMED_OUT_REASON,
  LISTING_NO_CANDIDATE_REASON,
  LISTING_OPEN_UI_REASON,
  LISTING_READ_REASON,
  LISTING_SELECT_REASON,
  LISTING_SKIP_NO_QUOTE_REASON,
  LISTING_SKIP_THROTTLED_REASON,
  LISTING_STALE_REPRICE_REASON,
  LISTING_VERIFY_MATCH_REASON,
  LISTING_VERIFY_MISMATCH_REASON,
  listingSkipLowConfidenceReason,
} from "./reasons.js";
import type {
  ListingEvent,
  ListingMachineResult,
  ListingObservation,
  ListingState,
  ListingTransitionRule,
} from "./types.js";
import { LISTING_STATES } from "./types.js";

const MAX_OPEN_ATTEMPTS = 2;

export const DEFAULT_LISTING_MAX_VERIFY_ATTEMPTS = 2;
export const DEFAULT_LISTING_MAX_OPEN_ATTEMPTS = MAX_OPEN_ATTEMPTS;

function emergencyRules(): ListingTransitionRule[] {
  return LISTING_STATES.map((from) => ({
    from,
    when: "emergency-stop",
    event: "emergency-stop",
    to: from,
  }));
}

export const LISTING_TRANSITIONS: ListingTransitionRule[] = [
  ...emergencyRules(),

  { from: "Idle", when: "no-candidate", event: "no-candidate", to: "Done" },
  { from: "Idle", when: "throttled-no-cache", event: "skip-throttled", to: "Done" },
  { from: "Idle", when: "no-quote", event: "skip-no-quote", to: "Done" },
  { from: "Idle", when: "low-confidence", event: "skip-low-confidence", to: "Done" },
  { from: "Idle", when: "ui-open-price-matches-fresh", event: "already-listed", to: "Done" },
  { from: "Idle", when: "ui-open-price-stale", event: "stale-reprice", to: "VerifyPrice" },
  { from: "Idle", when: "ui-open", event: "apply-price", to: "VerifyPrice" },
  { from: "Idle", when: "has-work", event: "select-item", to: "SelectItem" },

  { from: "SelectItem", when: "ui-open", event: "read-current-price", to: "ReadCurrentPrice" },
  { from: "SelectItem", when: "ui-closed", event: "open-listing-ui", to: "OpenListingUi" },

  { from: "OpenListingUi", when: "open-exhausted", event: "failed", to: "FailedOrTimedOut" },
  { from: "OpenListingUi", when: "ui-open-price-matches-fresh", event: "already-listed", to: "Done" },
  { from: "OpenListingUi", when: "ui-open-price-stale", event: "stale-reprice", to: "VerifyPrice" },
  { from: "OpenListingUi", when: "ui-open", event: "apply-price", to: "VerifyPrice" },
  { from: "OpenListingUi", when: "ui-closed", event: "open-listing-ui", to: "OpenListingUi" },

  { from: "ReadCurrentPrice", when: "price-matches-fresh", event: "already-listed", to: "Done" },
  { from: "ReadCurrentPrice", when: "price-stale", event: "stale-reprice", to: "VerifyPrice" },
  { from: "ReadCurrentPrice", when: "always", event: "apply-price", to: "VerifyPrice" },

  { from: "StaleReprice", when: "always", event: "stale-reprice", to: "VerifyPrice" },
  { from: "ApplyPrice", when: "always", event: "apply-price", to: "VerifyPrice" },

  { from: "VerifyPrice", when: "verify-match", event: "verify-match", to: "Done" },
  { from: "VerifyPrice", when: "verify-mismatch-retry", event: "verify-mismatch-retry", to: "VerifyPrice" },
  { from: "VerifyPrice", when: "verify-mismatch-fail", event: "verify-mismatch-fail", to: "FailedOrTimedOut" },

  { from: "FailedOrTimedOut", when: "always", event: "failed", to: "FailedOrTimedOut" },
  { from: "Done", when: "always", event: "done", to: "Done" },
];

export function evaluateListingPredicate(name: string, obs: ListingObservation): boolean {
  switch (name) {
    case "always":
      return true;
    case "emergency-stop":
      return obs.emergencyStop;
    case "no-candidate":
      return !obs.hasCandidate;
    case "throttled-no-cache":
      return obs.marketThrottled && !obs.cachedQuoteAvailable;
    case "no-quote":
      return !obs.quoteAvailable;
    case "low-confidence":
      return !obs.confidenceOk;
    case "has-work":
      return obs.hasCandidate && obs.quoteAvailable && obs.confidenceOk;
    case "ui-open":
      return obs.listingUiOpen;
    case "ui-closed":
      return !obs.listingUiOpen;
    case "price-stale":
      return obs.currentListingStale;
    case "price-matches-fresh":
      return obs.priceMatches && !obs.currentListingStale;
    case "ui-open-price-stale":
      return obs.listingUiOpen && obs.currentListingStale;
    case "ui-open-price-matches-fresh":
      return obs.listingUiOpen && obs.priceMatches && !obs.currentListingStale;
    case "verify-match":
      return obs.priceMatches;
    case "verify-mismatch-retry":
      return !obs.priceMatches && obs.verifyAttempts < obs.maxVerifyAttempts;
    case "verify-mismatch-fail":
      return !obs.priceMatches && obs.verifyAttempts >= obs.maxVerifyAttempts;
    case "open-exhausted":
      return !obs.listingUiOpen && obs.openAttempts >= obs.maxOpenAttempts;
    default:
      return false;
  }
}

export function reasonForListingEvent(event: ListingEvent, lowConfidenceDetail?: string): string {
  switch (event) {
    case "emergency-stop":
      return "emergency-stop";
    case "skip-low-confidence":
      return listingSkipLowConfidenceReason(lowConfidenceDetail);
    case "skip-no-quote":
      return LISTING_SKIP_NO_QUOTE_REASON;
    case "skip-throttled":
      return LISTING_SKIP_THROTTLED_REASON;
    case "no-candidate":
      return LISTING_NO_CANDIDATE_REASON;
    case "select-item":
      return LISTING_SELECT_REASON;
    case "open-listing-ui":
      return LISTING_OPEN_UI_REASON;
    case "read-current-price":
      return LISTING_READ_REASON;
    case "apply-price":
      return LISTING_APPLY_REASON;
    case "stale-reprice":
      return LISTING_STALE_REPRICE_REASON;
    case "verify-match":
      return LISTING_VERIFY_MATCH_REASON;
    case "verify-mismatch-retry":
      return LISTING_VERIFY_MISMATCH_REASON;
    case "verify-mismatch-fail":
      return `${LISTING_FAILED_OR_TIMED_OUT_REASON};${LISTING_VERIFY_MISMATCH_REASON}`;
    case "already-listed":
      return LISTING_ALREADY_LISTED_REASON;
    case "done":
      return LISTING_DONE_REASON;
    case "failed":
      return LISTING_FAILED_OR_TIMED_OUT_REASON;
  }
}

export function stepListingMachine(
  from: ListingState,
  obs: ListingObservation,
  lowConfidenceDetail?: string,
): ListingMachineResult {
  const rule = LISTING_TRANSITIONS.find(
    (entry) => entry.from === from && evaluateListingPredicate(entry.when, obs),
  );
  if (rule === undefined) {
    return {
      next: "FailedOrTimedOut",
      event: "failed",
      reason: LISTING_FAILED_OR_TIMED_OUT_REASON,
      when: "no-matching-edge",
    };
  }
  return {
    next: rule.to,
    event: rule.event,
    reason: reasonForListingEvent(rule.event, lowConfidenceDetail),
    when: rule.when,
  };
}

export function isTerminalListingEvent(event: ListingEvent): boolean {
  return (
    event === "skip-low-confidence" ||
    event === "skip-no-quote" ||
    event === "skip-throttled" ||
    event === "no-candidate" ||
    event === "verify-match" ||
    event === "already-listed" ||
    event === "verify-mismatch-fail" ||
    event === "done" ||
    event === "failed"
  );
}

export function listingHistoryResult(event: ListingEvent, repricing: boolean): string | undefined {
  switch (event) {
    case "skip-low-confidence":
      return "skipped-low-confidence";
    case "skip-no-quote":
      return "skipped-no-quote";
    case "skip-throttled":
      return "skipped-throttled";
    case "no-candidate":
      return "skipped-no-candidate";
    case "already-listed":
      return "already-listed";
    case "verify-match":
      return repricing ? "repriced" : "applied";
    case "verify-mismatch-fail":
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}
