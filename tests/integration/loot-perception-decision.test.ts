import {
  FixtureDesirabilityScorer,
  FrozenClock,
  InMemoryTraceSink,
  LootController,
  NoopInputSink,
  QaTraceWriter,
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

describe("loot perception → score → decision", () => {
  it("scores fixture labels through FixtureDesirabilityScorer and records a pickup on the noop sink", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const sink = new NoopInputSink();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            inventory: {
              value: { occupied: 4, capacity: 60, cells: [], full: false },
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [
                { id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 900, y: 500 } },
                { id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 800, y: 400 } },
              ],
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink,
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "loot-only",
        enabledModules: ["loot", "recovery"],
      }),
      traceWriter: new QaTraceWriter(traces),
      desirability: new FixtureDesirabilityScorer(),
    });

    const outcome = await loop.tick();
    expect(outcome.result).toBe("ticked");
    if (outcome.result !== "ticked") {
      return;
    }
    expect(outcome.world.selectedState).toBe("HighValueLoot");
    expect(new LootController().module).toBe("loot");
    expect(outcome.decision.reason).toContain("pick:divine-1");
    expect(outcome.decision.reason).toContain("skip:wisdom-1:below-min-score");
    expect(outcome.trace.executed).toBe(false);
    expect(outcome.trace.followUpSummary).toContain("divine-1:pickable:95");
    expect(outcome.trace.followUpSummary).toContain("wisdom-1:skip:below-min-score:10");
    expect(sink.kind).toBe("noop");
    expect(
      outcome.decision.intendedActions.some((action) => action.type === "mouse-click"),
    ).toBe(true);
  });
});
