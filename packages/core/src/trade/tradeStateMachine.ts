import { reasonForTradeEvent, TRADE_FAILED_OR_TIMED_OUT_REASON, TRADE_ILLEGAL_EDGE_REASON } from "./reasons.js";
import {
  TRADE_STATES,
  TRADE_WAIT_STATES,
  type TradeMachineEvent,
  type TradeMachineOptions,
  type TradeMachineResult,
  type TradeObservation,
  type TradeState,
  type TradeTransitionRule,
} from "./types.js";

const FORWARD: Record<TradeState, readonly TradeState[]> = {
  Idle: ["TradeRequestReceived"],
  TradeRequestReceived: ["ValidateRequestedItem"],
  ValidateRequestedItem: ["InviteOrJoinParty"],
  InviteOrJoinParty: ["PrepareItem"],
  PrepareItem: ["NavigateToTradeContext"],
  NavigateToTradeContext: ["OpenTrade"],
  OpenTrade: ["PlaceItem"],
  PlaceItem: ["ObserveCounterOffer"],
  ObserveCounterOffer: ["ValidateCurrencyOrItems"],
  ValidateCurrencyOrItems: ["AcceptOrReject"],
  AcceptOrReject: ["ConfirmCompletion", "CleanupPartySession"],
  ConfirmCompletion: ["CleanupPartySession"],
  CleanupPartySession: ["Idle"],
  FailedOrTimedOut: [],
};

function uniqueStates(states: TradeState[]): TradeState[] {
  return [...new Set(states)];
}

export const TRADE_ALLOWED_EDGES: Record<TradeState, readonly TradeState[]> = Object.fromEntries(
  TRADE_STATES.map((state) => {
    const next = new Set<TradeState>([state, "FailedOrTimedOut", ...FORWARD[state]]);
    if (state !== "FailedOrTimedOut") {
      next.add("CleanupPartySession");
    }
    return [state, uniqueStates([...next])];
  }),
) as unknown as Record<TradeState, readonly TradeState[]>;

export function isAllowedTradeEdge(from: TradeState, to: TradeState): boolean {
  return TRADE_ALLOWED_EDGES[from].includes(to);
}

export function assertAllowedTradeEdge(from: TradeState, to: TradeState): void {
  if (!isAllowedTradeEdge(from, to)) {
    throw new Error(`illegal-trade-edge:${from}->${to}`);
  }
}

function emergencyRules(): TradeTransitionRule[] {
  return TRADE_STATES.map((from) => ({
    from,
    when: "emergency-stop",
    event: "emergency-stop",
    to: from,
  }));
}

function disconnectRules(): TradeTransitionRule[] {
  return TRADE_STATES.filter((state) => state !== "FailedOrTimedOut").map((from) => ({
    from,
    when: "disconnected",
    event: "disconnect",
    to: from === "CleanupPartySession" ? "FailedOrTimedOut" : "CleanupPartySession",
  }));
}

function cancelledRules(): TradeTransitionRule[] {
  return TRADE_STATES.filter((state) => state !== "FailedOrTimedOut" && state !== "CleanupPartySession").map(
    (from) => ({
      from,
      when: "cancelled",
      event: "cancelled",
      to: "FailedOrTimedOut",
    }),
  );
}

function timeoutRules(): TradeTransitionRule[] {
  return TRADE_WAIT_STATES.map((from) => ({
    from,
    when: "timed-out",
    event: "timeout",
    to: "FailedOrTimedOut",
  }));
}

const DESYNC_STATES: readonly TradeState[] = [
  "OpenTrade",
  "PlaceItem",
  "ObserveCounterOffer",
  "ValidateCurrencyOrItems",
  "AcceptOrReject",
  "ConfirmCompletion",
];

function desyncRules(): TradeTransitionRule[] {
  return DESYNC_STATES.map((from) => ({
    from,
    when: "ui-desync",
    event: "ui-desync",
    to: "FailedOrTimedOut",
  }));
}

export const TRADE_TRANSITIONS: TradeTransitionRule[] = [
  ...emergencyRules(),
  ...disconnectRules(),
  ...cancelledRules(),
  ...desyncRules(),
  ...timeoutRules(),

  { from: "Idle", when: "has-request", event: "request-received", to: "TradeRequestReceived" },
  { from: "Idle", when: "always", event: "idle", to: "Idle" },

  { from: "TradeRequestReceived", when: "has-request", event: "validate-item", to: "ValidateRequestedItem" },
  { from: "TradeRequestReceived", when: "always", event: "wait", to: "TradeRequestReceived" },

  { from: "ValidateRequestedItem", when: "missing-item", event: "missing-item", to: "FailedOrTimedOut" },
  { from: "ValidateRequestedItem", when: "wrong-item", event: "wrong-item", to: "FailedOrTimedOut" },
  { from: "ValidateRequestedItem", when: "item-valid", event: "invite-party", to: "InviteOrJoinParty" },

  { from: "InviteOrJoinParty", when: "party-joined", event: "prepare-item", to: "PrepareItem" },
  { from: "InviteOrJoinParty", when: "always", event: "invite-party", to: "InviteOrJoinParty" },

  { from: "PrepareItem", when: "item-prepared", event: "navigate-to-context", to: "NavigateToTradeContext" },
  { from: "PrepareItem", when: "missing-item", event: "missing-item", to: "FailedOrTimedOut" },

  { from: "NavigateToTradeContext", when: "in-trade-context", event: "open-trade", to: "OpenTrade" },
  { from: "NavigateToTradeContext", when: "always", event: "navigate-to-context", to: "NavigateToTradeContext" },

  { from: "OpenTrade", when: "window-open", event: "place-item", to: "PlaceItem" },
  { from: "OpenTrade", when: "always", event: "open-trade", to: "OpenTrade" },

  { from: "PlaceItem", when: "item-placed-and-matches", event: "observe-offer", to: "ObserveCounterOffer" },
  { from: "PlaceItem", when: "wrong-placed-item", event: "wrong-item", to: "FailedOrTimedOut" },
  { from: "PlaceItem", when: "always", event: "place-item", to: "PlaceItem" },

  { from: "ObserveCounterOffer", when: "offer-observed", event: "validate-offer", to: "ValidateCurrencyOrItems" },
  { from: "ObserveCounterOffer", when: "always", event: "wait", to: "ObserveCounterOffer" },

  { from: "ValidateCurrencyOrItems", when: "always", event: "validate-offer", to: "AcceptOrReject" },

  { from: "AcceptOrReject", when: "offer-matches", event: "accept", to: "ConfirmCompletion" },
  { from: "AcceptOrReject", when: "always", event: "reject", to: "CleanupPartySession" },

  { from: "ConfirmCompletion", when: "completed", event: "cleanup", to: "CleanupPartySession" },
  { from: "ConfirmCompletion", when: "always", event: "wait", to: "ConfirmCompletion" },

  { from: "CleanupPartySession", when: "fail-after-cleanup", event: "failed", to: "FailedOrTimedOut" },
  { from: "CleanupPartySession", when: "cleanup-done", event: "cleaned", to: "Idle" },
  { from: "CleanupPartySession", when: "always", event: "cleanup", to: "CleanupPartySession" },

  { from: "FailedOrTimedOut", when: "always", event: "failed", to: "FailedOrTimedOut" },
];

export function evaluateTradePredicate(name: string, obs: TradeObservation): boolean {
  switch (name) {
    case "always":
      return true;
    case "emergency-stop":
      return obs.emergencyStop;
    case "disconnected":
      return obs.disconnected;
    case "cancelled":
      return obs.cancelled;
    case "timed-out":
      return obs.timedOut;
    case "ui-desync":
      return obs.uiDesync;
    case "has-request":
      return obs.hasRequest;
    case "missing-item":
      return !obs.requestedItemPresent;
    case "wrong-item":
      return obs.requestedItemPresent && !obs.requestedItemValid;
    case "item-valid":
      return obs.requestedItemValid && obs.requestedItemPresent;
    case "party-joined":
      return obs.partyJoined;
    case "item-prepared":
      return obs.itemPrepared;
    case "in-trade-context":
      return obs.inTradeContext;
    case "window-open":
      return obs.tradeWindowOpen;
    case "item-placed-and-matches":
      return obs.itemPlaced && obs.placedItemMatches;
    case "wrong-placed-item":
      return obs.itemPlaced && !obs.placedItemMatches;
    case "offer-observed":
      return obs.counterOfferObserved;
    case "offer-matches":
      return obs.offerMatches;
    case "completed":
      return obs.completed;
    case "cleanup-done":
      return obs.cleanupDone && !obs.failAfterCleanup;
    case "fail-after-cleanup":
      return obs.cleanupDone && obs.failAfterCleanup;
    default:
      return false;
  }
}

function illegalResult(from: TradeState, when: string): TradeMachineResult {
  return {
    next: "FailedOrTimedOut",
    event: "failed",
    reason: `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_ILLEGAL_EDGE_REASON};${from};${when}`,
    when,
  };
}

export function stepTradeMachine(
  from: TradeState,
  obs: TradeObservation,
  options: TradeMachineOptions = {},
  rejectDetail?: string,
): TradeMachineResult {
  const rule = TRADE_TRANSITIONS.find(
    (entry) => entry.from === from && evaluateTradePredicate(entry.when, obs),
  );
  if (rule === undefined) {
    if (options.strict === true) {
      throw new Error(`illegal-trade-edge:${from}->(none)`);
    }
    return illegalResult(from, "no-matching-edge");
  }
  if (!isAllowedTradeEdge(from, rule.to)) {
    if (options.strict === true) {
      throw new Error(`illegal-trade-edge:${from}->${rule.to}`);
    }
    return illegalResult(from, "disallowed-edge");
  }
  return {
    next: rule.to,
    event: rule.event,
    reason: reasonForTradeEvent(rule.event, rejectDetail),
    when: rule.when,
  };
}

export function isTerminalTradeState(state: TradeState): boolean {
  return state === "FailedOrTimedOut" || state === "Idle";
}

export function isTerminalTradeEvent(event: TradeMachineEvent): boolean {
  return (
    event === "cleaned" ||
    event === "failed" ||
    event === "timeout" ||
    event === "cancelled" ||
    event === "wrong-item" ||
    event === "missing-item" ||
    event === "ui-desync"
  );
}

export function tradeSessionResult(event: TradeMachineEvent): string {
  switch (event) {
    case "accept":
    case "cleaned":
      return "completed";
    case "reject":
      return "rejected";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "disconnect":
    case "failed":
      return "failed";
    case "wrong-item":
      return "wrong-item";
    case "missing-item":
      return "missing-item";
    case "ui-desync":
      return "ui-desync";
    default:
      return event;
  }
}
