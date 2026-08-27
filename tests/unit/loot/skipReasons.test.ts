import {
  FixtureDesirabilityScorer,
  SKIP_BELOW_MIN_SCORE,
  annotateLootTargets,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";

describe("loot skip reasons", () => {
  const port = new FixtureDesirabilityScorer();

  it("skips labels below scenario.lootMinScore (default 40)", () => {
    const annotated = annotateLootTargets(
      [
        { id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 100, y: 100 } },
        { id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 200, y: 200 } },
      ],
      createTestScenario(),
      { port },
    );
    expect(annotated.find((item) => item.id === "divine-1")?.skipReason).toBeUndefined();
    expect(annotated.find((item) => item.id === "divine-1")?.score).toBe(95);
    expect(annotated.find((item) => item.id === "wisdom-1")?.skipReason).toBe(SKIP_BELOW_MIN_SCORE);
    expect(annotated.find((item) => item.id === "wisdom-1")?.score).toBe(10);
  });

  it("does not skip below-min scores in an adversarial scenario", () => {
    const annotated = annotateLootTargets(
      [{ id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 200, y: 200 } }],
      createTestScenario({ lowConfidencePolicy: "adversarial-execute" }),
      { port },
    );
    expect(annotated[0]?.skipReason).toBeUndefined();
    expect(annotated[0]?.score).toBe(10);
  });

  it("honors an explicit lootMinScore override", () => {
    const annotated = annotateLootTargets(
      [{ id: "chaos-1", labelText: "Chaos Orb", screenPoint: { x: 10, y: 10 } }],
      createTestScenario({ lootMinScore: 60 }),
      { port },
    );
    expect(annotated[0]?.score).toBe(50);
    expect(annotated[0]?.skipReason).toBe(SKIP_BELOW_MIN_SCORE);
  });

  it("marks every label inventory-full when the bag is full", () => {
    const annotated = annotateLootTargets(
      [{ id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 100, y: 100 } }],
      createTestScenario(),
      { port, inventoryFull: true },
    );
    expect(annotated[0]?.skipReason).toBe("inventory-full");
    expect(annotated[0]?.score).toBe(95);
  });
});
