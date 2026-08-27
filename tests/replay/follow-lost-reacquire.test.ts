import {
  DefaultGameInputController,
  FollowController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("follow-lost-reacquire replay", () => {
  it("follows, recovers a lost target, then follows again using the live FollowController", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("follow-lost-reacquire"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);

    const reasons = result.traces.map((trace) => trace.decisionReason);
    expect(reasons).toContain("follow-target");
    expect(reasons).toContain("lost-target");
    expect(result.traces.map((trace) => trace.selectedState)).toEqual([
      "Follow",
      "RecoverTarget",
      "RecoverTarget",
      "Follow",
    ]);
    expect(result.traces.some((trace) => trace.recoveryOf === "follow.lost-target")).toBe(true);

    const loopSource = readFileSync(join(REPO_ROOT, "packages/core/src/loop/automationLoop.ts"), "utf8");
    expect(loopSource).toContain("createControllerMap");
    expect(loopSource).not.toContain("createPhase04ControllerMap");
    expect(loopSource).not.toContain("follow-placeholder");
    expect(new FollowController().module).toBe("follow");
  });
});
