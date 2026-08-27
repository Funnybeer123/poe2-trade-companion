import type {
  ExpectedTrade,
  TradeEvent,
  TradeEventSource,
  TradeSessionRecord,
  TradeState,
} from "../world-state/types.js";

export type {
  ExpectedTrade,
  ObservedTradeOffer,
  TradeEvent,
  TradeEventKind,
  TradeEventSource,
  TradePartyState,
  TradeSession,
  TradeSessionRecord,
  TradeState,
} from "../world-state/types.js";

export const TRADE_STATES: readonly TradeState[] = [
  "Idle",
  "TradeRequestReceived",
  "ValidateRequestedItem",
  "InviteOrJoinParty",
  "PrepareItem",
  "NavigateToTradeContext",
  "OpenTrade",
  "PlaceItem",
  "ObserveCounterOffer",
  "ValidateCurrencyOrItems",
  "AcceptOrReject",
  "ConfirmCompletion",
  "CleanupPartySession",
  "FailedOrTimedOut",
];

export const TRADE_WAIT_STATES: readonly TradeState[] = [
  "TradeRequestReceived",
  "InviteOrJoinParty",
  "NavigateToTradeContext",
  "OpenTrade",
  "PlaceItem",
  "ObserveCounterOffer",
  "ConfirmCompletion",
  "CleanupPartySession",
];

export const TRADE_MAJOR_STATES: readonly TradeState[] = [
  "TradeRequestReceived",
  "InviteOrJoinParty",
  "PrepareItem",
  "NavigateToTradeContext",
  "OpenTrade",
  "PlaceItem",
  "ObserveCounterOffer",
  "ValidateCurrencyOrItems",
  "AcceptOrReject",
  "ConfirmCompletion",
  "CleanupPartySession",
];

export const DEFAULT_TRADE_WAIT_TIMEOUT_MS = 20_000;

export const SUPPORTED_TRADE_EVENT_SOURCES: readonly TradeEventSource[] = [
  "fixture",
  "client-log",
  "ggg-test-interface",
];

export type TradeMachineEvent =
  | "emergency-stop"
  | "idle"
  | "request-received"
  | "validate-item"
  | "invite-party"
  | "prepare-item"
  | "navigate-to-context"
  | "open-trade"
  | "place-item"
  | "observe-offer"
  | "validate-offer"
  | "accept"
  | "reject"
  | "confirm-complete"
  | "cleanup"
  | "cleaned"
  | "wrong-item"
  | "missing-item"
  | "timeout"
  | "cancelled"
  | "disconnect"
  | "ui-desync"
  | "failed"
  | "wait";

export interface TradeObservation {
  emergencyStop: boolean;
  hasRequest: boolean;
  requestedItemValid: boolean;
  requestedItemPresent: boolean;
  partyJoined: boolean;
  itemPrepared: boolean;
  inTradeContext: boolean;
  tradeWindowOpen: boolean;
  itemPlaced: boolean;
  placedItemMatches: boolean;
  counterOfferObserved: boolean;
  offerMatches: boolean;
  offerCurrencyMatches: boolean;
  offerAmountSufficient: boolean;
  offerStackComplete: boolean;
  acceptEnabled: boolean;
  completed: boolean;
  cancelled: boolean;
  disconnected: boolean;
  uiDesync: boolean;
  timedOut: boolean;
  cleanupDone: boolean;
  failAfterCleanup: boolean;
}

export interface TradeTransitionRule {
  from: TradeState;
  when: string;
  event: TradeMachineEvent;
  to: TradeState;
}

export interface TradeMachineResult {
  next: TradeState;
  event: TradeMachineEvent;
  reason: string;
  when: string;
}

export interface TradeOfferEvaluation {
  matches: boolean;
  currencyMatches: boolean;
  amountSufficient: boolean;
  amountWithinTolerance: boolean;
  stackComplete: boolean;
  reason?: string;
}

export interface TradeEventPort {
  readonly source: TradeEventSource;
  nextEvent(): TradeEvent | undefined;
}

export interface TradeSessionStore {
  upsert(record: TradeSessionRecord): void;
  get(id: string): TradeSessionRecord | undefined;
  listByScenario(scenarioId: string): TradeSessionRecord[];
}

export interface TradeMachineOptions {
  strict?: boolean;
}

export type { ExpectedTrade as TradeExpected };
