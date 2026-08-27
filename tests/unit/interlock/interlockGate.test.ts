import { createCapabilities, createInterlockGate, FrozenClock, TokenBucketRateLimiter } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestInterlock } from "../../helpers/createTestInterlock.js";

describe("InterlockGate evaluation order", () => {
  it("returns emergency-stop first", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        mode: "public-companion",
        arming: { emergencyStopLatched: true },
      }),
    );
    expect(verdict.code).toBe("emergency-stop");
    expect(verdict.allowExecute).toBe(false);
  });

  it("returns public-mode when canEmitNativeInput is false", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(createTestInterlock({ mode: "public-companion" }));
    expect(verdict.code).toBe("public-mode");
    expect(verdict.allowExecute).toBe(false);
    expect(verdict.allowRecord).toBe(true);
  });

  it("blocks QA execute when not acknowledged", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        arming: { acknowledged: false },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("qa-not-acknowledged");
    expect(verdict.allowExecute).toBe(false);
  });

  it("blocks QA execute when not armed", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        arming: { armed: false },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("qa-not-armed");
    expect(verdict.allowExecute).toBe(false);
  });

  it("blocks a process that is not allowlisted", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        world: (world) => {
          world.process.value.allowlisted = false;
        },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("window-not-allowlisted");
    expect(verdict.allowExecute).toBe(false);
  });

  it("blocks a window title outside the allowlist", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        world: (world) => {
          world.process.value.title = "Not The Game";
        },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("window-not-allowlisted");
  });

  it("blocks realm/account/character/scenario allowlist misses", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        arming: { scenarioAllowlist: ["other-scenario"] },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("allowlist-denied");
  });

  it("blocks a disabled scenario", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        scenario: { enabled: false, executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("scenario-disabled");
  });

  it("blocks a disabled module", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        scenario: { enabledModules: ["loot"], executionMode: "live" },
        decision: { module: "follow" },
      }),
    );
    expect(verdict.code).toBe("module-disabled");
  });

  it("blocks low confidence unless the scenario is adversarial-execute", () => {
    const gate = createInterlockGate();
    const skipped = gate.evaluate(
      createTestInterlock({
        scenario: { executionMode: "live", confidenceThreshold: 0.8, lowConfidencePolicy: "skip" },
        decision: { confidence: 0.2 },
      }),
    );
    expect(skipped.code).toBe("low-confidence");

    const adversarial = gate.evaluate(
      createTestInterlock({
        scenario: {
          executionMode: "live",
          confidenceThreshold: 0.8,
          lowConfidencePolicy: "adversarial-execute",
        },
        decision: { confidence: 0.2 },
      }),
    );
    expect(adversarial.code).toBe("ok");
    expect(adversarial.allowExecute).toBe(true);
  });

  it("blocks retry-exhausted", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        scenario: { executionMode: "live", retryLimits: { follow: 2 } },
        retryIndex: 2,
      }),
    );
    expect(verdict.code).toBe("retry-exhausted");
  });

  it("dry-run records and denies execute", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        scenario: { executionMode: "dry-run" },
      }),
    );
    expect(verdict.code).toBe("dry-run");
    expect(verdict.allowExecute).toBe(false);
    expect(verdict.allowRecord).toBe(true);
  });

  it("treats global dryRunDefault as dry-run even for live scenarios", () => {
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        arming: { dryRunDefault: true },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.code).toBe("dry-run");
    expect(verdict.allowExecute).toBe(false);
  });

  it("rate-limits the N+1 action", () => {
    const clock = new FrozenClock(10_000);
    const limiter = new TokenBucketRateLimiter(clock, 1);
    const gate = createInterlockGate({ rateLimiter: limiter, clock });
    const ctx = createTestInterlock({
      scenario: { executionMode: "live", actionsPerMinute: 1 },
    });
    expect(limiter.tryConsume(1)).toBe(true);
    const verdict = gate.evaluate(ctx);
    expect(verdict.code).toBe("rate-limited");
    expect(verdict.allowExecute).toBe(false);
  });

  it("does not treat authorized-qa capabilities as armed by themselves", () => {
    const caps = createCapabilities("authorized-qa");
    expect(caps.canEmitNativeInput).toBe(true);
    const gate = createInterlockGate();
    const verdict = gate.evaluate(
      createTestInterlock({
        capabilities: caps,
        arming: { armed: false },
        scenario: { executionMode: "live" },
      }),
    );
    expect(verdict.allowExecute).toBe(false);
  });
});
