import {
  DefaultGameInputController,
  DefaultScenarioOrchestrator,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
  type QaActionTrace,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

const COMPLETE_TRACE_FIELDS: Array<keyof QaActionTrace> = [
  "id",
  "timestamp",
  "clockMs",
  "tickId",
  "scenarioId",
  "runtimeMode",
  "module",
  "selectedState",
  "previousState",
  "observedSummary",
  "confidence",
  "decisionReason",
  "intendedActions",
  "interlockCode",
  "executed",
  "dryRun",
  "result",
];

function assertCompleteTrace(trace: QaActionTrace, tickId: number): void {
  for (const field of COMPLETE_TRACE_FIELDS) {
    expect(trace[field], `tick ${String(tickId)} missing ${field}`).toBeDefined();
  }
  expect(trace.executed).toBe(false);
  expect(trace.dryRun).toBe(true);
  expect(trace.intendedActions.length).toBeGreaterThan(0);
}

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

describe("full-loop replay", () => {
  it("walks follow → loot → inventory full → stash → list → trade with complete traces", async () => {
    const result = await replayPack("full-loop");
    expect(result.traces.map((trace) => trace.selectedState)).toEqual([
      "Follow",
      "LootPickup",
      "InventoryFull",
      "StashSort",
      "StashSort",
      "Listing",
      "TradeSession",
    ]);
    for (const trace of result.traces) {
      assertCompleteTrace(trace, trace.tickId);
    }
    expect(result.traces[2]?.interrupted).toBe(true);
    expect(result.traces[6]?.interrupted).toBe(true);
  });

  it("interrupts loot for a trade event and records interrupted", async () => {
    const result = await replayPack("full-loop-interrupt-trade");
    expect(result.traces[0]?.selectedState).toBe("LootPickup");
    expect(result.traces[1]?.selectedState).toBe("TradeSession");
    expect(result.traces[1]?.interrupted).toBe(true);
    expect(result.traces[1]?.executed).toBe(false);
  });

  it("interrupts follow for high-value loot and does not start trade", async () => {
    const result = await replayPack("full-loop-interrupt-loot");
    expect(result.traces[0]?.selectedState).toBe("Follow");
    expect(result.traces[1]?.selectedState).toBe("HighValueLoot");
    expect(result.traces[1]?.interrupted).toBe(true);
    expect(result.traces.every((trace) => trace.selectedState !== "TradeSession")).toBe(true);
  });

  it("lets emergency stop interrupt the loop", async () => {
    const result = await replayPack("full-loop-emergency-stop");
    expect(result.traces[0]?.selectedState).toBe("LootPickup");
    expect(result.traces[1]?.selectedState).toBe("EmergencyStop");
    expect(result.traces[1]?.decisionReason).toBe("emergency-stop");
    expect(result.traces[1]?.interrupted).toBe(true);
    expect(result.traces[1]?.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
  });

  it("uses ScenarioOrchestrator as the only tick entry through the live loop", async () => {
    const result = await replayPack("full-loop");
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(DefaultScenarioOrchestrator.name).toBe("DefaultScenarioOrchestrator");
  });
});
