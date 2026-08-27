import { FixtureDesirabilityScorer } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";

describe("FixtureDesirabilityScorer", () => {
  const scorer = new FixtureDesirabilityScorer();
  const ctx = { scenario: createTestScenario() };

  it("maps label keywords to stable integer scores and categories", () => {
    const divine = scorer.score({ id: "d", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } }, ctx);
    const junk = scorer.score(
      { id: "w", labelText: "Scroll of Wisdom", screenPoint: { x: 2, y: 2 } },
      ctx,
    );
    const exalted = scorer.score(
      { id: "e", labelText: "Exalted Orb", screenPoint: { x: 3, y: 3 } },
      ctx,
    );
    expect(divine.score).toBe(95);
    expect(divine.category).toBe("HighValueSell");
    expect(divine.reasons).toContain("keyword:divine");
    expect(junk.score).toBe(10);
    expect(junk.category).toBe("Dump");
    expect(exalted.score).toBe(80);
    expect(scorer.score({ id: "d", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } }, ctx)).toEqual(
      divine,
    );
  });

  it("prefers an explicit fixture score when present", () => {
    const result = scorer.score(
      { id: "e", labelText: "Exalted Orb", screenPoint: { x: 3, y: 3 }, score: 70 },
      ctx,
    );
    expect(result.score).toBe(70);
    expect(result.reasons).toContain("fixture-score:70");
    expect(result.factors.some((factor) => factor.id === "fixture-score")).toBe(true);
  });

  it("scores a NormalizedItem from name/rarity", () => {
    const result = scorer.score(
      {
        fingerprint: "rare-ring",
        name: "Paua Ring",
        rarity: "rare",
        modifiers: [],
        pseudos: {},
      },
      ctx,
    );
    expect(result.score).toBe(55);
    expect(result.category).toBe("Sell");
    expect(result.reasons).toContain("rarity:rare");
  });
});
