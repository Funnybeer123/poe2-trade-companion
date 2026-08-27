import {
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
  FrozenClock,
  InMemoryTraceSink,
  NoopInputSink,
  QaTraceWriter,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

function targetAt(atMs: number) {
  return {
    value: { identity: "qa-target", screenPoint: { x: 1600, y: 200 } },
    confidence: 0.92,
    observedAtMs: atMs,
    freshness: "fresh" as const,
  };
}

describe("follow recovery loop", () => {
  it("acquires, moves, loses the target, recovers, then returns to follow", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const frames = [
      {
        tickId: 1,
        capturedAtMs: 10_000,
        width: 1920,
        height: 1080,
        derived: { process: PROCESS, target: targetAt(10_000) },
      },
      {
        tickId: 2,
        capturedAtMs: 11_100,
        width: 1920,
        height: 1080,
        derived: {
          process: { ...PROCESS, observedAtMs: 11_100 },
        },
      },
      {
        tickId: 3,
        capturedAtMs: 11_200,
        width: 1920,
        height: 1080,
        derived: {
          process: { ...PROCESS, observedAtMs: 11_200 },
          target: targetAt(11_200),
        },
      },
    ];
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource(frames),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "follow-only",
        enabledModules: ["follow", "recovery"],
      }),
      traceWriter: new QaTraceWriter(traces),
    });

    const states: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await loop.tick();
      expect(outcome.result).toBe("ticked");
      if (outcome.result === "ticked") {
        states.push(outcome.world.selectedState);
        reasons.push(outcome.decision.reason);
      }
    }
    expect(states).toEqual(["Follow", "RecoverTarget", "Follow"]);
    expect(reasons).toEqual(["follow-target", "lost-target", "follow-target"]);
    expect(traces.traces.every((trace) => trace.executed === false)).toBe(true);
    const end = await loop.tick();
    expect(end.result).toBe("end-of-stream");
  });
});
