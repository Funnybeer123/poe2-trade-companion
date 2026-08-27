import {
  DEFAULT_RECOVERY,
  DefaultGameInputController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("loot-unreachable-backoff replay", () => {
  it("retries once, then suppresses the id for 15s after two observed failures", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("loot-unreachable-backoff"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(DEFAULT_RECOVERY["loot.unreachable"]?.maxAttempts).toBe(2);
    expect(DEFAULT_RECOVERY["loot.unreachable"]?.suppressMs).toBe(15_000);

    const clicks = result.traces.filter((trace) =>
      trace.intendedActions.some((action) => action.type === "mouse-click"),
    );
    expect(clicks).toHaveLength(2);
    expect(clicks.every((trace) => trace.decisionReason.includes("pick:exalted-1"))).toBe(true);
    expect(result.traces.some((trace) => trace.recoveryOf === "loot.unreachable")).toBe(true);
    expect(result.traces[1]?.retryIndex).toBe(2);

    expect(result.traces.slice(2).every((trace) => trace.selectedState === "Idle")).toBe(true);
    expect(
      result.traces
        .slice(2)
        .every((trace) => !trace.intendedActions.some((action) => action.type === "mouse-click")),
    ).toBe(true);
    expect(result.traces[2]?.observedSummary).toContain("exalted-1:skip:unreachable");
    expect(result.traces[3]?.followUpSummary).toContain("skip:unreachable");
  });
});
