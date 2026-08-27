import type { TradeMachineEvent, TradeState } from "./types.js";

export const TRADE_IDLE_REASON = "trade-idle";
export const TRADE_REQUEST_RECEIVED_REASON = "trade-request-received";
export const TRADE_VALIDATE_ITEM_REASON = "trade-validate-requested-item";
export const TRADE_INVITE_REASON = "trade-invite-or-join-party";
export const TRADE_PREPARE_ITEM_REASON = "trade-prepare-item";
export const TRADE_NAVIGATE_REASON = "trade-navigate-to-context";
export const TRADE_OPEN_REASON = "trade-open";
export const TRADE_PLACE_ITEM_REASON = "trade-place-item";
export const TRADE_OBSERVE_OFFER_REASON = "trade-observe-counter-offer";
export const TRADE_VALIDATE_OFFER_REASON = "trade-validate-currency-or-items";
export const TRADE_ACCEPT_REASON = "trade-accept";
export const TRADE_REJECT_REASON = "trade-reject";
export const TRADE_CONFIRM_REASON = "trade-confirm-completion";
export const TRADE_CLEANUP_REASON = "trade-cleanup-party";
export const TRADE_CLEANED_REASON = "trade-cleanup-done";
export const TRADE_WAIT_REASON = "trade-wait";
export const TRADE_WRONG_ITEM_REASON = "trade-wrong-item";
export const TRADE_MISSING_ITEM_REASON = "trade-missing-item";
export const TRADE_TIMEOUT_REASON = "trade-timeout";
export const TRADE_CANCELLED_REASON = "trade-cancelled";
export const TRADE_DISCONNECT_REASON = "trade-disconnect";
export const TRADE_UI_DESYNC_REASON = "trade-ui-desync";
export const TRADE_FAILED_OR_TIMED_OUT_REASON = "trade-FailedOrTimedOut";
export const TRADE_REJECT_WRONG_CURRENCY_REASON = "trade-reject:wrong-currency";
export const TRADE_REJECT_INSUFFICIENT_CURRENCY_REASON = "trade-reject:insufficient-currency";
export const TRADE_REJECT_PARTIAL_STACK_REASON = "trade-reject:partial-stack";
export const TRADE_REJECT_AMOUNT_MISMATCH_REASON = "trade-reject:amount-mismatch";
export const TRADE_REJECT_MISSING_OFFER_REASON = "trade-reject:missing-offer";
export const TRADE_ILLEGAL_EDGE_REASON = "trade-illegal-edge";

export function reasonForTradeEvent(event: TradeMachineEvent, detail?: string): string {
  const base = (() => {
    switch (event) {
      case "emergency-stop":
        return "emergency-stop";
      case "idle":
        return TRADE_IDLE_REASON;
      case "request-received":
        return TRADE_REQUEST_RECEIVED_REASON;
      case "validate-item":
        return TRADE_VALIDATE_ITEM_REASON;
      case "invite-party":
        return TRADE_INVITE_REASON;
      case "prepare-item":
        return TRADE_PREPARE_ITEM_REASON;
      case "navigate-to-context":
        return TRADE_NAVIGATE_REASON;
      case "open-trade":
        return TRADE_OPEN_REASON;
      case "place-item":
        return TRADE_PLACE_ITEM_REASON;
      case "observe-offer":
        return TRADE_OBSERVE_OFFER_REASON;
      case "validate-offer":
        return TRADE_VALIDATE_OFFER_REASON;
      case "accept":
        return TRADE_ACCEPT_REASON;
      case "reject":
        return detail === undefined || detail.length === 0 ? TRADE_REJECT_REASON : detail;
      case "confirm-complete":
        return TRADE_CONFIRM_REASON;
      case "cleanup":
        return TRADE_CLEANUP_REASON;
      case "cleaned":
        return TRADE_CLEANED_REASON;
      case "wrong-item":
        return `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_WRONG_ITEM_REASON}`;
      case "missing-item":
        return `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_MISSING_ITEM_REASON}`;
      case "timeout":
        return `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_TIMEOUT_REASON}`;
      case "cancelled":
        return `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_CANCELLED_REASON}`;
      case "disconnect":
        return TRADE_DISCONNECT_REASON;
      case "ui-desync":
        return `${TRADE_FAILED_OR_TIMED_OUT_REASON};${TRADE_UI_DESYNC_REASON}`;
      case "failed":
        return TRADE_FAILED_OR_TIMED_OUT_REASON;
      case "wait":
        return TRADE_WAIT_REASON;
    }
  })();
  if (detail !== undefined && detail.length > 0 && event !== "reject") {
    if (event === "wrong-item" || event === "missing-item" || event === "timeout" || event === "cancelled" || event === "ui-desync") {
      return `${base};${detail}`;
    }
  }
  return base;
}

export function tradeEvidence(input: {
  event: string;
  nextState: TradeState;
  sessionId: string;
  failAfterCleanup: boolean;
  enteredAtMs: number;
  fingerprint?: string;
  currency?: string;
  amount?: number;
}): string {
  return [
    "trade",
    input.event,
    input.nextState,
    input.sessionId,
    input.failAfterCleanup ? "1" : "0",
    String(input.enteredAtMs),
    input.fingerprint ?? "",
    input.currency ?? "",
    input.amount === undefined ? "" : String(input.amount),
  ].join("|");
}

export function parseTradeEvidence(id: string):
  | {
      event: string;
      nextState: string;
      sessionId: string;
      failAfterCleanup: boolean;
      enteredAtMs: number;
      fingerprint?: string;
      currency?: string;
      amount?: number;
    }
  | undefined {
  if (!id.startsWith("trade|")) {
    return undefined;
  }
  const [, event, nextState, sessionId, failText, enteredText, fingerprint, currency, amountText] =
    id.split("|");
  if (event === undefined || nextState === undefined || sessionId === undefined) {
    return undefined;
  }
  const amount = amountText === undefined || amountText.length === 0 ? undefined : Number(amountText);
  return {
    event,
    nextState,
    sessionId,
    failAfterCleanup: failText === "1",
    enteredAtMs: Number(enteredText ?? 0),
    fingerprint: fingerprint === undefined || fingerprint.length === 0 ? undefined : fingerprint,
    currency: currency === undefined || currency.length === 0 ? undefined : currency,
    amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
  };
}
