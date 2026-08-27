import {
  TRADE_ACCEPT_REASON,
  TRADE_MAJOR_STATES,
  TRADE_MISSING_ITEM_REASON,
  TRADE_REJECT_WRONG_CURRENCY_REASON,
  TRADE_STATES,
  TRADE_TIMEOUT_REASON,
  applyPostDecisionEffects,
  TradeController,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTradeWorld, withTradeSession } from "../../helpers/tradeWorld.js";

describe("TradeController", () => {
  it("starts a session from a fixture trade request", () => {
    const world = createTradeWorld();
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.module).toBe("trade");
    expect(decision.reason).toBe("trade-request-received");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: decision.reason }]);
    const next = applyPostDecisionEffects(world, decision, world.clockMs);
    expect(next.flags.tradeSession?.state).toBe("TradeRequestReceived");
    expect(next.flags.tradeRequested).toBe(true);
    expect(next.flags.pendingTradeSessionWrite?.state).toBe("TradeRequestReceived");
  });

  it("accepts only when the observed offer matches expected currency and amount", () => {
    const world = withTradeSession(createTradeWorld((next) => {
      next.trade = {
        value: {
          open: true,
          ourSlots: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "astramentis-1" }],
          theirSlots: [],
          acceptEnabled: true,
          observedOffer: { currency: "divine", amount: 10 },
          ourItemFingerprint: "astramentis-1",
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    }), "AcceptOrReject");
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.reason).toBe(TRADE_ACCEPT_REASON);
    expect(decision.intendedActions[0]).toMatchObject({ type: "mouse-click", button: "left" });
  });

  it("rejects any offer mismatch by default", () => {
    const world = withTradeSession(createTradeWorld((next) => {
      next.trade = {
        value: {
          open: true,
          ourSlots: [],
          theirSlots: [],
          observedOffer: { currency: "chaos", amount: 10 },
        },
        confidence: 0.95,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    }), "AcceptOrReject");
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.reason).toBe(TRADE_REJECT_WRONG_CURRENCY_REASON);
    expect(decision.intendedActions[0]).toMatchObject({ type: "mouse-click" });
    const next = applyPostDecisionEffects(world, decision, world.clockMs);
    expect(next.flags.tradeSession?.state).toBe("CleanupPartySession");
  });

  it("rejects a partial stack even when currency and amount match", () => {
    const world = withTradeSession(
      createTradeWorld((next) => {
        next.flags.tradeExpected = { ...next.flags.tradeExpected!, stackSize: 5 };
        next.trade = {
          value: {
            open: true,
            ourSlots: [],
            theirSlots: [],
            observedOffer: { currency: "divine", amount: 10, stackSize: 3 },
          },
          confidence: 0.95,
          observedAtMs: 10_000,
          freshness: "fresh",
        };
      }),
      "AcceptOrReject",
      { expected: { itemFingerprint: "astramentis-1", currency: "divine", amount: 10, stackSize: 5 } },
    );
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.reason).toBe("trade-reject:partial-stack");
  });

  it("fails a missing requested item", () => {
    const world = withTradeSession(createTradeWorld((next) => {
      next.inventory = {
        value: { occupied: 0, capacity: 60, full: false, cells: [] },
        confidence: 0.9,
        observedAtMs: 10_000,
        freshness: "fresh",
      };
    }), "ValidateRequestedItem");
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.state).toBe("SafetyHold");
    expect(decision.reason).toContain(TRADE_MISSING_ITEM_REASON);
  });

  it("times out a wait state after the scenario default of 20s", () => {
    const world = withTradeSession(
      createTradeWorld((next) => {
        next.clockMs = 30_000;
        next.trade = {
          value: { open: true, ourSlots: [], theirSlots: [] },
          confidence: 0.9,
          observedAtMs: 30_000,
          freshness: "fresh",
        };
      }),
      "ObserveCounterOffer",
      { enteredAtMs: 10_000 },
    );
    const decision = new TradeController().decide(world, createTestScenario());
    expect(decision.reason).toContain(TRADE_TIMEOUT_REASON);
    expect(decision.recoveryOf).toBe("trade.timeout");
    expect(decision.intendedActions).toEqual([{ type: "noop", reason: decision.reason }]);
  });

  it("returns emergency-stop from every trade machine state", () => {
    for (const state of TRADE_STATES) {
      const world = withTradeSession(
        createTradeWorld((next) => {
          next.flags.emergencyStopLatched = true;
        }),
        state,
      );
      const decision = new TradeController().decide(world, createTestScenario());
      expect(decision.state).toBe("EmergencyStop");
      expect(decision.reason).toBe("emergency-stop");
      expect(decision.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    }
    expect(TRADE_MAJOR_STATES.length).toBeGreaterThan(0);
  });
});
