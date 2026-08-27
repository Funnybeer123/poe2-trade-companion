import type { ExpectedTrade, TradeEvent, TradeEventSource } from "../world-state/types.js";
import { SUPPORTED_TRADE_EVENT_SOURCES, type TradeEventPort } from "./types.js";

export function assertSupportedTradeEventSource(source: string): asserts source is TradeEventSource {
  if (!SUPPORTED_TRADE_EVENT_SOURCES.includes(source as TradeEventSource)) {
    throw new Error(`unsupported-trade-event-source:${source}`);
  }
}

const BUY_WHISPER =
  /(?:^|\s)@From\s+([^:]+):\s+Hi, I would like to buy your (.+?) listed for (\d+(?:\.\d+)?) (.+?)(?:\s+in\s+|\s*$)/i;

export function parseClientLogWhisperLine(line: string, atMs = 0): TradeEvent | undefined {
  const match = BUY_WHISPER.exec(line);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
    return undefined;
  }
  const amount = Number(match[3]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const itemLabel = match[2].trim();
  const currency = match[4].trim();
  const expected: ExpectedTrade = {
    itemFingerprint: itemLabel.toLowerCase().replace(/\s+/g, "-"),
    itemLabel,
    currency,
    amount,
  };
  return {
    kind: "whisper-trade-request",
    source: "client-log",
    atMs,
    requestedItemFingerprint: expected.itemFingerprint,
    requestedItemLabel: itemLabel,
    expected,
    buyerAlias: match[1].trim(),
  };
}

export class FixtureTradeEventPort implements TradeEventPort {
  readonly source = "fixture" as const;
  readonly #events: TradeEvent[];

  constructor(events: TradeEvent[] = []) {
    this.#events = [...events];
  }

  nextEvent(): TradeEvent | undefined {
    return this.#events.shift();
  }
}

/**
 * Live adapter for client-log whisper lines the operator opted to share.
 * Does not tail files or invoke game input on its own.
 */
export class ClientLogTradeEventPort implements TradeEventPort {
  readonly source = "client-log" as const;
  readonly #lines: string[];

  constructor(lines: string[] = []) {
    this.#lines = [...lines];
  }

  nextEvent(): TradeEvent | undefined {
    while (this.#lines.length > 0) {
      const line = this.#lines.shift();
      if (line === undefined) {
        return undefined;
      }
      const parsed = parseClientLogWhisperLine(line);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }
}

/** Reserved for a future GGG-supplied test interface. */
export class GggTestInterfaceTradeEventPort implements TradeEventPort {
  readonly source = "ggg-test-interface" as const;
  readonly #events: TradeEvent[];

  constructor(events: TradeEvent[] = []) {
    for (const event of events) {
      if (event.source !== "ggg-test-interface") {
        throw new Error(`unsupported-trade-event-source:${event.source}`);
      }
    }
    this.#events = [...events];
  }

  nextEvent(): TradeEvent | undefined {
    return this.#events.shift();
  }
}

export function createTradeEventPort(source: TradeEventSource, input: TradeEvent[] | string[] = []): TradeEventPort {
  assertSupportedTradeEventSource(source);
  switch (source) {
    case "fixture":
      return new FixtureTradeEventPort(input as TradeEvent[]);
    case "client-log":
      return new ClientLogTradeEventPort(input as string[]);
    case "ggg-test-interface":
      return new GggTestInterfaceTradeEventPort(input as TradeEvent[]);
  }
}
