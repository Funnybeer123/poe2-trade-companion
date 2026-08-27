import {
  AGING_MAX_AGE_MS,
  FrozenClock,
  createEmptyWorldState,
  createReplayArming,
  createReplayRunner,
  createStateEstimator,
  loadAutomationScenarioFile,
  loadReplayManifestFile,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { replayManifestPath, scenarioFixturePath } from "../helpers/fixturePaths.js";

describe("perception-estimate replay", () => {
  it("goes target fresh then missing after the stale window via FrozenClock", async () => {
    const clock = new FrozenClock(0);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const manifest = loadReplayManifestFile(replayManifestPath("perception-estimate"));
    const scenario = loadAutomationScenarioFile(scenarioFixturePath(manifest.scenarioId));

    const first = manifest.frames[0];
    clock.advance(first!.atMs - clock.nowMs());
    let world = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: first!.tickId,
      capturedAtMs: first!.atMs,
      evidenceId: "replay-1",
      target: first!.derived.target as never,
      process: first!.derived.process as never,
      ui: first!.derived.ui as never,
    });
    expect(world.target.freshness).toBe("fresh");
    expect(world.target.value?.identity).toBe("qa-target");

    const second = manifest.frames[1];
    clock.advance(second!.atMs - clock.nowMs());
    expect(clock.nowMs() - 10_000).toBeGreaterThanOrEqual(AGING_MAX_AGE_MS);
    world = estimator.estimate(world, {
      tickId: second!.tickId,
      capturedAtMs: second!.atMs,
      evidenceId: "replay-2",
      process: second!.derived.process as never,
      ui: second!.derived.ui as never,
    });
    expect(world.target.freshness).toBe("missing");
    expect(world.target.value).toBeNull();

    const runner = createReplayRunner({
      manifest,
      scenario,
      clock: new FrozenClock(0),
    });
    const result = await runner.run();
    expect(result.result).toBe("end-of-stream");
    expect(result.sinkKind).toBe("noop");
    expect(result.traces.map((trace) => trace.tickId)).toEqual([1, 2]);
    expect(result.traces[0]?.selectedState).toBe("Follow");
    expect(result.traces[1]?.selectedState).toBe("RecoverTarget");
    expect(result.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(runner.loop.world.target.freshness).toBe("missing");
    expect(runner.loop.world.target.value).toBeNull();
  });
});
