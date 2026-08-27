import {
  createCapabilities,
  createGameInputController,
  EmergencyStop,
  FrozenClock,
  TokenBucketRateLimiter,
  type InputAction,
  type InputResult,
  type InputSink,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestDecision } from "../../helpers/createTestDecision.js";
import { createTestInterlock } from "../../helpers/createTestInterlock.js";

class SpySink implements InputSink {
  readonly kind = "noop" as const;
  readonly calls: InputAction[] = [];
  inflight = 0;
  maxInflight = 0;
  delayMs = 15;

  async execute(action: InputAction): Promise<InputResult> {
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    this.calls.push(action);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.inflight -= 1;
    const now = Date.now();
    return { accepted: true, executed: true, dryRun: false, startedAtMs: now, finishedAtMs: now };
  }

  cancel(): void {
    this.calls.push({ type: "noop", reason: "cancel" });
  }
}

describe("GameInputController", () => {
  it("public-companion records and never executes", async () => {
    const spy = new SpySink();
    const controller = createGameInputController({
      capabilities: createCapabilities("public-companion"),
      sink: spy,
      clock: new FrozenClock(1),
    });
    const results = await controller.enqueue(
      createTestDecision(),
      createTestInterlock({ mode: "public-companion" }),
    );
    expect(results.every((result) => result.executed === false)).toBe(true);
    expect(results[0]?.blockedReason).toBe("public-mode");
    expect(spy.calls.filter((action) => action.type === "mouse-click")).toHaveLength(0);
    expect(controller.recordedActions).toHaveLength(1);
  });

  it("dry-run records intended actions with executed false", async () => {
    const spy = new SpySink();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      sink: spy,
      clock: new FrozenClock(1),
    });
    const results = await controller.enqueue(
      createTestDecision(),
      createTestInterlock({ scenario: { executionMode: "dry-run" } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.dryRun).toBe(true);
    expect(results[0]?.executed).toBe(false);
    expect(results[0]?.accepted).toBe(true);
    expect(spy.calls.filter((action) => action.type === "mouse-click")).toHaveLength(0);
    expect(controller.recordedActions).toEqual([
      { type: "mouse-click", x: 400, y: 300, button: "left" },
    ]);
  });

  it("kill switch blocks new input and clears the queue", async () => {
    const spy = new SpySink();
    spy.delayMs = 30;
    const stop = new EmergencyStop();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      emergencyStop: stop,
      sink: spy,
      clock: new FrozenClock(1),
    });
    const live = createTestInterlock({ scenario: { executionMode: "live" } });
    const first = controller.enqueue(createTestDecision({ reason: "first" }), live);
    const second = controller.enqueue(createTestDecision({ reason: "second" }), live);
    controller.emergencyStop();
    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(controller.isStopped()).toBe(true);
    expect(secondResults[0]?.blockedReason).toBe("emergency-stop");
    expect(secondResults.every((result) => result.executed === false)).toBe(true);
    const after = await controller.enqueue(createTestDecision({ reason: "after" }), live);
    expect(after[0]?.blockedReason).toBe("emergency-stop");
    expect(firstResults.length).toBeGreaterThan(0);
  });

  it("rearm requires an explicit call; enqueue does not implicitly rearm", async () => {
    const stop = new EmergencyStop();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      emergencyStop: stop,
      clock: new FrozenClock(1),
    });
    controller.emergencyStop();
    const blocked = await controller.enqueue(
      createTestDecision(),
      createTestInterlock({ scenario: { executionMode: "live" } }),
    );
    expect(blocked[0]?.blockedReason).toBe("emergency-stop");
    stop.rearm({ explicit: true });
    expect(controller.isStopped()).toBe(false);
  });

  it("serializes sink execution so actions do not overlap", async () => {
    const spy = new SpySink();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      sink: spy,
      clock: new FrozenClock(1),
    });
    const live = createTestInterlock({
      scenario: { executionMode: "live", actionsPerMinute: 120 },
    });
    await Promise.all([
      controller.enqueue(createTestDecision({ reason: "a" }), live),
      controller.enqueue(createTestDecision({ reason: "b" }), live),
      controller.enqueue(createTestDecision({ reason: "c" }), live),
    ]);
    expect(spy.maxInflight).toBe(1);
    expect(spy.calls.filter((action) => action.type === "mouse-click")).toHaveLength(3);
  });

  it("rate-limits the N+1 action across enqueues", async () => {
    const clock = new FrozenClock(5_000);
    const limiter = new TokenBucketRateLimiter(clock, 1);
    const spy = new SpySink();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      clock,
      rateLimiter: limiter,
      sink: spy,
    });
    const ctx = createTestInterlock({
      scenario: { executionMode: "live", actionsPerMinute: 1 },
    });
    const first = await controller.enqueue(createTestDecision({ reason: "one" }), ctx);
    const second = await controller.enqueue(createTestDecision({ reason: "two" }), ctx);
    expect(first[0]?.executed).toBe(true);
    expect(second[0]?.blockedReason).toBe("rate-limited");
    expect(second[0]?.executed).toBe(false);
    expect(spy.calls.filter((action) => action.type === "mouse-click")).toHaveLength(1);
  });

  it("does not execute when QA is not armed", async () => {
    const spy = new SpySink();
    const controller = createGameInputController({
      capabilities: createCapabilities("authorized-qa"),
      sink: spy,
      clock: new FrozenClock(1),
    });
    const results = await controller.enqueue(
      createTestDecision(),
      createTestInterlock({
        arming: { armed: false },
        scenario: { executionMode: "live" },
      }),
    );
    expect(results.every((result) => result.executed === false)).toBe(true);
    expect(results[0]?.blockedReason).toBe("qa-not-armed");
    expect(spy.calls.filter((action) => action.type === "mouse-click")).toHaveLength(0);
  });
});
