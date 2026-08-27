import {
  FrozenClock,
  InMemoryTraceSink,
  MemoryTradeSessionStore,
  NoopInputSink,
  QaTraceWriter,
  TradeController,
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";
import { DEFAULT_EXPECTED_TRADE } from "../helpers/tradeWorld.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

const INVENTORY = {
  value: {
    occupied: 1,
    capacity: 60,
    full: false,
    cells: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "astramentis-1" }],
  },
  confidence: 0.95,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

describe("trade state machine integration", () => {
  it("accepts a matching fixture offer and writes trade_sessions", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const sessions = new MemoryTradeSessionStore();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            inventory: INVENTORY,
            flags: {
              emergencyStopLatched: false,
              tradeRequested: true,
              stashSessionActive: false,
              listingSessionActive: false,
              highValueInterruptScore: 85,
              tradeExpected: DEFAULT_EXPECTED_TRADE,
              tradeEvent: {
                kind: "whisper-trade-request",
                source: "fixture",
                atMs: 10_000,
                requestedItemFingerprint: "astramentis-1",
                expected: DEFAULT_EXPECTED_TRADE,
              },
              tradeSession: {
                id: "trade:it:1",
                state: "AcceptOrReject",
                enteredAtMs: 10_000,
                expected: DEFAULT_EXPECTED_TRADE,
              },
            },
            trade: {
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
            },
            ui: { value: { kind: "trade" }, confidence: 0.95, observedAtMs: 10_000, freshness: "fresh" },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "trade-session",
        enabledModules: ["trade"],
      }),
      traceWriter: new QaTraceWriter(traces),
      tradeSessions: sessions,
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.decision.reason).toBe("trade-accept");
    expect(first.verdict.code === "dry-run" || first.verdict.allowExecute === false).toBe(true);
    expect(first.decision.intendedActions[0]?.type).toBe("mouse-click");
    expect(sessions.get("trade:it:1")?.state).toBe("ConfirmCompletion");
    expect(JSON.parse(sessions.get("trade:it:1")?.payloadJson ?? "{}").reason).toBe("trade-accept");
    expect(loop.world.flags.pendingTradeSessionWrite).toBeNull();
    expect(new TradeController().module).toBe("trade");
  });

  it("rejects a mismatched offer through perception", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const sessions = new MemoryTradeSessionStore();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            inventory: INVENTORY,
            flags: {
              emergencyStopLatched: false,
              tradeRequested: true,
              stashSessionActive: false,
              listingSessionActive: false,
              highValueInterruptScore: 85,
              tradeExpected: DEFAULT_EXPECTED_TRADE,
              tradeSession: {
                id: "trade:it:reject",
                state: "AcceptOrReject",
                enteredAtMs: 10_000,
                expected: DEFAULT_EXPECTED_TRADE,
              },
            },
            trade: {
              value: {
                open: true,
                ourSlots: [],
                theirSlots: [],
                observedOffer: { currency: "chaos", amount: 2 },
              },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "trade-session",
        enabledModules: ["trade"],
      }),
      traceWriter: new QaTraceWriter(traces),
      tradeSessions: sessions,
    });

    const result = await loop.tick();
    expect(result.result).toBe("ticked");
    if (result.result !== "ticked") {
      return;
    }
    expect(result.decision.reason).toBe("trade-reject:wrong-currency");
    expect(sessions.get("trade:it:reject")?.state).toBe("CleanupPartySession");
  });
});
