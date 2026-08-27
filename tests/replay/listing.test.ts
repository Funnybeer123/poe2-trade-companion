import {
  DefaultGameInputController,
  ListingController,
  PriorityScenarioScheduler,
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
  expect(new ListingController().module).toBe("listing");
  for (const expectation of manifest.expect) {
    const trace = result.traces.find((entry) => entry.tickId === expectation.tickId);
    expect(trace?.selectedState).toBe(expectation.selectedState);
    if (expectation.decisionReasonIncludes !== undefined) {
      expect(trace?.decisionReason).toContain(expectation.decisionReasonIncludes);
    }
  }
  return result;
}

describe("listing replay", () => {
  it("applies the recommended listing through visible UI and verifies priceText", async () => {
    const result = await replayPack("listing-apply-price");
    expect(result.traces[0]?.intendedActions[0]?.type).toBe("mouse-click");
    expect(result.traces[1]?.intendedActions[0]?.type).toBe("mouse-click");
    expect(result.traces[2]?.intendedActions.some((action) => action.type === "key-tap")).toBe(true);
    expect(result.traces[2]?.intendedActions.map((action) => (action.type === "key-tap" ? action.key : "")).join("")).toContain(
      "14.55",
    );
    expect(result.traces[3]?.intendedActions).toEqual([
      { type: "noop", reason: result.traces[3]?.decisionReason },
    ]);
  });

  it("reprices a stale listing", async () => {
    const result = await replayPack("listing-reprice-stale");
    expect(result.traces[0]?.decisionReason).toContain("listing-stale-reprice");
    expect(result.traces[0]?.intendedActions.some((action) => action.type === "key-tap")).toBe(true);
    expect(result.traces[1]?.decisionReason).toContain("listing-verify-match");
  });

  it("skips low-confidence quotes without emitting listing input", async () => {
    const result = await replayPack("listing-low-confidence-skip");
    expect(result.traces[0]?.decisionReason).toContain("listing-skip:low-confidence");
    expect(result.traces[0]?.intendedActions.every((action) => action.type === "noop")).toBe(true);
  });

  it("stops during ApplyPrice when emergency stop latches", async () => {
    const result = await replayPack("listing-emergency-stop");
    expect(result.traces[0]?.selectedState).toBe("Listing");
    expect(result.traces[0]?.decisionReason).toContain("listing-apply-price");
    expect(result.traces[1]?.selectedState).toBe("EmergencyStop");
    expect(result.traces[1]?.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    expect(result.traces[1]?.interlockCode).toBe("emergency-stop");
  });
});
