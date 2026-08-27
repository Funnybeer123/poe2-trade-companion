import {
  FrozenClock,
  InMemoryTraceSink,
  NoopInputSink,
  QaTraceWriter,
  ShadowState,
  StashController,
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";
import { inventoryCells, stashCells } from "../helpers/stashWorld.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

describe("stash transfer confirmation", () => {
  it("confirms a planned drag only after the next fixture frame shows the new cell", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const shadow = new ShadowState();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            flags: {
              stashSessionActive: true,
              stashItemCatalog: {
                "divine-1": { class: "Currency", category: "HighValueSell", score: 95 },
              },
            },
            inventory: {
              value: {
                occupied: 1,
                capacity: 4,
                full: false,
                cells: inventoryCells([{ x: 0, y: 0, fingerprint: "divine-1" }]),
              },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            stash: {
              value: { tabId: "currency", tabName: "Currency", cells: stashCells("currency"), tabFull: false },
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            ui: { value: { kind: "stash" }, confidence: 0.9, observedAtMs: 10_000, freshness: "fresh" },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: { ...PROCESS, observedAtMs: 10_200 },
            inventory: {
              value: { occupied: 0, capacity: 4, full: false, cells: inventoryCells([]) },
              confidence: 0.95,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            stash: {
              value: {
                tabId: "currency",
                tabName: "Currency",
                cells: stashCells("currency", [{ x: 0, y: 0, fingerprint: "divine-1" }]),
                tabFull: false,
              },
              confidence: 0.9,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            ui: { value: { kind: "stash" }, confidence: 0.9, observedAtMs: 10_200, freshness: "fresh" },
          },
        },
      ]),
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
        id: "stash-sort",
        enabledModules: ["inventory", "stash"],
      }),
      traceWriter: new QaTraceWriter(traces),
      shadowState: shadow,
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.decision.intendedActions[0]?.type).toBe("mouse-drag");
    expect(first.decision.reason).toContain("stash-move:divine-1");
    expect(shadow.get({ kind: "inventory", x: 0, y: 0 })?.fingerprint).toBe("divine-1");

    const second = await loop.tick();
    expect(second.result).toBe("ticked");
    if (second.result !== "ticked") {
      return;
    }
    const confirmed = shadow.get({ kind: "stash", tabId: "currency", x: 0, y: 0 });
    expect(confirmed?.fingerprint).toBe("divine-1");
    expect(confirmed?.mismatch).toBe(false);
    expect(shadow.get({ kind: "inventory", x: 0, y: 0 })).toBeUndefined();
    expect(second.world.flags.shadowMismatch).not.toBe(true);
    expect(second.decision.reason).toBe("stash-plan-empty");
    expect(new StashController().module).toBe("stash");
    expect(traces.traces[0]?.decisionReason).toContain("stash-move:divine-1");
  });
});
