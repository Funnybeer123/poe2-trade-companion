import {
  DefaultGameInputController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("follow-emergency-stop replay", () => {
  it("interrupts follow with emergency-stop and records no executed input", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("follow-emergency-stop"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);

    const reasons = result.traces.map((trace) => trace.decisionReason);
    expect(reasons).toContain("follow-target");
    expect(reasons).toContain("emergency-stop");
    expect(result.traces[0]?.selectedState).toBe("Follow");
    expect(result.traces[1]?.selectedState).toBe("EmergencyStop");
    expect(result.traces[1]?.intendedActions).toEqual([{ type: "noop", reason: "emergency-stop" }]);
    expect(result.traces[1]?.interlockCode).toBe("emergency-stop");
  });
});
