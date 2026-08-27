import {
  DefaultGameInputController,
  PriorityScenarioScheduler,
  StashController,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

async function replayPack(id: string) {
  const manifest = loadReplayManifestFile(replayManifestPath(id));
  const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
  const result = await runReplay({ manifest, scenario });
  expect(result.result).toBe("end-of-stream");
  expect(result.sinkKind).toBe("noop");
  expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
  expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
  expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
  expect(new StashController().module).toBe("stash");
  for (const expectation of manifest.expect) {
    const trace = result.traces.find((entry) => entry.tickId === expectation.tickId);
    expect(trace?.selectedState).toBe(expectation.selectedState);
    if (expectation.decisionReasonIncludes !== undefined) {
      expect(trace?.decisionReason).toContain(expectation.decisionReasonIncludes);
    }
  }
  return result;
}

describe("stash-sort replay", () => {
  it("sorts high-value first and traces every move", async () => {
    const result = await replayPack("stash-sort-success");
    expect(result.traces[0]?.intendedActions[0]?.type).toBe("mouse-drag");
    expect(result.traces[0]?.decisionReason).toContain("divine-1");
    expect(result.traces[1]?.decisionReason).toContain("chaos-1");
    expect(result.traces[2]?.decisionReason).toContain("stash-plan-empty");
  });

  it("falls back when the primary tab is full", async () => {
    const result = await replayPack("stash-full-fallback");
    expect(result.traces[0]?.decisionReason).toContain("stash-tab:dump");
    expect(result.traces[1]?.intendedActions[0]?.type).toBe("mouse-drag");
    expect(result.traces[1]?.decisionReason).toContain("fallback");
  });

  it("retries a failed move at most three times then FailedOrTimedOut", async () => {
    const result = await replayPack("stash-failed-move-retry");
    const moves = result.traces.filter((trace) =>
      trace.intendedActions.some((action) => action.type === "mouse-drag"),
    );
    expect(moves).toHaveLength(3);
    expect(result.traces.some((trace) => trace.recoveryOf === "stash.failed-move")).toBe(true);
    expect(result.traces.at(-1)?.decisionReason).toContain("FailedOrTimedOut");
    expect(result.traces.at(-1)?.intendedActions).toEqual([
      { type: "noop", reason: result.traces.at(-1)?.decisionReason },
    ]);
  });

  it("retries a wrong tab then transfers after the destination is visible", async () => {
    const result = await replayPack("stash-wrong-tab");
    expect(result.traces[0]?.intendedActions[0]?.type).toBe("mouse-click");
    expect(result.traces[1]?.recoveryOf).toBe("stash.wrong-tab");
    expect(result.traces[2]?.intendedActions[0]?.type).toBe("mouse-drag");
  });

  it("stops mid-sort when emergency stop latches", async () => {
    const result = await replayPack("stash-emergency-stop");
    expect(result.traces[0]?.selectedState).toBe("StashSort");
    expect(result.traces[1]?.selectedState).toBe("EmergencyStop");
    expect(result.traces[1]?.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    expect(result.traces[1]?.interlockCode).toBe("emergency-stop");
  });
});
