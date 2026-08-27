import {
  createEmptyWorldState,
  FrozenClock,
  type ExpectedTrade,
  type TradeEvent,
  type TradeSession,
  type TradeState,
  type WorldState,
} from "@poe2tc/core";

export const TRADE_CLOCK_MS = 10_000;

export const DEFAULT_EXPECTED_TRADE: ExpectedTrade = {
  itemFingerprint: "astramentis-1",
  itemLabel: "Astramentis",
  currency: "divine",
  amount: 10,
};

export function tradeRequestEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    kind: "whisper-trade-request",
    source: "fixture",
    atMs: TRADE_CLOCK_MS,
    requestedItemFingerprint: DEFAULT_EXPECTED_TRADE.itemFingerprint,
    requestedItemLabel: DEFAULT_EXPECTED_TRADE.itemLabel,
    expected: DEFAULT_EXPECTED_TRADE,
    buyerAlias: "TestBuyer",
    ...overrides,
  };
}

export function createTradeWorld(patch?: (world: WorldState) => void): WorldState {
  const world = createEmptyWorldState({
    clock: new FrozenClock(TRADE_CLOCK_MS),
    runtimeMode: "authorized-qa",
    activeScenarioId: "trade-session",
    selectedState: "TradeSession",
    previousState: "Idle",
    tickId: 1,
  });
  world.process = {
    value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
    confidence: 1,
    observedAtMs: TRADE_CLOCK_MS,
    freshness: "fresh",
  };
  world.inventory = {
    value: {
      occupied: 1,
      capacity: 60,
      full: false,
      cells: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "astramentis-1" }],
    },
    confidence: 0.95,
    observedAtMs: TRADE_CLOCK_MS,
    freshness: "fresh",
  };
  world.flags.tradeRequested = true;
  world.flags.tradeExpected = DEFAULT_EXPECTED_TRADE;
  world.flags.tradeEvent = tradeRequestEvent();
  world.ui = {
    value: { kind: "gameplay" },
    confidence: 0.9,
    observedAtMs: TRADE_CLOCK_MS,
    freshness: "fresh",
  };
  patch?.(world);
  return world;
}

export function withTradeSession(world: WorldState, state: TradeState, extras: Partial<TradeSession> = {}): WorldState {
  world.flags.tradeSession = {
    id: extras.id ?? "trade:trade-session:10000",
    state,
    enteredAtMs: extras.enteredAtMs ?? TRADE_CLOCK_MS,
    expected: extras.expected ?? DEFAULT_EXPECTED_TRADE,
    ...extras,
  };
  return world;
}
