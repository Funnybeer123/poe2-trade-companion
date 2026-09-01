import { describe, expect, it } from "vitest";
import {
  appraiseItem,
  confidenceBand,
  evaluateWithAppraisal,
} from "../src/core/appraisal.js";
import { matchModFamily, modPoints } from "../src/core/modKnowledge.js";
import { emptyPriceTable, type PriceTable } from "../src/core/priceTable.js";
import { emptyValueTierRules } from "../src/core/valueTiers.js";

function item(lines: string[]): string {
  return lines.join("\n");
}

const GREAT_RARE = item([
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Storm Carapace",
  "Advanced Maraketh Coat",
  "--------",
  "Item Level: 82",
  "--------",
  "+162 to maximum Life",
  "+92 to Spirit",
  "+14% to all Elemental Resistances",
  "+31% to Chaos Resistance",
  "28% increased Rarity of Items found",
]);

const MEDIOCRE_RARE = item([
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Iron Ring",
  "--------",
  "Item Level: 45",
  "--------",
  "+18 to maximum Life",
  "+9% to Fire Resistance",
  "+21 to maximum Mana",
]);

describe("mod knowledge base", () => {
  it("matches families with tiered rolls", () => {
    const life = matchModFamily("+162 to maximum Life");
    expect(life?.family.id).toBe("life");
    expect(life?.tier).toBe(1);
    const lowLife = matchModFamily("+18 to maximum Life");
    expect(lowLife?.tier).toBe(0);
    expect(matchModFamily("Grants nothing interesting")).toBeUndefined();
  });

  it("judges added-damage mods by their two-roll average", () => {
    const adds = matchModFamily("Adds 20 to 40 Physical Damage");
    expect(adds?.family.id).toBe("adds-phys");
    expect(adds?.judgedValue).toBe(30);
    expect(adds?.tier).toBe(1);
  });

  it("prefers the more specific family (all attributes before single)", () => {
    expect(matchModFamily("+27 to all Attributes")?.family.id).toBe("all-attributes");
    expect(matchModFamily("+27 to Strength")?.family.id).toBe("attribute");
  });

  it("scores top-tier heavy mods highest", () => {
    const spirit = matchModFamily("+92 to Spirit")!;
    const attribute = matchModFamily("+21 to Dexterity")!;
    expect(modPoints(spirit)).toBeGreaterThan(modPoints(attribute) * 5);
  });
});

describe("item appraisal", () => {
  it("scores a stacked rare high with a per-mod breakdown", () => {
    const appraisal = appraiseItem(GREAT_RARE);
    expect(appraisal.valueScore).toBeGreaterThanOrEqual(70);
    expect(appraisal.confidence).toBeGreaterThanOrEqual(50);
    expect(appraisal.evidence).toBe("mods");
    const spirit = appraisal.mods.find((mod) => mod.familyId === "spirit");
    expect(spirit?.tier).toBe(1);
    expect(spirit?.points).toBeGreaterThan(0);
    expect(appraisal.reasons.join(" ")).toMatch(/top-tier/i);
  });

  it("keeps a mediocre rare's score and confidence apart", () => {
    const appraisal = appraiseItem(MEDIOCRE_RARE);
    expect(appraisal.valueScore).toBeLessThan(30);
    // Cleanly parsed, nothing notable: a confident "meh", not a mystery.
    expect(appraisal.confidence).toBeGreaterThanOrEqual(25);
    expect(appraisal.band).toBe("low");
  });

  it("multiplies a currency stack by its price entry", () => {
    const table: PriceTable = {
      ...emptyPriceTable(),
      entries: [{ id: "ex", match: { name: "Exalted Orb" }, value: 1 }],
    };
    const appraisal = appraiseItem(
      item([
        "Item Class: Currency",
        "Rarity: Currency",
        "Exalted Orb",
        "--------",
        "Stack Size: 12/20",
      ]),
      { priceTable: table },
    );
    expect(appraisal.estimatedValue).toMatchObject({
      amount: 12,
      basis: "price-table-stack",
      stackCount: 12,
      unitValue: 1,
    });
    expect(appraisal.confidence).toBeGreaterThanOrEqual(90);
    expect(appraisal.band).toBe("very-high");
  });

  it("marks unidentified items low-confidence and never scores them worthless", () => {
    const appraisal = appraiseItem(
      item([
        "Item Class: Rings",
        "Rarity: Rare",
        "Gold Ring",
        "--------",
        "Unidentified",
      ]),
    );
    expect(appraisal.evidence).toBe("unidentified");
    expect(appraisal.band).toBe("low");
    expect(appraisal.valueScore).toBeGreaterThan(0);
  });

  it("flags a sparse rare with a strong roll as craft stock", () => {
    const appraisal = appraiseItem(
      item([
        "Item Class: Rings",
        "Rarity: Rare",
        "Storm Loop",
        "Ruby Ring",
        "--------",
        "+32% to Chaos Resistance",
        "+40 to maximum Mana",
      ]),
    );
    expect(appraisal.craftHint).toMatch(/open affixes/i);
  });

  it("returns zero for unparseable text", () => {
    const appraisal = appraiseItem("just some clipboard noise");
    expect(appraisal).toMatchObject({ valueScore: 0, confidence: 0, evidence: "unparseable" });
  });

  it("bands confidence sensibly", () => {
    expect(confidenceBand(95)).toBe("very-high");
    expect(confidenceBand(70)).toBe("high");
    expect(confidenceBand(45)).toBe("medium");
    expect(confidenceBand(10)).toBe("low");
  });
});

describe("evaluateWithAppraisal", () => {
  it("attaches the appraisal to explicit verdicts", () => {
    const verdict = evaluateWithAppraisal(GREAT_RARE, {
      rules: {
        ...emptyValueTierRules(),
        keep: [{ name: "spirit gear", regex: '"to Spirit"' }],
      },
    });
    expect(verdict.tier).toBe("keep");
    expect(verdict.source).toBe("rule");
    expect(verdict.appraisal?.valueScore).toBeGreaterThan(0);
  });

  it("promotes a high-scoring unknown item, with an explanation", () => {
    const verdict = evaluateWithAppraisal(GREAT_RARE, { rules: emptyValueTierRules() });
    expect(verdict.tier).toBe("keep");
    expect(verdict.source).toBe("heuristic");
    expect(verdict.reasons[0]).toMatch(/promoted to keep/);
  });

  it("never promotes below the confidence gate and never to dump", () => {
    const mediocre = evaluateWithAppraisal(MEDIOCRE_RARE, { rules: emptyValueTierRules() });
    expect(mediocre.tier).toBe("unknown");

    const strict = evaluateWithAppraisal(GREAT_RARE, {
      rules: emptyValueTierRules(),
      promote: { keepAtScore: 70, sellAtScore: 45, minConfidence: 99 },
    });
    expect(strict.tier).toBe("unknown");

    const disabled = evaluateWithAppraisal(GREAT_RARE, {
      rules: emptyValueTierRules(),
      promote: false,
    });
    expect(disabled.tier).toBe("unknown");
    expect(disabled.appraisal).toBeDefined();
  });
});
