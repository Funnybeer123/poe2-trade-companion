import {
  ACTION_BUDGET_HOLD_REASON,
  ActionBudget,
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
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

function processAt(atMs: number) {
  return { ...PROCESS, observedAtMs: atMs };
}

describe("orchestrator interrupt matrix", () => {
  it("lets trade interrupt loot and follow, records interrupted, and keeps loot counters", async () => {
    const clock = new FrozenClock(10_000);
    const capabilities = createCapabilities("authorized-qa");
    const sink = new InMemoryTraceSink();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_000),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [{ id: "exalted-1", labelText: "Exalted Orb", screenPoint: { x: 700, y: 350 } }],
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            inventory: {
              value: { occupied: 1, capacity: 12, cells: [], full: false },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            flags: { lootAttemptCounts: { "exalted-1": 1 }, lootLastAttemptMs: { "exalted-1": 9_000 } },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_200),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            loot: {
              value: [{ id: "exalted-1", labelText: "Exalted Orb", screenPoint: { x: 700, y: 350 } }],
              confidence: 0.9,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            flags: {
              tradeRequested: true,
              tradeEvent: {
                kind: "whisper-trade-request",
                source: "fixture",
                atMs: 10_200,
                requestedItemFingerprint: "astramentis-1",
              },
              tradeExpected: {
                itemFingerprint: "astramentis-1",
                currency: "divine",
                amount: 10,
              },
              lootAttemptCounts: { "exalted-1": 1 },
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
      scenario: createTestScenario({ id: "full-loop", enabledModules: ["follow", "loot", "trade", "recovery"] }),
      traceWriter: new QaTraceWriter(sink),
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.world.selectedState).toBe("LootPickup");
    expect(first.world.flags.pendingLootPickup?.id).toBe("exalted-1");
    expect(first.world.flags.lootAttemptCounts?.["exalted-1"]).toBe(1);

    const second = await loop.tick();
    expect(second.result).toBe("ticked");
    if (second.result !== "ticked") {
      return;
    }
    expect(second.world.selectedState).toBe("TradeSession");
    expect(second.trace.interrupted).toBe(true);
    expect(second.world.flags.pendingLootPickup).toBeNull();
    expect(second.world.flags.lootAttemptCounts?.["exalted-1"]).toBe(1);
  });

  it("lets inventory full interrupt loot and follow", async () => {
    const clock = new FrozenClock(10_000);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_000),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [{ id: "exalted-1", labelText: "Exalted Orb", screenPoint: { x: 700, y: 350 } }],
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            inventory: {
              value: { occupied: 12, capacity: 12, cells: [], full: true },
              confidence: 0.95,
              observedAtMs: 10_000,
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
        id: "full-loop",
        enabledModules: ["follow", "loot", "inventory", "stash", "recovery"],
      }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
    });

    const outcome = await loop.tick();
    expect(outcome.result).toBe("ticked");
    if (outcome.result !== "ticked") {
      return;
    }
    expect(outcome.world.selectedState).toBe("InventoryFull");
    expect(outcome.world.flags.stashSessionActive).toBe(true);
    expect(outcome.trace.interrupted).toBe(true);
    expect(outcome.decision.intendedActions.some((action) => action.type === "mouse-click")).toBe(false);
  });

  it("lets high-value loot interrupt follow but not trade", async () => {
    const clock = new FrozenClock(10_000);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_000),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [{ id: "mirror-1", labelText: "Mirror of Kalandra", screenPoint: { x: 700, y: 350 } }],
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_200),
            loot: {
              value: [{ id: "mirror-1", labelText: "Mirror of Kalandra", screenPoint: { x: 700, y: 350 } }],
              confidence: 0.9,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            flags: {
              tradeRequested: true,
              tradeEvent: {
                kind: "whisper-trade-request",
                source: "fixture",
                atMs: 10_200,
                requestedItemFingerprint: "astramentis-1",
              },
              tradeExpected: { itemFingerprint: "astramentis-1", currency: "divine", amount: 10 },
            },
            trade: {
              value: { open: true, ourSlots: [], theirSlots: [] },
              confidence: 0.95,
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
      scenario: createTestScenario({ id: "full-loop" }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.world.selectedState).toBe("HighValueLoot");
    expect(first.trace.interrupted).toBe(true);

    const second = await loop.tick();
    expect(second.result).toBe("ticked");
    if (second.result !== "ticked") {
      return;
    }
    expect(second.world.selectedState).toBe("TradeSession");
    expect(second.trace.interrupted).toBe(true);
  });

  it("lets emergency stop beat every other state", async () => {
    const clock = new FrozenClock(10_000);
    const capabilities = createCapabilities("authorized-qa");
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_000),
            flags: {
              emergencyStopLatched: true,
              tradeRequested: true,
            },
            trade: {
              value: { open: true, ourSlots: [], theirSlots: [] },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            inventory: {
              value: { occupied: 12, capacity: 12, cells: [], full: true },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [{ id: "mirror-1", labelText: "Mirror of Kalandra", screenPoint: { x: 1, y: 1 } }],
              confidence: 0.9,
              observedAtMs: 10_000,
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
      scenario: createTestScenario({ id: "full-loop" }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
    });

    const outcome = await loop.tick();
    expect(outcome.result).toBe("ticked");
    if (outcome.result !== "ticked") {
      return;
    }
    expect(outcome.world.selectedState).toBe("EmergencyStop");
    expect(outcome.decision.reason).toBe("emergency-stop");
    expect(outcome.trace.interrupted).toBe(true);
  });
});

describe("orchestrator action budget", () => {
  it("holds on SafetyHold when the action budget is exhausted and resumes after refill", async () => {
    const clock = new FrozenClock(10_000);
    const capabilities = createCapabilities("authorized-qa");
    const budget = new ActionBudget(clock, 1);
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_000),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(10_200),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 3,
          capturedAtMs: 70_200,
          width: 1920,
          height: 1080,
          derived: {
            process: processAt(70_200),
            target: {
              value: { identity: "qa-target", screenPoint: { x: 640, y: 360 } },
              confidence: 0.92,
              observedAtMs: 70_200,
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
      scenario: createTestScenario({ id: "follow-only", enabledModules: ["follow", "recovery"], actionsPerMinute: 1 }),
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
      actionBudget: budget,
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.world.selectedState).toBe("Follow");
    expect(first.decision.intendedActions.some((action) => action.type !== "noop")).toBe(true);

    const held = await loop.tick();
    expect(held.result).toBe("ticked");
    if (held.result !== "ticked") {
      return;
    }
    expect(held.world.selectedState).toBe("SafetyHold");
    expect(held.decision.reason).toBe(ACTION_BUDGET_HOLD_REASON);
    expect(held.decision.intendedActions).toEqual([{ type: "noop", reason: ACTION_BUDGET_HOLD_REASON }]);

    const resumed = await loop.tick();
    expect(resumed.result).toBe("ticked");
    if (resumed.result !== "ticked") {
      return;
    }
    expect(resumed.world.selectedState).toBe("Follow");
  });
});
