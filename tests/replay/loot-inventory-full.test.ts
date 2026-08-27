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

describe("loot-inventory-full replay", () => {
  it("interrupts to InventoryFull and never issues a pickup click", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("loot-inventory-full"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(new InventoryController().module).toBe("inventory");
    expect(result.traces.map((trace) => trace.selectedState)).toEqual([
      "InventoryFull",
      "InventoryFull",
    ]);
    expect(result.traces.every((trace) => trace.decisionReason.includes("inventory-full"))).toBe(
      true,
    );
    expect(
      result.traces.every(
        (trace) => !trace.intendedActions.some((action) => action.type === "mouse-click"),
      ),
    ).toBe(true);
    expect(result.traces[0]?.followUpSummary).toContain("exalted-1:skip:inventory-full");
  });
});
