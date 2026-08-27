import {
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FrozenClock,
  InMemoryTraceSink,
  NoopInputSink,
  QaTraceWriter,
  type PerceptionAdapter,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";

class ThrowingAdapter implements PerceptionAdapter {
  async analyze(): Promise<never> {
    throw new Error("cv-failed");
  }
}

describe("perception analyze errors", () => {
  it("do not throw through the loop and become unknown UI with SafetyHold", async () => {
    const clock = new FrozenClock(0);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: {
        async nextFrame() {
          return {
            tickId: 7,
            capturedAtMs: 20_000,
            width: 64,
            height: 64,
          };
        },
      },
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
      perception: new ThrowingAdapter(),
    });

    const outcome = await loop.tick();
    expect(outcome.result).toBe("ticked");
    if (outcome.result !== "ticked") {
      return;
    }
    expect(outcome.world.ui.value.kind).toBe("unknown");
    expect(outcome.world.ui.confidence).toBe(0);
    expect(outcome.world.ui.value.details).toContain("cv-failed");
    expect(outcome.world.process.value.allowlisted).toBe(false);
    expect(outcome.world.selectedState).toBe("SafetyHold");
    expect(outcome.trace.executed).toBe(false);
  });
});
