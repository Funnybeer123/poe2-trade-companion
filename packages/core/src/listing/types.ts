import type { ConfidenceBucket } from "../world-state/types.js";
import type { ListingHistoryRecord, ListingState } from "../world-state/types.js";

export type {
  ListingCatalogItem,
  ListingHistoryRecord,
  ListingQuoteSnapshot,
  ListingSession,
  ListingState,
} from "../world-state/types.js";

export interface PricePolicy {
  undercutPct: number;
  markupPct: number;
  minPrice?: number;
  minConfidence: ConfidenceBucket;
  staleAfterMs: number;
}

export const LISTING_STATES: readonly ListingState[] = [
  "Idle",
  "SelectItem",
  "OpenListingUi",
  "ReadCurrentPrice",
  "ApplyPrice",
  "VerifyPrice",
  "StaleReprice",
  "FailedOrTimedOut",
  "Done",
];

export type ListingEvent =
  | "emergency-stop"
  | "skip-low-confidence"
  | "skip-no-quote"
  | "skip-throttled"
  | "no-candidate"
  | "select-item"
  | "open-listing-ui"
  | "read-current-price"
  | "apply-price"
  | "stale-reprice"
  | "verify-match"
  | "verify-mismatch-retry"
  | "verify-mismatch-fail"
  | "already-listed"
  | "done"
  | "failed";

export interface ListingObservation {
  emergencyStop: boolean;
  hasCandidate: boolean;
  confidenceOk: boolean;
  quoteAvailable: boolean;
  marketThrottled: boolean;
  cachedQuoteAvailable: boolean;
  listingUiOpen: boolean;
  priceMatches: boolean;
  currentListingStale: boolean;
  verifyAttempts: number;
  maxVerifyAttempts: number;
  openAttempts: number;
  maxOpenAttempts: number;
}

export interface ListingTransitionRule {
  from: ListingState;
  when: string;
  event: ListingEvent;
  to: ListingState;
}

export interface ListingMachineResult {
  next: ListingState;
  event: ListingEvent;
  reason: string;
  when: string;
}

export interface ListingHistoryStore {
  append(record: ListingHistoryRecord): void;
  listByFingerprint(fingerprint: string): ListingHistoryRecord[];
  latest(fingerprint: string): ListingHistoryRecord | undefined;
}
