import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractItemMods, parseItemText } from "../src/core/parseItem.js";
import { explainRuleMatch, findNearMisses } from "../src/core/ruleDiagnostics.js";
import {
  compileRules,
  matchItemsAgainstText,
  parseRangeSuffix,
  validateRuleRegex,
} from "../src/core/scanRules.js";
import { buildSearchRegex } from "../src/core/searchRegex.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

describe("rich item parsing", () => {
  it("retains ordered sections, properties, statuses, kinds, and every numeric roll", () => {
    const item = parseItemText(fixture("rich-affixes.txt"));

    expect(item).toMatchObject({
      itemClass: "Gloves",
      rarity: "Rare",
      name: "Ash Grip",
      baseType: "Riveted Mitts",
      itemLevel: 73,
      quality: 20,
      sockets: "S S",
      identified: true,
      corrupted: true,
    });
    expect(item.requirements).toEqual({ Level: 44, Str: 36, Dex: 36 });
    expect(item.sections.map((section) => section.block)).toEqual(
      item.sections.map((_, index) => index),
    );
    expect(item.rawSections[0]).toEqual([
      "Item Class: Gloves",
      "Rarity: Rare",
      "Ash Grip",
      "Riveted Mitts",
    ]);
    expect(item.properties.find((property) => property.name === "Armour")?.values).toEqual([1234]);
    expect(item.defenses.map((property) => property.name)).toEqual(["Armour", "Evasion Rating"]);

    expect(item.mods.map((mod) => mod.kind)).toEqual([
      "implicit",
      "explicit",
      "crafted",
      "fractured",
      "enchant",
    ]);
    expect(item.mods[0]?.tags).toContain("implicit");
    expect(item.mods.map((mod) => mod.order)).toEqual([0, 1, 2, 3, 4]);
    expect(item.modifierBlocks[0]?.mods).toHaveLength(5);
    expect(item.mods[0]).toMatchObject({ value: 12.5, implicit: true });
    expect(item.mods[1]?.values).toEqual([-10, -5]);
    expect(item.mods[3]?.values).toEqual([1.5, -2, 3]);
  });

  it("never treats block-zero identity headers as modifiers", () => {
    const text = [
      "Item Class: Rings",
      "Rarity: Rare",
      "Behemoth Clasp",
      "Gold Ring",
      "--------",
      "+24 to maximum Life",
    ].join("\n");

    expect(extractItemMods(text).map((mod) => mod.text)).toEqual(["+24 to maximum Life"]);
    expect(extractItemMods(text).some((mod) => /Behemoth|Gold Ring|Rarity/.test(mod.text))).toBe(false);
  });
});

describe("canonical scan rules", () => {
  it("keeps OR groups distinct instead of mixing their AND terms", () => {
    const rule = {
      name: "paired groups",
      regex: "maximum Life\nCold Resistance\nOR\nmaximum Mana\nFire Resistance",
    };
    const crossed = "+25 to maximum Life\n+20% to Fire Resistance";
    const matching = "+25 to maximum Mana\n+20% to Fire Resistance";

    expect(matchItemsAgainstText(crossed, [rule])).toHaveLength(0);
    expect(matchItemsAgainstText(matching, [rule])).toHaveLength(1);
    expect(compileRules([rule])[0]?.segments).toEqual([
      ["maximum Life", "Cold Resistance"],
      ["maximum Mana", "Fire Resistance"],
    ]);
  });

  it("distinguishes independent values and explicit averages while preserving legacy Adds rules", () => {
    const line = "Adds 0 to 20 Cold Damage to Attacks";
    const rules = [
      { name: "legacy average", regex: "Adds # to # Cold Damage to Attacks [0-10;0-10]" },
      {
        name: "independent",
        regex: "Adds # to # Cold Damage to Attacks [independent: 0-10; 0-10]",
      },
      { name: "explicit average", regex: "Adds # to # Cold Damage to Attacks [average: 9-11]" },
    ];

    expect(matchItemsAgainstText(line, rules).map((rule) => rule.name)).toEqual([
      "legacy average",
      "explicit average",
    ]);
    expect(parseRangeSuffix(rules[1]!.regex)).toMatchObject({
      semantics: "independent",
      ranges: [
        { min: 0, max: 10 },
        { min: 0, max: 10 },
      ],
    });
  });

  it("matches decimals, negatives, and three independent numeric values", () => {
    const rule = {
      name: "three rolls",
      regex: "Gain # Life, # Mana and # Rage on Hit [independent: 1-2; -3--1; 3-4]",
    };
    expect(matchItemsAgainstText("Gain 1.5 Life, -2 Mana and 3 Rage on Hit", [rule])).toHaveLength(1);
  });

  it("rejects malformed and potentially catastrophic expressions", () => {
    expect(validateRuleRegex("[").valid).toBe(false);
    expect(validateRuleRegex("(a+)+$")).toMatchObject({ valid: false, safe: false });
    expect(
      compileRules([
        { name: "invalid", regex: "[" },
        { name: "unsafe", regex: "(a+)+$" },
      ]),
    ).toEqual([]);
  });

  it("preserves metadata and explains matches and near misses", () => {
    const source = {
      id: "life-cold",
      name: "Life and cold",
      regex: "maximum Life\nCold Resistance",
      tags: ["build"],
      sourceUrl: "https://example.test/rule",
      createdAt: "2026-08-26T00:00:00.000Z",
      schemaVersion: 2,
    };
    const compiled = compileRules([source])[0]!;
    expect(compiled).toMatchObject({
      tags: ["build"],
      sourceUrl: source.sourceUrl,
      schemaVersion: 2,
    });

    const match = explainRuleMatch(compiled, "+20 to maximum Life\n+15% to Cold Resistance");
    expect(match).toMatchObject({ matched: true, matchedSegment: 0, score: 1 });
    expect(match.segments[0]?.terms.every((term) => term.matched)).toBe(true);

    const miss = explainRuleMatch(compiled, "+20 to maximum Life\n+15% to Fire Resistance");
    expect(miss).toMatchObject({
      matched: false,
      nearMiss: true,
      nearestSegment: 0,
      missingTerms: ["Cold Resistance"],
      score: 0.5,
    });
    expect(findNearMisses([compiled], "+20 to maximum Life")).toHaveLength(1);
  });
});

describe("stash search regex generation", () => {
  it("splits over-limit selections without truncating and validates every representative line", () => {
    const result = buildSearchRegex(
      [
        { id: "fire", field: "mod", text: "Adds 4 to 8 Fire Damage to Attacks", match: "numeric" },
        { id: "cold", field: "mod", text: "+17% to Cold Resistance", match: "numeric" },
      ],
      { maxLength: 50 },
    );

    expect(result.conflicts).toEqual([]);
    expect(result.queries).toHaveLength(2);
    expect(result.warnings.some((warning) => /no expression was truncated/i.test(warning))).toBe(true);
    for (const query of result.queries) {
      expect(query.length).toBeLessThanOrEqual(50);
      const regex = new RegExp(query.query, query.flags);
      expect(query.representativeLines.every((line) => regex.test(line))).toBe(true);
    }
  });

  it("keeps an exact boundary expression syntactically valid", () => {
    const line = "x".repeat(50);
    const result = buildSearchRegex([line], { maxLength: 50, quoteForStash: false });

    expect(result.conflicts).toEqual([]);
    expect(result.queries[0]?.query).toHaveLength(50);
    expect(() => new RegExp(result.queries[0]!.query)).not.toThrow();
    expect(new RegExp(result.queries[0]!.query).test(line)).toBe(true);
  });

  it("supports item identity fields and bounded numeric selections", () => {
    const identity = buildSearchRegex({
      item: {
        name: "Ash Grip",
        baseType: "Riveted Mitts",
        itemClass: "Gloves",
        mods: [],
      },
      includeName: true,
      includeBaseType: true,
      includeClass: true,
    });
    expect(identity.conflicts).toEqual([]);
    expect(identity.queries.flatMap((query) => query.selectionIds)).toEqual([
      "item-name",
      "item-base",
      "item-class",
    ]);

    const numeric = buildSearchRegex(
      [
        {
          id: "damage",
          field: "mod",
          text: "Adds 4 to 8 Fire Damage to Attacks",
          match: "numeric",
          numeric: [
            { index: 0, min: 4, max: 6 },
            { index: 1, min: 8, max: 10 },
          ],
        },
      ],
      { maxLength: 100 },
    );
    expect(numeric.conflicts).toEqual([]);
    const query = numeric.queries[0]!;
    expect(new RegExp(query.query, query.flags).test("Adds 6 to 10 Fire Damage to Attacks")).toBe(true);
    expect(new RegExp(query.query, query.flags).test("Adds 7 to 10 Fire Damage to Attacks")).toBe(false);
  });

  it("reports an actionable conflict instead of cutting an indivisible expression", () => {
    const result = buildSearchRegex(["A".repeat(51)], {
      maxLength: 50,
      quoteForStash: false,
    });
    expect(result.queries).toEqual([]);
    expect(result.conflicts[0]).toMatch(/exceeds the 50-character regex budget/i);
  });
});
