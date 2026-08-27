import { rankLoot } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("rankLoot", () => {
  it("is deterministic: score desc, then nearest to center, then id asc", () => {
    const center = { x: 960, y: 540 };
    const ranked = rankLoot(
      [
        { id: "b-near", screenPoint: { x: 970, y: 540 }, score: 50 },
        { id: "a-near", screenPoint: { x: 950, y: 540 }, score: 50 },
        { id: "far-high", screenPoint: { x: 100, y: 100 }, score: 90 },
        { id: "mid", screenPoint: { x: 800, y: 540 }, score: 70 },
        { id: "b-same", screenPoint: { x: 1000, y: 540 }, score: 50 },
      ],
      center,
    );
    expect(ranked.map((item) => item.id)).toEqual(["far-high", "mid", "a-near", "b-near", "b-same"]);
    expect(rankLoot(ranked, center).map((item) => item.id)).toEqual([
      "far-high",
      "mid",
      "a-near",
      "b-near",
      "b-same",
    ]);
  });

  it("treats a missing score as 0", () => {
    const ranked = rankLoot([
      { id: "unscored", screenPoint: { x: 960, y: 540 } },
      { id: "low", screenPoint: { x: 10, y: 10 }, score: 1 },
    ]);
    expect(ranked[0]?.id).toBe("low");
  });
});
