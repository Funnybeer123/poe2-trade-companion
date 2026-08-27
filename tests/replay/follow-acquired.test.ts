import {
  DefaultGameInputController,
  PriorityScenarioScheduler,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("follow-acquired replay", () => {
  it("selects Follow through the live scheduler and records intended input without executing", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("follow-acquired"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const result = await runReplay({ manifest, scenario });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.inputController.sink.kind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);

    const trace = result.traces.find((entry) => entry.tickId === 1);
    expect(trace).toBeDefined();
    expect(trace?.selectedState).toBe("Follow");
    expect(trace?.decisionReason).toContain("follow");
    expect(trace?.executed).toBe(false);
    expect(trace?.dryRun).toBe(true);
    expect(
      trace?.intendedActions.some(
        (action) => action.type === "mouse-click" || action.type === "key-tap",
      ),
    ).toBe(true);
    expect(trace?.clockMs).toBe(10000);
    expect(trace?.timestamp).toBe(new Date(10000).toISOString());

    const expectation = manifest.expect[0];
    expect(expectation?.sinkKind).toBe("noop");
    expect(expectation?.executed).toBe(false);
  });

  it("uses the real ScenarioScheduler and GameInputController rather than a forked replay copy", () => {
    const source = readFileSync(join(repoRoot, "packages/core/src/replay/replayRunner.ts"), "utf8");
    expect(source).toContain("createScenarioScheduler");
    expect(source).toContain("createGameInputController");
    expect(source).toContain("NoopInputSink");
    expect(source).not.toMatch(/NativeInputSink|@poe2tc\/native-input|koffi/);
    expect(source).not.toMatch(/class ReplayScenarioScheduler|function selectReplayState/);
  });
});
