import {
  DefaultGameInputController,
  LootController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("loot-desirable-vs-junk replay", () => {
  it("picks the desirable label, skips junk, then idles after observed pickup", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("loot-desirable-vs-junk"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(new LootController().module).toBe("loot");

    expect(result.traces.map((trace) => trace.selectedState)).toEqual(["HighValueLoot", "Idle"]);
    expect(result.traces[0]?.decisionReason).toContain("pick:divine-1");
    expect(result.traces[0]?.decisionReason).toContain("skip:wisdom-1:below-min-score");
    expect(result.traces[0]?.intendedActions.some((action) => action.type === "mouse-click")).toBe(
      true,
    );
    expect(result.traces[0]?.observedSummary).toContain("divine-1:pickable:95");
    expect(result.traces[1]?.intendedActions.some((action) => action.type === "mouse-click")).toBe(
      false,
    );
    expect(result.traces[1]?.followUpSummary).toContain("wisdom-1:skip:below-min-score");

    for (const expectation of manifest.expect) {
      const trace = result.traces.find((entry) => entry.tickId === expectation.tickId);
      expect(trace?.selectedState).toBe(expectation.selectedState);
      if (expectation.decisionReasonIncludes !== undefined) {
        expect(trace?.decisionReason).toContain(expectation.decisionReasonIncludes);
      }
    }
  });
});
