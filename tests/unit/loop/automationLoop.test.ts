import {
  FrozenClock,
  InMemoryTraceSink,
  QaTraceWriter,
  createAutomationLoop,
  createCapabilities,
  createEmptyWorldState,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
  NoopInputSink,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";

describe("AutomationLoop", () => {
  it("returns end-of-stream when the frame source is exhausted", async () => {
    const clock = new FrozenClock(0);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([]),
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
        id: "follow-only",
        enabledModules: ["follow", "recovery"],
      }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
    });

    await expect(loop.tick()).resolves.toEqual({ result: "end-of-stream" });
    expect(loop.world.tickId).toBe(createEmptyWorldState({ clock }).tickId);
  });

  it("selects RecoverTarget through the live scheduler when the derived target is missing", async () => {
    const clock = new FrozenClock(0);
    const capabilities = createCapabilities("authorized-qa");
    const sink = new InMemoryTraceSink();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 2,
          capturedAtMs: 12_000,
          width: 1920,
          height: 1080,
          derived: {
            process: {
              value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
              confidence: 1,
              observedAtMs: 12_000,
              freshness: "fresh",
            },
            target: {
              value: null,
              confidence: 0,
              observedAtMs: 12_000,
              freshness: "missing",
            },
          },
        },
      ]),
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
        id: "follow-only",
        enabledModules: ["follow", "recovery"],
      }),
      traceWriter: new QaTraceWriter(sink),
    });

    const outcome = await loop.tick();
    expect(outcome.result).toBe("ticked");
    if (outcome.result !== "ticked") {
      return;
    }
    expect(outcome.world.selectedState).toBe("RecoverTarget");
    expect(outcome.trace.selectedState).toBe("RecoverTarget");
    expect(outcome.trace.executed).toBe(false);
    expect(clock.nowMs()).toBe(12_000);
  });
});
