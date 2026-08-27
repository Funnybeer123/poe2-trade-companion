import {
  createDesirabilityEngine,
  createFixtureDesirabilityScorer,
  parseItem,
  type MarketQuote,
  type NormalizedItem,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../../helpers/createTestScenario.js";
import { itemFixturePath } from "../../helpers/fixturePaths.js";

function parsed(name: string): NormalizedItem {
  const result = parseItem({
    rawText: readFileSync(itemFixturePath(name), "utf8"),
    source: "fixture",
    capturedAtMs: 1,
  });
  if (!result.ok) {
    throw new Error(`expected ${name} to parse`);
  }
  return result.item;
}

function quote(fair: number, confidence: MarketQuote["confidence"] = "high"): MarketQuote {
  return {
    providerId: "fixture",
    quotedAtMs: 1,
    currency: "exalted",
    low: fair * 0.8,
    fair,
    high: fair * 1.2,
    recommendedListing: fair,
    candidateCount: 8,
    comparableCount: 7,
    confidence,
    comparables: [],
  };
}

describe("DesirabilityEngine", () => {
  const engine = createDesirabilityEngine();
  const scenario = createTestScenario();

  it("is deterministic for identical item and quote", () => {
    const item = parsed("unique-amulet.txt");
    const ctx = { scenario, quote: quote(15, "high") };
    expect(engine.score(item, ctx)).toEqual(engine.score(item, ctx));
    expect(engine.score(item, ctx).score).toBe(96);
    expect(engine.score(item, ctx).reasons).toContain("market:fixture:high");
  });

  it("does not use label-only loot targets", () => {
    const result = engine.score(
      { id: "divine-1", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } },
      { scenario },
    );
    expect(result.category).toBe("ManualReview");
    expect(result.reasons).toContain("engine-requires-normalized-item");
  });

  it("marks unidentified items ManualReview", () => {
    const item = parsed("rare-ring.txt");
    const result = engine.score({ ...item, unidentified: true }, { scenario });
    expect(result.category).toBe("ManualReview");
    expect(result.reasons).toContain("unidentified");
  });

  it("keeps FixtureDesirabilityScorer for label-only scoring", () => {
    const fixture = createFixtureDesirabilityScorer();
    const label = fixture.score(
      { id: "d", labelText: "Divine Orb", screenPoint: { x: 1, y: 1 } },
      { scenario },
    );
    expect(label.score).toBe(95);
  });
});
