import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyWorldState, createScenarioScheduler, FrozenClock } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { createTestWorld, observeTarget } from "../../helpers/createTestWorld.js";

const scheduler = createScenarioScheduler();

describe("frozen-clock identity", () => {
  it("returns identical selections for identical inputs", () => {
    const clock = new FrozenClock(12_345);
    const world = createEmptyWorldState({
      clock,
      runtimeMode: "authorized-qa",
      activeScenarioId: "frozen",
      selectedState: "Idle",
    });
    world.process = {
      value: { allowlisted: true, name: "PathOfExile.exe" },
      confidence: 1,
      observedAtMs: clock.nowMs(),
      freshness: "fresh",
    };
    observeTarget(world, 0.85);
    world.target.observedAtMs = clock.nowMs();
    const scenario = createTestScenario({ id: "frozen" });

    const first = scheduler.select(world, scenario);
    const second = scheduler.select(world, scenario);

    expect(first).toEqual(second);
    expect(first.state).toBe("Follow");
    expect(clock.nowMs()).toBe(12_345);
  });

  it("does not change FrozenClock time during selection", () => {
    const clock = new FrozenClock(50_000);
    const world = createTestWorld((w) => {
      w.clockMs = clock.nowMs();
      w.capturedAtMs = clock.nowMs();
      observeTarget(w);
    });
    scheduler.select(world, createTestScenario());
    expect(clock.nowMs()).toBe(50_000);
    clock.advance(250);
    expect(clock.nowMs()).toBe(50_250);
  });

  it("does not call Math.random in scheduler selection", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/core/src/scheduler");
    const sources = ["scenarioScheduler.ts", "predicates.ts", "priorities.ts", "types.ts"].map((name) =>
      readFileSync(resolve(root, name), "utf8"),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/Math\.random/);
    }
  });
});
