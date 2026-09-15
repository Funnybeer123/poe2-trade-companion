import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";
import {
  estimateTrainingPrice,
  PRICE_TRAINING_LIMITS,
  trainingIdentity,
  validatePriceLessonInput,
  type PriceLesson,
  type PriceLessonInput,
} from "../src/core/priceTraining.js";

const source = readFileSync(path.join(process.cwd(), "fixtures/items/chilling-sapphire-training.txt"), "utf8");
const now = new Date("2026-09-14T23:00:00.000Z");
const league = "Test League";
const baseInput: PriceLessonInput = {
  itemText: source, league, amount: 1, currency: "divine", evidence: "estimate", scope: "exact",
};
const lesson = (overrides: Partial<PriceLesson> = {}): PriceLesson => ({
  ...baseInput, id: "lesson-1", createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides,
});
const estimate = (text = source, lessons: PriceLesson[] = [lesson()]) =>
  estimateTrainingPrice(text, league, lessons, now);
const roll = (cold: number, curse = 11) => source.replace("15(5-15)%", `${cold}(5-15)%`)
  .replace("11(15-5)%", `${curse}(15-5)%`);
const plain = parseAdvancedItemText(source).plainText.split("\n").filter((line) => !line.startsWith("{")).join("\n");

describe("trainingIdentity", () => {
  it("extracts the user's Sapphire rolls and exact modifier patterns without tier/range numbers", () => {
    const identity = trainingIdentity(source);
    expect(identity).toMatchObject({ itemClass: "Jewels", baseType: "Sapphire", rarity: "Magic", itemLevel: 79 });
    expect(identity.mods).toEqual([
      { kind: "explicit", pattern: "#% faster curse activation", values: [11] },
      { kind: "explicit", pattern: "#% increased cold damage", values: [15] },
    ]);
    expect(identity.parsed.name).toBe("Chilling Sapphire of Chanting");
  });

  it("gives advanced/plain copies and reordered modifier lines the same identity", () => {
    const a = trainingIdentity(source);
    const b = trainingIdentity(plain);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.groupKey).toBe(a.groupKey);
    const reordered = plain.replace("15% increased Cold Damage\n11% faster Curse Activation",
      "11% faster Curse Activation\n15% increased Cold Damage");
    expect(trainingIdentity(reordered).fingerprint).toBe(a.fingerprint);
  });

  it("ignores random rare names while preserving unique names", () => {
    const rare = plain.replace("Rarity: Magic\nChilling Sapphire of Chanting", "Rarity: Rare\nEagle Heart\nSapphire");
    const renamed = rare.replace("Eagle Heart", "Doom Heart");
    expect(trainingIdentity(rare).fingerprint).toBe(trainingIdentity(renamed).fingerprint);
    const unique = rare.replace("Rarity: Rare", "Rarity: Unique");
    expect(trainingIdentity(unique).groupKey).not.toBe(trainingIdentity(unique.replace("Eagle Heart", "Doom Heart")).groupKey);
  });

  it("requires full modifier identities, not the general jewel-damage family", () => {
    expect(trainingIdentity(source.replace(/Cold Damage/g, "Fire Damage")).groupKey)
      .not.toBe(trainingIdentity(source).groupKey);
    expect(trainingIdentity(source.replace("faster Curse Activation", "increased Charm Effect Duration")).groupKey)
      .not.toBe(trainingIdentity(source).groupKey);
  });

  it("keeps implicit/enchant/rune kinds and their patterns in the identity", () => {
    const explicit = `${plain}\n--------\n4% increased Cast Speed`;
    for (const kind of ["implicit", "enchant", "rune", "fractured"]) {
      const changed = `${plain}\n--------\n4% increased Cast Speed (${kind})`;
      expect(trainingIdentity(changed).groupKey).not.toBe(trainingIdentity(explicit).groupKey);
    }
  });

  it("fails closed for incomplete, unidentified, or unrolled descriptions", () => {
    expect(() => trainingIdentity("Rarity: Magic\nSapphire")).toThrow("complete copied");
    expect(() => trainingIdentity(`${source}\nUnidentified`)).toThrow("Identify the item");
    expect(() => trainingIdentity(source.replace("15(5-15)%", "(5-15)%"))).toThrow("actual rolled values");
  });
});

describe("validatePriceLessonInput", () => {
  it("accepts the exact copied item and preserves evidence/scope", () => {
    expect(validatePriceLessonInput({ ...baseInput, league: "  Test   League ", note: "  first example  " }))
      .toEqual({ valid: true, value: { ...baseInput, note: "first example" } });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, PRICE_TRAINING_LIMITS.maxAmount + 1])(
    "rejects invalid price %s", (amount) => {
      expect(validatePriceLessonInput({ ...baseInput, amount }).valid).toBe(false);
    },
  );

  it("rejects invalid enums, anonymous leagues, overly long fields, and unsafe links", () => {
    const invalid = [
      { league: "auto" }, { league: "" }, { league: "x".repeat(121) },
      { currency: "dollars" }, { evidence: "guaranteed" }, { scope: "all-jewels" },
      { note: "x".repeat(2_001) }, { itemText: "x".repeat(65_537) },
      { sourceUrl: "javascript:alert(1)" }, { sourceUrl: "https://user:password@example.test/" },
      { observedAt: "yesterday" },
    ];
    for (const change of invalid) expect(validatePriceLessonInput({ ...baseInput, ...change }).valid).toBe(false);
  });

  it("accepts an optional HTTPS evidence link and ISO observation timestamp", () => {
    const value = { ...baseInput, sourceUrl: "https://example.test/listing/1", observedAt: now.toISOString() };
    expect(validatePriceLessonInput(value)).toEqual({ valid: true, value });
  });
});

describe("estimateTrainingPrice", () => {
  it("retrieves one user estimate as an estimate, with only the observed amount as its range", () => {
    expect(estimate()).toMatchObject({ status: "matched", matchKind: "exact", amount: 1, low: 1, high: 1,
      currency: "divine", exampleCount: 1, confidence: 40, lessonIds: ["lesson-1"] });
    expect(estimate().reasons.join(" ")).toContain("user estimate");
    expect(estimate().reasons.join(" ")).toContain("not a guaranteed sale price");
  });

  it("matches the same item when the copy uses plain rather than advanced text", () => {
    expect(estimate(plain).status).toBe("matched");
  });

  it("never treats the name or tier labels alone as a price", () => {
    expect(estimate(source, []).status).toBe("unknown");
    expect(estimate(roll(5)).status).toBe("unknown");
    expect(estimate(source.replace("Cold Damage", "Fire Damage")).status).toBe("unknown");
  });

  it("requires explicit similar scope before using nearby rolls", () => {
    expect(estimate(roll(13)).status).toBe("unknown");
    expect(estimate(roll(13), [lesson({ scope: "similar" })])).toMatchObject({
      status: "matched", matchKind: "similar", amount: 1, confidence: 30,
    });
  });

  it("checks every roll, exact affix set, base, class, and rarity", () => {
    const examples = [lesson({ scope: "similar" })];
    for (const changed of [roll(12), roll(15, 9), source.replace(/Sapphire/g, "Ruby"),
      source.replace("Item Class: Jewels", "Item Class: Rings"), source.replace("Rarity: Magic", "Rarity: Rare"),
      `${source}\n+5 to maximum Life`, source.replace("15(5-15)% increased Cold Damage\n", "")]) {
      expect(estimate(changed, examples).status).toBe("unknown");
    }
  });

  it("permits at most five item levels of difference, only for similar scope", () => {
    const examples = [lesson({ scope: "similar" })];
    expect(estimate(source.replace("Item Level: 79", "Item Level: 84"), examples).status).toBe("matched");
    expect(estimate(source.replace("Item Level: 79", "Item Level: 85"), examples).status).toBe("unknown");
    expect(estimate(source.replace("Item Level: 79\n", ""), examples).status).toBe("unknown");
  });

  it.each(["Corrupted", "Mirrored", "Sanctified", "Split", "Quality: +20%", "Sockets: S"])(
    "never crosses the %s condition boundary", (status) => {
      expect(estimate(`${source}\n--------\n${status}`, [lesson({ scope: "similar" })]).status).toBe("unknown");
    },
  );

  it("does not reuse evidence from another league", () => {
    expect(estimate(source, [lesson({ league: "Old League" })]).status).toBe("unknown");
    expect(estimateTrainingPrice(source, "TEST LEAGUE", [lesson()], now).status).toBe("matched");
  });

  it("marks examples older than 30 days stale without quoting a current amount", () => {
    const createdAt = "2026-08-14T23:00:00.000Z";
    const result = estimate(source, [lesson({ createdAt, updatedAt: now.toISOString() })]);
    expect(result).toMatchObject({ status: "stale", confidence: 0, exampleCount: 1, lessonIds: ["lesson-1"] });
    expect(result.amount).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("older than 30 days");
  });

  it("uses observation time rather than a later import or note edit", () => {
    const observedAt = "2026-08-14T23:00:00.000Z";
    expect(estimate(source, [lesson({ observedAt })]).status).toBe("stale");
    expect(estimate(source, [lesson({ observedAt: "2026-09-15T23:00:00.000Z" })]).status).toBe("unknown");
  });

  it("refuses currency conversion and huge conflicting price ranges", () => {
    for (const other of [lesson({ id: "lesson-2", currency: "exalted", amount: 100 }),
      lesson({ id: "lesson-2", amount: 4 })]) {
      const result = estimate(source, [lesson(), other]);
      expect(result.status).toBe("conflict");
      expect(result.amount).toBeUndefined();
      expect(result.low).toBeUndefined();
      expect(result.currency).toBeUndefined();
    }
  });

  it("does not inflate confidence or median weighting through repeated examples", () => {
    const single = estimate();
    const duplicated = estimate(source, Array.from({ length: 25 }, (_, index) => lesson({ id: `duplicate-${index}` })));
    expect(duplicated.exampleCount).toBe(1);
    expect(duplicated.confidence).toBe(single.confidence);
    expect(duplicated.amount).toBe(single.amount);
    expect(duplicated.reasons.join(" ")).toContain("count once");
  });

  it("keeps estimate, asking-price listing, and recorded-sale evidence distinct", () => {
    const estimated = estimate();
    const listed = estimate(source, [lesson({ evidence: "listing" })]);
    const sold = estimate(source, [lesson({ evidence: "sale" })]);
    expect(estimated.confidence).toBeLessThan(listed.confidence);
    expect(listed.confidence).toBeLessThan(sold.confidence);
    expect(listed.reasons.join(" ")).toContain("asking-price listing");
    expect(sold.reasons.join(" ")).toContain("recorded sale");
    expect(sold.confidence).toBeLessThan(85);
  });

  it("uses the actual example range and lower median, with no invented uncertainty band", () => {
    const examples = [
      lesson({ id: "a", itemText: roll(13), scope: "similar", amount: 1 }),
      lesson({ id: "b", itemText: roll(14), scope: "similar", amount: 2 }),
    ];
    expect(estimate(source, examples)).toMatchObject({ status: "matched", matchKind: "similar",
      amount: 1, low: 1, high: 2, exampleCount: 2 });
  });

  it("prefers exact current examples over broader nearby matches", () => {
    expect(estimate(source, [lesson(), lesson({ id: "near", itemText: roll(14), scope: "similar", amount: 100 })]))
      .toMatchObject({ status: "matched", matchKind: "exact", amount: 1, lessonIds: ["lesson-1"] });
  });

  it("tolerates corrupt stored examples and invalid query text without throwing", () => {
    expect(estimate(source, [lesson({ amount: -1 }), lesson({ createdAt: "invalid" })]).status).toBe("unknown");
    expect(estimate("garbage").status).toBe("unknown");
  });

  it("does not generalize the taught Sapphire to unrelated jewels from the live journals", () => {
    const examples = [lesson({ scope: "similar" })];
    const mods = [
      ["5% increased Fire Damage", "8% increased Stun Threshold"],
      ["8% increased Projectile Damage", "11% increased Charm Effect Duration"],
      ["19% increased Presence Area of Effect", "12% increased Spell Damage", "4% increased Cast Speed (enchant)", "14% increased chance to inflict Ailments"],
    ];
    for (const lines of mods) {
      const copied = ["Item Class: Jewels", "Rarity: Magic", "Chilling Sapphire of Chanting", "--------",
        "Item Level: 79", "--------", ...lines].join("\n");
      expect(estimate(copied, examples).status).toBe("unknown");
    }
  });
});
