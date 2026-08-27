import {
  DefaultGameInputController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("follow-stuck-recovery replay", () => {
  it("detects no progress, runs follow.stuck recovery, then SafetyHold", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("follow-stuck-recovery"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);

    const reasons = result.traces.map((trace) => trace.decisionReason);
    expect(reasons).toContain("follow-target");
    expect(reasons).toContain("stuck-recovery");
    expect(reasons).toContain("stuck-exhausted");
    expect(result.traces.at(-1)?.selectedState).toBe("SafetyHold");
    expect(result.traces.some((trace) => trace.recoveryOf === "follow.stuck")).toBe(true);
    const stuckClicks = result.traces.filter(
      (trace) =>
        trace.decisionReason === "stuck-recovery" &&
        trace.intendedActions.some((action) => action.type === "mouse-click"),
    );
    expect(stuckClicks.length).toBeLessThanOrEqual(3);
  });
});
