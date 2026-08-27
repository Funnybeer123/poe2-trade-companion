import {
  DefaultGameInputController,
  TRADE_MAJOR_STATES,
  TradeController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
  type ReplayManifest,
  type TradeState,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";
import { DEFAULT_EXPECTED_TRADE, TRADE_CLOCK_MS } from "../helpers/tradeWorld.js";

async function replayPack(id: string) {
  const manifest = loadReplayManifestFile(replayManifestPath(id));
  const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
  const result = await runReplay({ manifest, scenario });
  expect(result.result).toBe("end-of-stream");
  expect(result.sinkKind).toBe("noop");
  expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
  expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
  expect(result.inputController.sink.kind).toBe("noop");
  expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
  expect(new TradeController().module).toBe("trade");
  for (const expectation of manifest.expect) {
    const trace = result.traces.find((entry) => entry.tickId === expectation.tickId);
    expect(trace?.selectedState, `${id} tick ${String(expectation.tickId)}`).toBe(expectation.selectedState);
    if (expectation.decisionReasonIncludes !== undefined) {
      expect(trace?.decisionReason, `${id} tick ${String(expectation.tickId)}`).toContain(
        expectation.decisionReasonIncludes,
      );
    }
    expect(trace?.executed).toBe(false);
  }
  return result;
}

function emergencyStopManifest(state: TradeState): ReplayManifest {
  const process = {
    value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
    confidence: 1,
    observedAtMs: TRADE_CLOCK_MS,
    freshness: "fresh" as const,
  };
  return {
    id: `trade-emergency-stop-${state}`,
    scenarioId: "trade-session",
    seed: 42,
    frames: [
      {
        tickId: 1,
        atMs: TRADE_CLOCK_MS,
        derived: {
          process,
          flags: {
            emergencyStopLatched: false,
            tradeRequested: true,
            stashSessionActive: false,
            listingSessionActive: false,
            highValueInterruptScore: 85,
            tradeExpected: DEFAULT_EXPECTED_TRADE,
            tradeSession: {
              id: `trade:stop:${state}`,
              state,
              enteredAtMs: TRADE_CLOCK_MS,
              expected: DEFAULT_EXPECTED_TRADE,
            },
          },
          trade: {
            value: { open: true, ourSlots: [], theirSlots: [] },
            confidence: 0.9,
            observedAtMs: TRADE_CLOCK_MS,
            freshness: "fresh",
          },
        },
      },
      {
        tickId: 2,
        atMs: TRADE_CLOCK_MS + 100,
        derived: {
          process: { ...process, observedAtMs: TRADE_CLOCK_MS + 100 },
          flags: {
            emergencyStopLatched: true,
            tradeRequested: true,
            stashSessionActive: false,
            listingSessionActive: false,
            highValueInterruptScore: 85,
          },
          trade: {
            value: { open: true, ourSlots: [], theirSlots: [] },
            confidence: 0.9,
            observedAtMs: TRADE_CLOCK_MS + 100,
            freshness: "fresh",
          },
        },
      },
    ],
    expect: [
      { tickId: 1, selectedState: "TradeSession", executed: false, sinkKind: "noop" },
      {
        tickId: 2,
        selectedState: "EmergencyStop",
        decisionReasonIncludes: "emergency-stop",
        executed: false,
        sinkKind: "noop",
      },
    ],
  };
}

describe("trade replay", () => {
  it("replays a successful trade session with zero native input", async () => {
    const result = await replayPack("trade-success");
    expect(result.traces.some((trace) => trace.decisionReason.includes("trade-accept"))).toBe(true);
    expect(result.traces.at(-1)?.decisionReason).toContain("trade-cleanup-done");
  });

  it("rejects wrong currency", async () => {
    const result = await replayPack("trade-wrong-currency");
    expect(result.traces[0]?.decisionReason).toBe("trade-reject:wrong-currency");
    expect(result.traces[0]?.intendedActions[0]?.type).toBe("mouse-click");
  });

  it("rejects insufficient currency", async () => {
    await replayPack("trade-insufficient-currency");
  });

  it("rejects a partial stack", async () => {
    await replayPack("trade-partial-stack");
  });

  it("fails a wrong requested item", async () => {
    await replayPack("trade-wrong-item");
  });

  it("fails a missing requested item", async () => {
    await replayPack("trade-missing-item");
  });

  it("times out a wait state", async () => {
    const result = await replayPack("trade-timeout");
    expect(result.traces[0]?.recoveryOf).toBe("trade.timeout");
  });

  it("fails a cancelled trade", async () => {
    await replayPack("trade-cancelled");
  });

  it("cleans up after disconnect then fails", async () => {
    const result = await replayPack("trade-disconnect");
    expect(result.traces[0]?.decisionReason).toBe("trade-disconnect");
    expect(result.traces[1]?.decisionReason).toContain("FailedOrTimedOut");
  });

  it("fails closed on UI desync", async () => {
    await replayPack("trade-ui-desync");
  });

  it("stops during OpenTrade when emergency stop latches", async () => {
    const result = await replayPack("trade-emergency-stop");
    expect(result.traces.some((trace) => trace.selectedState === "EmergencyStop")).toBe(true);
    expect(result.traces.filter((trace) => trace.decisionReason === "emergency-stop").length).toBe(
      TRADE_MAJOR_STATES.length,
    );
  });

  it("emergency-stops from each major trade state through the live replay runner", async () => {
    const scenario = loadAutomationScenarioFile(scenarioFixturePath("trade-session"));
    for (const state of TRADE_MAJOR_STATES) {
      const result = await runReplay({ manifest: emergencyStopManifest(state), scenario });
      expect(result.sinkKind).toBe("noop");
      expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
      expect(result.traces[1]?.selectedState).toBe("EmergencyStop");
      expect(result.traces[1]?.decisionReason).toBe("emergency-stop");
      expect(result.traces[1]?.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    }
  });
});
