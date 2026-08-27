import {
  FrozenClock,
  InMemoryTraceSink,
  QaTraceWriter,
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
  NoopInputSink,
  loadReplayManifestFile,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";
import { replayManifestPath } from "../helpers/fixturePaths.js";

describe("full-loop orchestrator integration", () => {
  it("runs a multi-module fixture sequence through ScenarioOrchestrator", async () => {
    const manifest = loadReplayManifestFile(replayManifestPath("full-loop"));
    const clock = new FrozenClock(0);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: FixtureFrameSource.fromManifest(manifest),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities,
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities,
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "full-loop",
        enabledModules: [
          "follow",
          "loot",
          "inventory",
          "stash",
          "listing",
          "trade",
          "recovery",
          "orchestrator",
        ],
      }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
    });

    const states: string[] = [];
    for (;;) {
      const outcome = await loop.tick();
      if (outcome.result === "end-of-stream") {
        break;
      }
      states.push(outcome.world.selectedState);
      expect(outcome.trace.id.length).toBeGreaterThan(0);
      expect(outcome.trace.interlockCode).toBeDefined();
      expect(outcome.trace.intendedActions.length).toBeGreaterThan(0);
      expect(outcome.trace.executed).toBe(false);
    }

    expect(states).toEqual([
      "Follow",
      "LootPickup",
      "InventoryFull",
      "StashSort",
      "StashSort",
      "Listing",
      "TradeSession",
    ]);
    expect(loop.orchestrator).toBeDefined();
  });
});
