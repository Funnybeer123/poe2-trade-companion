import type { BotDecision } from "../input/types.js";
import type { ListingHistoryRecord, ListingSession, WorldState, WorldStateFlags } from "../world-state/types.js";
import { listingHistoryRecord } from "./history.js";
import { listingHistoryResult } from "./listingStateMachine.js";
import { parseListingEvidence } from "./reasons.js";
import type { ListingEvent, ListingState } from "./types.js";

const LISTING_STATES: readonly ListingState[] = [
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

function asListingState(value: string): ListingState {
  return (LISTING_STATES as readonly string[]).includes(value) ? (value as ListingState) : "FailedOrTimedOut";
}

function asListingEvent(value: string): ListingEvent {
  return value as ListingEvent;
}

export function listingEffectsFromDecision(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): Partial<WorldStateFlags> {
  if (decision.module !== "listing" && decision.state !== "Listing") {
    return {};
  }

  if (decision.reason === "emergency-stop" || decision.state === "EmergencyStop") {
    return {};
  }

  const evidence = decision.evidenceIds.map(parseListingEvidence).find((row) => row !== undefined);
  if (evidence === undefined) {
    return {};
  }

  const event = asListingEvent(evidence.event);
  const nextState = asListingState(evidence.nextState);
  const terminal = nextState === "Done" || nextState === "FailedOrTimedOut";
  const historyResult = listingHistoryResult(event, world.flags.listingSession?.repricing === true);
  const pendingListingHistory: ListingHistoryRecord | null =
    historyResult === undefined || evidence.fingerprint.length === 0
      ? null
      : listingHistoryRecord({
          fingerprint: evidence.fingerprint,
          price: evidence.price,
          currency: evidence.currency,
          createdAtMs: nowMs,
          result: historyResult,
        });

  const listingSession: ListingSession | null = terminal
    ? null
    : {
        state: nextState,
        fingerprint: evidence.fingerprint,
        verifyAttempts: Number.isFinite(evidence.verifyAttempts) ? evidence.verifyAttempts : 0,
        recommendedPrice: evidence.price,
        currency: evidence.currency,
        lastEvent: event,
        repricing: event === "stale-reprice" || world.flags.listingSession?.repricing === true,
        openAttempts:
          event === "open-listing-ui"
            ? (world.flags.listingSession?.openAttempts ?? 0) + 1
            : (world.flags.listingSession?.openAttempts ?? 0),
      };

  return {
    listingSessionActive: !terminal,
    listingSession,
    pendingListingHistory,
  };
}
