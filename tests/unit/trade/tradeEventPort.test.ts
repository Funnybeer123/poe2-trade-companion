import {
  ClientLogTradeEventPort,
  FixtureTradeEventPort,
  GggTestInterfaceTradeEventPort,
  assertSupportedTradeEventSource,
  createTradeEventPort,
  parseClientLogWhisperLine,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { tradeRequestEvent } from "../../helpers/tradeWorld.js";

describe("trade event port", () => {
  it("replays fixture events without live sources", () => {
    const port = new FixtureTradeEventPort([tradeRequestEvent()]);
    expect(port.source).toBe("fixture");
    expect(port.nextEvent()?.kind).toBe("whisper-trade-request");
    expect(port.nextEvent()).toBeUndefined();
  });

  it("parses opted-in client-log whisper lines only", () => {
    const line =
      '2026/08/27 12:00:00 1 abc [INFO Client 1] @From TestBuyer: Hi, I would like to buy your Astramentis listed for 10 divine in Standard (stash tab "Q"; position: left 1, top 2)';
    const parsed = parseClientLogWhisperLine(line, 12_000);
    expect(parsed?.source).toBe("client-log");
    expect(parsed?.kind).toBe("whisper-trade-request");
    expect(parsed?.expected?.amount).toBe(10);
    expect(parsed?.expected?.currency).toBe("divine");
    expect(parsed?.buyerAlias).toBe("TestBuyer");
    expect(parseClientLogWhisperLine("connected to login server")).toBeUndefined();

    const port = new ClientLogTradeEventPort(["noise", line]);
    expect(port.source).toBe("client-log");
    expect(port.nextEvent()?.requestedItemLabel).toBe("Astramentis");
  });

  it("rejects unsupported live sources such as packet sniffing or trade-site APIs", () => {
    expect(() => assertSupportedTradeEventSource("packet-sniff")).toThrow("unsupported-trade-event-source:packet-sniff");
    expect(() => assertSupportedTradeEventSource("trade2")).toThrow("unsupported-trade-event-source:trade2");
    expect(() =>
      new GggTestInterfaceTradeEventPort([tradeRequestEvent({ source: "fixture" })]),
    ).toThrow("unsupported-trade-event-source:fixture");
    expect(createTradeEventPort("fixture").source).toBe("fixture");
  });
});
