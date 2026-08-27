import {
  createCapabilities,
  createGameInputController,
  createInputSink,
  ForbiddenInputSink,
  FrozenClock,
  type InputAction,
  type InputResult,
  type InputSink,
} from "@poe2tc/core";
import { describe, expect, it, vi } from "vitest";
import { createTestDecision } from "../helpers/createTestDecision.js";
import { createTestInterlock } from "../helpers/createTestInterlock.js";

class SpyNativeSink implements InputSink {
  readonly kind = "native" as const;
  readonly execute = vi.fn<(action: InputAction) => Promise<InputResult>>(async () => {
    const now = Date.now();
    return { accepted: true, executed: true, dryRun: false, startedAtMs: now, finishedAtMs: now };
  });

  cancel(): void {
    return;
  }
}

describe("public-mode input integration", () => {
  it("records a click decision and never calls a spy native function", async () => {
    const native = new SpyNativeSink();
    const capabilities = createCapabilities("public-companion");
    const sink = createInputSink(capabilities);
    expect(sink).toBeInstanceOf(ForbiddenInputSink);

    const controller = createGameInputController({
      capabilities,
      sink,
      clock: new FrozenClock(20_000),
    });

    const decision = createTestDecision({
      module: "follow",
      intendedActions: [{ type: "mouse-click", x: 120, y: 240, button: "left" }],
    });
    const results = await controller.enqueue(
      decision,
      createTestInterlock({ mode: "public-companion", decision }),
    );

    expect(results.every((result) => result.executed === false)).toBe(true);
    expect(results[0]?.blockedReason).toBe("public-mode");
    expect(controller.recordedActions).toEqual([
      { type: "mouse-click", x: 120, y: 240, button: "left" },
    ]);
    expect(native.execute).not.toHaveBeenCalled();
    expect(controller.records[0]?.verdict.code).toBe("public-mode");
  });
});
