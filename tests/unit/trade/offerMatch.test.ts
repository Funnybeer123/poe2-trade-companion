import {
  evaluateTradeOffer,
  parseOfferText,
  TRADE_REJECT_INSUFFICIENT_CURRENCY_REASON,
  TRADE_REJECT_PARTIAL_STACK_REASON,
  TRADE_REJECT_WRONG_CURRENCY_REASON,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPECTED_TRADE } from "../../helpers/tradeWorld.js";

describe("trade offer match", () => {
  it("accepts only an exact currency and amount match by default", () => {
    const matched = evaluateTradeOffer(DEFAULT_EXPECTED_TRADE, { currency: "Divine", amount: 10 });
    expect(matched.matches).toBe(true);
    expect(matched.reason).toBeUndefined();
  });

  it("rejects wrong currency, insufficient amount, and partial stacks", () => {
    expect(evaluateTradeOffer(DEFAULT_EXPECTED_TRADE, { currency: "chaos", amount: 10 }).reason).toBe(
      TRADE_REJECT_WRONG_CURRENCY_REASON,
    );
    expect(evaluateTradeOffer(DEFAULT_EXPECTED_TRADE, { currency: "divine", amount: 5 }).reason).toBe(
      TRADE_REJECT_INSUFFICIENT_CURRENCY_REASON,
    );
    expect(
      evaluateTradeOffer({ ...DEFAULT_EXPECTED_TRADE, stackSize: 5 }, { currency: "divine", amount: 10, stackSize: 3 })
        .reason,
    ).toBe(TRADE_REJECT_PARTIAL_STACK_REASON);
  });

  it("allows a scenario tolerance and still rejects anything outside it", () => {
    const within = evaluateTradeOffer(DEFAULT_EXPECTED_TRADE, { currency: "divine", amount: 10.2 }, 0.25);
    expect(within.matches).toBe(true);
    const outside = evaluateTradeOffer(DEFAULT_EXPECTED_TRADE, { currency: "divine", amount: 11 }, 0.25);
    expect(outside.matches).toBe(false);
  });

  it("parses counter-offer text", () => {
    expect(parseOfferText("10 divine")).toEqual({ currency: "divine", amount: 10, stackSize: undefined });
    expect(parseOfferText("3/5 chaos")).toEqual({ currency: "chaos", amount: 3, stackSize: 5 });
    expect(parseOfferText("")).toBeUndefined();
  });
});
