import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import {
  assessDemand,
  classifyLines,
  compileLinePattern,
  demandConfidence,
  describeMatch,
  readWeapon,
  validateDemandKnowledge,
  type DemandKnowledge,
} from "../src/core/buildDemand.js";
import { DEMAND_KNOWLEDGE } from "../src/data/demand/buildDemand.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";
import { weaponDps } from "../src/core/itemStats.js";
import { matchModFamily } from "../src/core/modKnowledge.js";
import { parseItemText } from "../src/core/parseItem.js";

const NOW = new Date("2026-09-14T22:00:00Z");

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");
}

function parse(text: string) {
  return parseItemText(parseAdvancedItemText(text).plainText);
}

function assess(text: string, knowledge: DemandKnowledge = DEMAND_KNOWLEDGE) {
  const parsed = parse(text);
  return assessDemand(parsed, appraiseItem(text, { parsed }), { knowledge, now: NOW });
}

const item = (lines: string[]): string => lines.join("\n");

describe("demand knowledge table", () => {
  it("is internally consistent: unique ids, resolvable references, compilable patterns, https sources", () => {
    expect(validateDemandKnowledge(DEMAND_KNOWLEDGE)).toEqual([]);
    expect(DEMAND_KNOWLEDGE.league).toBe("Forbidden Rites");
    expect(Date.parse(DEMAND_KNOWLEDGE.reviewBy)).toBeGreaterThan(Date.parse(DEMAND_KNOWLEDGE.retrievedAt));
  });

  it("carries provenance on every source and marks unverified patterns as such", () => {
    for (const source of DEMAND_KNOWLEDGE.sources) {
      expect(source.retrievedAt).toBe("2026-09-14");
      expect(source.note.length).toBeGreaterThan(20);
    }
    // Nothing has been checked against live listings yet.
    expect(DEMAND_KNOWLEDGE.patterns.every((pattern) => pattern.verified === false)).toBe(true);
    expect(DEMAND_KNOWLEDGE.weaponDps.every((row) => row.verified === false)).toBe(true);
  });

  it("reports a knowledge table with a broken reference", () => {
    const broken: DemandKnowledge = {
      ...DEMAND_KNOWLEDGE,
      patterns: [{ ...DEMAND_KNOWLEDGE.patterns[0]!, builds: ["no-such-build"] }],
      lines: [{ id: "bad", pattern: "(", label: "bad", role: "filler" }],
    };
    const issues = validateDemandKnowledge(broken);
    expect(issues.some((issue) => issue.includes("no-such-build"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("line bad"))).toBe(true);
  });
});

describe("line classification", () => {
  it("compiles # patterns anchored and case-insensitive", () => {
    const regex = compileLinePattern(String.raw`#% increased Light Radius`);
    expect(regex.test("10% increased Light Radius")).toBe(true);
    expect(regex.test("10% increased light radius")).toBe(true);
    expect(regex.test("10% increased Light Radius of Something")).toBe(false);
  });

  it("classifies every line as demand, filler, situational, local, implicit or unsupported", () => {
    const text = item([
      "Item Class: Rings",
      "Rarity: Rare",
      "Doom Loop",
      "Amethyst Ring",
      "--------",
      "Item Level: 81",
      "--------",
      "+9% to Chaos Resistance (implicit)",
      "--------",
      "+72 to maximum Life",
      "+35 to Accuracy Rating",
      "14% increased Thorns damage",
      "Gain 1.5 Life, -2 Mana and 3 Rage on Hit",
    ]);
    const parsed = parse(text);
    const lines = classifyLines(parsed, appraiseItem(text, { parsed }));
    const byText = Object.fromEntries(lines.map((line) => [line.text, line]));
    expect(byText["+9% to Chaos Resistance"]).toMatchObject({ role: "demand", affix: false, familyId: "chaos-res" });
    expect(byText["+72 to maximum Life"]).toMatchObject({ role: "demand", affix: true, familyId: "life", tier: 3 });
    expect(byText["+35 to Accuracy Rating"]).toMatchObject({ role: "filler", knownId: "accuracy-flat" });
    expect(byText["14% increased Thorns damage"]).toMatchObject({ role: "situational", knownId: "thorns" });
    expect(byText["Gain 1.5 Life, -2 Mana and 3 Rage on Hit"]).toMatchObject({ role: "unsupported", affix: true });
  });

  it("does not read a Gemini Bow's surpassing-arrow implicit as fifty extra arrows", () => {
    expect(matchModFamily("+50% Surpassing chance to fire an additional Arrow")).toBeUndefined();
    expect(matchModFamily("Bow Attacks fire an Additional Arrow")?.family.id).toBe("additional-projectiles");
    expect(matchModFamily("Bow Attacks fire 2 Additional Arrows")?.tier).toBe(1);
    const assessment = assess(fixture("ghoul-thirst-gemini-bow.txt"));
    const implicit = assessment.lines.find((line) => /Surpassing/.test(line.text));
    expect(implicit).toMatchObject({ role: "implicit", affix: false });
  });

  it("keeps thorns out of the jewel damage family", () => {
    expect(matchModFamily("14% increased Thorns damage", { itemClass: "Jewels" })).toBeUndefined();
    expect(matchModFamily("15% increased Cold Damage", { itemClass: "Jewels" })?.family.id).toBe("jewel-damage");
  });
});

describe("weapon reading", () => {
  it("folds PoE2's per-element damage properties into the printed DPS", () => {
    const dps = weaponDps(parse(fixture("ghoul-thirst-gemini-bow.txt")))!;
    // Physical 39-72 and Cold 55-102 at 1.15 attacks per second.
    expect(dps.physicalDps).toBeCloseTo(63.8, 1);
    expect(dps.elementalDps).toBeCloseTo(90.3, 1);
    expect(dps.totalDps).toBeCloseTo(154.1, 1);
    expect(dps.components.map((component) => component.kind)).toEqual(["physical", "cold"]);
    const crossbow = weaponDps(parse(fixture("dragon-core-elegant-crossbow.txt")))!;
    expect(crossbow.totalDps).toBeCloseTo(287.9, 1);
    expect(crossbow.components.some((component) => component.kind === "fire")).toBe(true);
  });

  it("rates a weapon against its class bar and admits the bar is unverified", () => {
    const reading = readWeapon(parse(fixture("rift-edge-soaring-spear.txt")))!;
    expect(reading).toMatchObject({ tier: "usable", usableAt: 160, strongAt: 280, verified: false });
    expect(reading.totalDps).toBeCloseTo(218.4, 1);
    // A class without a bar or a weapon without a damage block is "unknown", never "weak".
    const noBlock = readWeapon(parse(item(["Item Class: Bows", "Rarity: Rare", "Storm Fletch", "Composite Bow", "--------", "Item Level: 82", "--------", "+25 to Accuracy Rating"])))!;
    expect(noBlock.tier).toBe("unknown");
    expect(readWeapon(parse(fixture("rare-body.txt")))).toBeUndefined();
  });
});

describe("pattern matching", () => {
  it("matches the elemental bow pattern on the retained live bow and explains every requirement", () => {
    const assessment = assess(fixture("ghoul-thirst-gemini-bow.txt"));
    expect(assessment.covered).toBe(true);
    expect(assessment.best?.pattern.id).toBe("bow-elemental-strong");
    expect(assessment.best?.met).toHaveLength(3);
    expect(assessment.best?.met.join(" ")).toMatch(/95% increased Elemental Damage with Attacks \(T1\)/);
    expect(assessment.best?.met.join(" ")).toMatch(/total DPS 154\.1 ≥ 150/);
    // The closest chase/strong pattern it fell short of is one requirement away.
    expect(assessment.nearest?.pattern.strength).toMatch(/chase|strong/);
    expect(assessment.nearest?.missing).toHaveLength(1);
    expect(describeMatch(assessment.best!)).toMatch(/^strong — Ice Shot Deadeye/);
  });

  it("orders chase above strong above useful and never matches a pattern for another class", () => {
    const boots = assess(item([
      "Item Class: Boots", "Rarity: Rare", "Gale Track", "Stellar Sandals", "--------", "Item Level: 81", "--------",
      "32% increased Movement Speed", "+112 to maximum Life", "+38% to Fire Resistance", "+35% to Cold Resistance",
    ]));
    expect(boots.matches.map((match) => match.pattern.strength)).toEqual(["chase", "strong", "useful"]);
    expect(boots.best?.pattern.id).toBe("boots-speed-chase");
    const gloves = assess(item([
      "Item Class: Gloves", "Rarity: Rare", "Gale Grip", "Stellar Gloves", "--------", "Item Level: 81", "--------",
      "32% increased Movement Speed",
    ]));
    expect(gloves.matches).toEqual([]);
  });

  it("uses the printed DPS for weapons instead of counting local modifiers twice", () => {
    const highLocal = assess(item([
      "Item Class: Bows", "Rarity: Rare", "Storm Fletch", "Composite Bow", "--------",
      "Physical Damage: 20-40", "Attacks per Second: 1.20", "--------", "Item Level: 82", "--------",
      "142% increased Physical Damage", "26% increased Attack Speed",
    ]));
    // 142% phys and 26% attack speed are already inside the printed 20-40 @ 1.20: 36 DPS is weak.
    expect(highLocal.weapon?.tier).toBe("weak");
    expect(highLocal.matches).toEqual([]);
  });

  it("treats the knowledge as expired after its review date", () => {
    const later = new Date("2026-12-01T00:00:00Z");
    const parsed = parse(fixture("ghoul-thirst-gemini-bow.txt"));
    const assessment = assessDemand(parsed, appraiseItem(fixture("ghoul-thirst-gemini-bow.txt"), { parsed }), { now: later });
    expect(assessment.expired).toBe(true);
    expect(demandConfidence(assessment.best!, assessment)).toBeLessThan(
      demandConfidence(assessment.best!, { expired: false }),
    );
  });

  it("marks uncovered classes and unsupported lines instead of guessing", () => {
    const charm = assess(item(["Item Class: Charms", "Rarity: Magic", "Thawing Charm of the Fox", "--------", "Item Level: 70", "--------", "+3 to Dexterity"]));
    expect(charm.covered).toBe(false);
    const gloves = assess(fixture("rich-affixes.txt"));
    expect(gloves.unsupported).toEqual(["Adds -10 to -5 Cold Damage to Attacks", "Gain 1.5 Life, -2 Mana and 3 Rage on Hit"]);
    expect(gloves.unsupportedImplicits).toContain("Enemies in your Presence are Chilled");
  });
});
