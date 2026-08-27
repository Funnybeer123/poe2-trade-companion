import {
  CompositeDesirabilityPort,
  DefaultGameInputController,
  LootController,
  PriorityScenarioScheduler,
  createDesirabilityEngine,
  createFixtureDesirabilityScorer,
  createFixtureMarketProvider,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
  runReplay,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { marketFixtureDir, replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("loot-market-aware replay", () => {
  it("picks the clipboard-parsed unique using DesirabilityEngine and fixture quotes", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("loot-market-aware"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));
    const desirability = new CompositeDesirabilityPort({
      engine: createDesirabilityEngine(),
      fixture: createFixtureDesirabilityScorer(),
      quotes: createFixtureMarketProvider(marketFixtureDir(), () => 10_000),
    });
    const result = await runReplay({ manifest, scenario, desirability });

    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.scheduler).toBeInstanceOf(PriorityScenarioScheduler);
    expect(result.inputController).toBeInstanceOf(DefaultGameInputController);
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(new LootController().module).toBe("loot");
    expect(result.traces.map((trace) => trace.selectedState)).toEqual(["HighValueLoot", "Idle"]);
    expect(result.traces[0]?.decisionReason).toContain("pick:unique-1");
    expect(result.traces[0]?.decisionReason).toContain("skip:wisdom-1:below-min-score");
    expect(result.traces[0]?.intendedActions.some((action) => action.type === "mouse-click")).toBe(
      true,
    );

    for (const expectation of manifest.expect) {
      const trace = result.traces.find((entry) => entry.tickId === expectation.tickId);
      expect(trace?.selectedState).toBe(expectation.selectedState);
      if (expectation.decisionReasonIncludes !== undefined) {
        expect(trace?.decisionReason).toContain(expectation.decisionReasonIncludes);
      }
    }
  });
});
