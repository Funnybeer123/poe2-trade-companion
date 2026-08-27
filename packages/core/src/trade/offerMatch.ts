import type { ExpectedTrade, ObservedTradeOffer } from "../world-state/types.js";
import {
  TRADE_REJECT_AMOUNT_MISMATCH_REASON,
  TRADE_REJECT_INSUFFICIENT_CURRENCY_REASON,
  TRADE_REJECT_MISSING_OFFER_REASON,
  TRADE_REJECT_PARTIAL_STACK_REASON,
  TRADE_REJECT_WRONG_CURRENCY_REASON,
} from "./reasons.js";
import type { TradeOfferEvaluation } from "./types.js";

export function normalizeTradeCurrency(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function currenciesEqual(left: string, right: string): boolean {
  return normalizeTradeCurrency(left) === normalizeTradeCurrency(right);
}

export function parseOfferText(text: string | undefined): ObservedTradeOffer | undefined {
  if (text === undefined) {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+))?\s+(.+)$/.exec(trimmed);
  if (match?.[1] === undefined || match[3] === undefined) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const stackSize = match[2] === undefined ? undefined : Number(match[2]);
  return {
    currency: match[3],
    amount,
    stackSize: stackSize !== undefined && Number.isFinite(stackSize) ? stackSize : undefined,
  };
}

export function resolveObservedOffer(
  observed: ObservedTradeOffer | undefined,
  counterOfferText: string | undefined,
): ObservedTradeOffer | undefined {
  return observed ?? parseOfferText(counterOfferText);
}

/**
 * Accept only when currency matches and amount is within tolerance.
 * Default tolerance is 0: any mismatch rejects.
 */
export function evaluateTradeOffer(
  expected: ExpectedTrade | undefined,
  observed: ObservedTradeOffer | undefined,
  tolerance = 0,
): TradeOfferEvaluation {
  if (expected === undefined) {
    return {
      matches: false,
      currencyMatches: false,
      amountSufficient: false,
      amountWithinTolerance: false,
      stackComplete: false,
      reason: TRADE_REJECT_MISSING_OFFER_REASON,
    };
  }
  if (observed === undefined) {
    return {
      matches: false,
      currencyMatches: false,
      amountSufficient: false,
      amountWithinTolerance: false,
      stackComplete: expected.stackSize === undefined,
      reason: TRADE_REJECT_MISSING_OFFER_REASON,
    };
  }

  const allowedDelta = expected.amountTolerance ?? tolerance;
  const currencyMatches = currenciesEqual(expected.currency, observed.currency);
  const amountSufficient = observed.amount + Number.EPSILON >= expected.amount - allowedDelta;
  const amountWithinTolerance = Math.abs(observed.amount - expected.amount) <= allowedDelta;
  const stackComplete =
    expected.stackSize === undefined || (observed.stackSize ?? observed.amount) >= expected.stackSize;

  if (!currencyMatches) {
    return {
      matches: false,
      currencyMatches,
      amountSufficient,
      amountWithinTolerance,
      stackComplete,
      reason: TRADE_REJECT_WRONG_CURRENCY_REASON,
    };
  }
  if (!amountSufficient) {
    return {
      matches: false,
      currencyMatches,
      amountSufficient,
      amountWithinTolerance,
      stackComplete,
      reason: TRADE_REJECT_INSUFFICIENT_CURRENCY_REASON,
    };
  }
  if (!stackComplete) {
    return {
      matches: false,
      currencyMatches,
      amountSufficient,
      amountWithinTolerance,
      stackComplete,
      reason: TRADE_REJECT_PARTIAL_STACK_REASON,
    };
  }
  if (!amountWithinTolerance) {
    return {
      matches: false,
      currencyMatches,
      amountSufficient,
      amountWithinTolerance,
      stackComplete,
      reason: TRADE_REJECT_AMOUNT_MISMATCH_REASON,
    };
  }
  return {
    matches: true,
    currencyMatches,
    amountSufficient,
    amountWithinTolerance,
    stackComplete,
  };
}
