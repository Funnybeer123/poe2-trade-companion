import { createScenarioScheduler } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { loadSchedulerPriorityFixtures } from "../helpers/schedulerPriorityFixtures.js";

const scheduler = createScenarioScheduler();
const fixtures = loadSchedulerPriorityFixtures();

describe("scheduler-priority integration snapshots", () => {
  it("loads eight world snapshots", () => {
    expect(fixtures).toHaveLength(8);
  });

  it.each(fixtures)("$id selects $expect.state", (fixture) => {
    const result = scheduler.select(fixture.world, fixture.scenario);
    expect(result.state).toBe(fixture.expect.state);
    if (fixture.expect.interrupt !== undefined) {
      expect(result.interrupt).toBe(fixture.expect.interrupt);
    }
    if (fixture.expect.reason !== undefined) {
      expect(result.reason).toBe(fixture.expect.reason);
    }
  });
});
