import {
  DefaultGameInputController,
  InventoryController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("inventory-stale replay", () => {
  it("selects InventoryFull at 12/12 and is no longer full after a dropped cell", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("inventory-stale"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(new InventoryController().module).toBe("inventory");
    expect(result.traces[0]?.selectedState).toBe("InventoryFull");
    expect(result.traces[0]?.decisionReason).toContain("inventory-full");
    expect(result.traces[0]?.observedSummary).toContain("inventory=12/12 full=true");
    expect(result.traces[1]?.selectedState).not.toBe("InventoryFull");
    expect(result.traces[1]?.observedSummary).toContain("inventory=11/12 full=false");
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(
      result.traces.every(
        (trace) =>
          !trace.intendedActions.some(
            (action) => action.type === "mouse-drag" || action.type === "mouse-click",
          ),
      ),
    ).toBe(true);
  });
});
