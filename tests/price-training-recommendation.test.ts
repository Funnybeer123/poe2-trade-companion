import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { scoreDesirability } from "../src/core/desirability.js";
import { valueItemLocally } from "../src/core/localValuation.js";
import { trainingIdentity, type PriceLesson } from "../src/core/priceTraining.js";
import { emptyValueTierRules } from "../src/core/valueTiers.js";

const raw = readFileSync(new URL("../fixtures/items/chilling-sapphire-training.txt", import.meta.url), "utf8");
const lesson: PriceLesson = { id: "sapphire", itemText: raw, league: "Forbidden Rites", amount: 1,
  currency: "divine", evidence: "estimate", scope: "exact", createdAt: "2026-09-14T12:00:00Z",
  updatedAt: "2026-09-14T12:00:00Z" };

describe("saved price recommendations", () => {
  it.each(["2026-09-14T13:00:00Z", "2026-11-14T13:00:00Z"])("keeps the corrected jewel even when the generic score is low (%s)", (date) => {
    const now = new Date(date);
    const parsed = trainingIdentity(raw).parsed;
    const verdict = evaluateWithAppraisal(raw, { rules: emptyValueTierRules(),
      training: { league: lesson.league, lessons: [lesson], now } });
    const valuation = valueItemLocally({ parsed, verdict, now });
    const result = scoreDesirability(parsed, valuation);
    expect(verdict.tier).toBe("keep");
    expect(result.score).toBeLessThan(40);
    expect(result.category).toBe("keep");
    expect(result.reasons[0]).toContain("Saved price evidence");
  });
});
