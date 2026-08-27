export const LISTING_VERIFY_MISMATCH_KEY = "listing.verify-mismatch";

export const LISTING_SELECT_REASON = "listing-select-item";
export const LISTING_OPEN_UI_REASON = "listing-open-ui";
export const LISTING_READ_REASON = "listing-read-current-price";
export const LISTING_APPLY_REASON = "listing-apply-price";
export const LISTING_STALE_REPRICE_REASON = "listing-stale-reprice";
export const LISTING_VERIFY_MATCH_REASON = "listing-verify-match";
export const LISTING_VERIFY_MISMATCH_REASON = "listing-verify-mismatch";
export const LISTING_SKIP_LOW_CONFIDENCE_REASON = "listing-skip:low-confidence";
export const LISTING_SKIP_NO_QUOTE_REASON = "listing-skip:no-quote";
export const LISTING_SKIP_THROTTLED_REASON = "listing-skip:market-throttled";
export const LISTING_NO_CANDIDATE_REASON = "listing-skip:no-candidate";
export const LISTING_ALREADY_LISTED_REASON = "listing-already-listed";
export const LISTING_DONE_REASON = "listing-done";
export const LISTING_FAILED_OR_TIMED_OUT_REASON = "listing-FailedOrTimedOut";
export const LISTING_NOT_GUARANTEED_REASON = "listing-estimate-not-guaranteed";

export function listingSkipLowConfidenceReason(detail?: string): string {
  if (detail === undefined || detail.length === 0) {
    return LISTING_SKIP_LOW_CONFIDENCE_REASON;
  }
  return `${LISTING_SKIP_LOW_CONFIDENCE_REASON};${detail}`;
}

export function listingEvidence(
  event: string,
  fingerprint: string,
  price: number | undefined,
  currency: string | undefined,
  nextState: string,
  verifyAttempts: number,
  result: string,
): string {
  return [
    "listing",
    event,
    fingerprint,
    price === undefined ? "" : String(price),
    currency ?? "",
    nextState,
    String(verifyAttempts),
    result,
  ].join("|");
}

export function parseListingEvidence(id: string):
  | {
      event: string;
      fingerprint: string;
      price?: number;
      currency?: string;
      nextState: string;
      verifyAttempts: number;
      result: string;
    }
  | undefined {
  if (!id.startsWith("listing|")) {
    return undefined;
  }
  const [, event, fingerprint, priceText, currency, nextState, attemptText, result] = id.split("|");
  if (event === undefined || fingerprint === undefined || nextState === undefined) {
    return undefined;
  }
  const price = priceText === undefined || priceText.length === 0 ? undefined : Number(priceText);
  return {
    event,
    fingerprint,
    price: price !== undefined && Number.isFinite(price) ? price : undefined,
    currency: currency === undefined || currency.length === 0 ? undefined : currency,
    nextState,
    verifyAttempts: Number(attemptText ?? 0),
    result: result ?? "",
  };
}
