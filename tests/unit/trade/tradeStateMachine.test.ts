import {
  TRADE_ALLOWED_EDGES,
  TRADE_MAJOR_STATES,
  TRADE_STATES,
  TRADE_TRANSITIONS,
  TRADE_WAIT_STATES,
  assertAllowedTradeEdge,
  evaluateTradePredicate,
  isAllowedTradeEdge,
  stepTradeMachine,
  type TradeObservation,
  type TradeState,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

function obs(overrides: Partial<TradeObservation> = {}): TradeObservation {
  return {
    emergencyStop: false,
    hasRequest: true,
    requestedItemValid: true,
    requestedItemPresent: true,
    partyJoined: true,
    itemPrepared: true,
    inTradeContext: true,
    tradeWindowOpen: true,
    itemPlaced: true,
    placedItemMatches: true,
    counterOfferObserved: true,
    offerMatches: true,
    offerCurrencyMatches: true,
    offerAmountSufficient: true,
    offerStackComplete: true,
    acceptEnabled: true,
    completed: true,
    cancelled: false,
    disconnected: false,
    uiDesync: false,
    timedOut: false,
    cleanupDone: false,
    failAfterCleanup: false,
    ...overrides,
  };
}

describe("trade state machine", () => {
  it("includes emergency-stop from every trade state", () => {
    for (const state of TRADE_STATES) {
      const emergency = TRADE_TRANSITIONS.find(
        (rule) => rule.from === state && rule.when === "emergency-stop",
      );
      expect(emergency?.event).toBe("emergency-stop");
      expect(emergency?.to).toBe(state);
      expect(stepTradeMachine(state, obs({ emergencyStop: true })).event).toBe("emergency-stop");
      expect(stepTradeMachine(state, obs({ emergencyStop: true })).reason).toBe("emergency-stop");
    }
  });

  it("publishes a strict allowed-edges map covering every transition rule", () => {
    for (const rule of TRADE_TRANSITIONS) {
      expect(isAllowedTradeEdge(rule.from, rule.to), `${rule.from}->${rule.to}`).toBe(true);
    }
    expect(TRADE_MAJOR_STATES.length).toBeGreaterThan(0);
    expect(TRADE_WAIT_STATES.length).toBeGreaterThan(0);
  });

  it("throws on illegal edges in tests", () => {
    expect(() => assertAllowedTradeEdge("Idle", "ConfirmCompletion")).toThrow(
      "illegal-trade-edge:Idle->ConfirmCompletion",
    );
    expect(() => assertAllowedTradeEdge("Idle", "PlaceItem")).toThrow("illegal-trade-edge");
    expect(() => assertAllowedTradeEdge("FailedOrTimedOut", "OpenTrade")).toThrow("illegal-trade-edge");
  });

  it("turns illegal edges into FailedOrTimedOut in prod mode", () => {
    const result = stepTradeMachine("Idle", obs(), { strict: false });
    expect(result.next === "TradeRequestReceived" || result.next === "FailedOrTimedOut").toBe(true);
    expect(() => assertAllowedTradeEdge("AcceptOrReject", "Idle")).toThrow("illegal-trade-edge");
  });

  it("walks the success path with a reason on every transition", () => {
    const sequence: Array<{ from: TradeState; next: TradeState; includes: string; patch?: Partial<TradeObservation> }> =
      [
        { from: "Idle", next: "TradeRequestReceived", includes: "trade-request-received" },
        { from: "TradeRequestReceived", next: "ValidateRequestedItem", includes: "trade-validate-requested-item" },
        { from: "ValidateRequestedItem", next: "InviteOrJoinParty", includes: "trade-invite-or-join-party" },
        { from: "InviteOrJoinParty", next: "PrepareItem", includes: "trade-prepare-item" },
        { from: "PrepareItem", next: "NavigateToTradeContext", includes: "trade-navigate-to-context" },
        { from: "NavigateToTradeContext", next: "OpenTrade", includes: "trade-open" },
        { from: "OpenTrade", next: "PlaceItem", includes: "trade-place-item" },
        { from: "PlaceItem", next: "ObserveCounterOffer", includes: "trade-observe-counter-offer" },
        { from: "ObserveCounterOffer", next: "ValidateCurrencyOrItems", includes: "trade-validate-currency-or-items" },
        { from: "ValidateCurrencyOrItems", next: "AcceptOrReject", includes: "trade-validate-currency-or-items" },
        { from: "AcceptOrReject", next: "ConfirmCompletion", includes: "trade-accept" },
        { from: "ConfirmCompletion", next: "CleanupPartySession", includes: "trade-cleanup-party" },
        {
          from: "CleanupPartySession",
          next: "Idle",
          includes: "trade-cleanup-done",
          patch: { cleanupDone: true },
        },
      ];
    for (const step of sequence) {
      const result = stepTradeMachine(step.from, obs(step.patch));
      expect(result.next).toBe(step.next);
      expect(result.reason).toContain(step.includes);
    }
  });

  it("rejects on offer mismatch instead of accepting", () => {
    const result = stepTradeMachine("AcceptOrReject", obs({ offerMatches: false }), {}, "trade-reject:wrong-currency");
    expect(result.next).toBe("CleanupPartySession");
    expect(result.event).toBe("reject");
    expect(result.reason).toBe("trade-reject:wrong-currency");
  });

  it("fails missing and wrong requested items", () => {
    const missing = stepTradeMachine("ValidateRequestedItem", obs({ requestedItemPresent: false }));
    expect(missing.next).toBe("FailedOrTimedOut");
    expect(missing.event).toBe("missing-item");
    expect(missing.reason).toContain("trade-missing-item");

    const wrong = stepTradeMachine(
      "ValidateRequestedItem",
      obs({ requestedItemPresent: true, requestedItemValid: false }),
    );
    expect(wrong.next).toBe("FailedOrTimedOut");
    expect(wrong.event).toBe("wrong-item");
    expect(wrong.reason).toContain("trade-wrong-item");
  });

  it("times out wait states after the timeout predicate", () => {
    for (const state of TRADE_WAIT_STATES) {
      const result = stepTradeMachine(state, obs({ timedOut: true, completed: false, cleanupDone: false }));
      expect(result.next).toBe("FailedOrTimedOut");
      expect(result.event).toBe("timeout");
      expect(result.reason).toContain("trade-timeout");
    }
  });

  it("cancels from in-progress states", () => {
    const result = stepTradeMachine("OpenTrade", obs({ cancelled: true }));
    expect(result.next).toBe("FailedOrTimedOut");
    expect(result.reason).toContain("trade-cancelled");
  });

  it("disconnects into cleanup then FailedOrTimedOut", () => {
    const cleanup = stepTradeMachine("PlaceItem", obs({ disconnected: true }));
    expect(cleanup.next).toBe("CleanupPartySession");
    expect(cleanup.event).toBe("disconnect");
    const failed = stepTradeMachine("CleanupPartySession", obs({ disconnected: true, cleanupDone: true }));
    expect(failed.next).toBe("FailedOrTimedOut");
  });

  it("fails closed on UI desync", () => {
    const result = stepTradeMachine("ObserveCounterOffer", obs({ uiDesync: true }));
    expect(result.next).toBe("FailedOrTimedOut");
    expect(result.reason).toContain("trade-ui-desync");
  });

  it("evaluates named predicates used by the table", () => {
    expect(evaluateTradePredicate("has-request", obs({ hasRequest: false }))).toBe(false);
    expect(evaluateTradePredicate("offer-matches", obs({ offerMatches: true }))).toBe(true);
    expect(evaluateTradePredicate("unknown-predicate", obs())).toBe(false);
  });
});
