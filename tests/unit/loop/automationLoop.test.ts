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

  it("traces shadow-mismatch when a shadow item disappears and inventory is not full", async () => {
    const clock = new FrozenClock(0);
    const capabilities = createCapabilities("authorized-qa");
    const sink = new InMemoryTraceSink();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 64,
          height: 48,
          derived: {
            process: {
              value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
              confidence: 1,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            inventory: {
              value: {
                occupied: 1,
                capacity: 12,
                full: false,
                cells: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-a" }],
              },
              confidence: 1,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 64,
          height: 48,
          derived: {
            process: {
              value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
              confidence: 1,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            inventory: {
              value: {
                occupied: 0,
                capacity: 12,
                full: false,
                cells: [{ x: 0, y: 0, w: 1, h: 1, occupied: false }],
              },
              confidence: 1,
              observedAtMs: 10_200,
              freshness: "fresh",
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
        id: "stash-sort",
        enabledModules: ["inventory", "stash"],
      }),
      traceWriter: new QaTraceWriter(sink),
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    const second = await loop.tick();
    expect(second.result).toBe("ticked");
    if (second.result !== "ticked") {
      return;
    }
    expect(second.world.inventory.value.full).toBe(false);
    expect(second.world.flags.shadowMismatch).toBe(true);
    expect(second.decision.reason).toContain("shadow-mismatch");
    expect(second.trace.decisionReason).toContain("shadow-mismatch");
    expect(second.trace.observedSummary).toContain("mismatch=shadow-mismatch");
  });
});
