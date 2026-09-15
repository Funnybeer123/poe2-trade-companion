import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachAnnotations,
  parseAdvancedItemText,
  parseAnnotationLine,
  stripAdvancedRanges,
} from "../src/core/itemAnnotations.js";
import { parseItemText } from "../src/core/parseItem.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

const lines = (...entries: string[]) => entries.join("\n");

/** The Ctrl+Alt+C copy: annotation lines plus `value(min-max)` ranges. */
const ADVANCED_GLOVES = lines(
  "Item Class: Gloves",
  "Rarity: Rare",
  "Ash Grip",
  "Riveted Mitts",
  "--------",
  "Quality: +12%",
  "Armour: 120(100-140)",
  "--------",
  "Item Level: 73",
  "--------",
  '{ Prefix Modifier "Robust" (Tier: 3) — Life }',
  "+45(40-49) to maximum Life",
  '{ Suffix Modifier "of the Bear" (Tier: 2) — Attribute, Resistance }',
  "+18(15-20) to Strength",
  "+31(25-35)% to Cold Resistance",
  '{ Fractured Prefix Modifier "Glaciated" (Tier: 1) — Cold }',
  "Adds 10(8-12) to 20(18-24) Cold Damage to Attacks (fractured)",
  "+7 to Dexterity (crafted)",
  "--------",
  "Corrupted",
);

describe("parseAnnotationLine", () => {
  it("reads every flag, side, name, tier and tag form", () => {
    expect(parseAnnotationLine("{ Implicit Modifier — Life }")).toEqual({
      kind: "implicit",
      tags: ["Life"],
    });
    expect(parseAnnotationLine('{ Prefix Modifier "Glaciated" (Tier: 3) — Cold }')).toEqual({
      kind: "explicit",
      side: "prefix",
      name: "Glaciated",
      tier: 3,
      tags: ["Cold"],
    });
    expect(parseAnnotationLine("{ Crafted Suffix Modifier — Attribute }")).toEqual({
      kind: "crafted",
      side: "suffix",
      tags: ["Attribute"],
    });
    expect(parseAnnotationLine('{ Desecrated Prefix Modifier "Wretched" — Chaos, Damage }')).toEqual({
      kind: "desecrated",
      side: "prefix",
      name: "Wretched",
      tags: ["Chaos", "Damage"],
    });
    expect(parseAnnotationLine("{ Unique Modifier — Damage }")).toEqual({ kind: "unique", tags: ["Damage"] });
    expect(parseAnnotationLine("{ Enchant Modifier }")).toEqual({ kind: "enchant", tags: [] });
    expect(parseAnnotationLine("{ Rune Modifier — Resistance }")).toEqual({
      kind: "rune",
      tags: ["Resistance"],
    });
  });

  it("accepts a plain hyphen and refuses anything that is not an annotation", () => {
    expect(parseAnnotationLine("{ Implicit Modifier - Life }")).toEqual({
      kind: "implicit",
      tags: ["Life"],
    });
    expect(parseAnnotationLine("  { Suffix Modifier (Tier: 5) }  ")).toEqual({
      kind: "explicit",
      side: "suffix",
      tier: 5,
      tags: [],
    });
    expect(parseAnnotationLine("{ nonsense }")).toBeUndefined();
    expect(parseAnnotationLine("+45 to maximum Life")).toBeUndefined();
    expect(parseAnnotationLine("")).toBeUndefined();
  });
});

describe("stripAdvancedRanges", () => {
  it("puts the rolled value back in the text and records the range", () => {
    expect(stripAdvancedRanges("+45(40-49) to maximum Life")).toEqual({
      text: "+45 to maximum Life",
      ranges: [{ index: 0, value: 45, min: 40, max: 49, kind: "value" }],
    });
  });

  it("handles mixed signs and several ranges on one line", () => {
    expect(stripAdvancedRanges("-17(-40–+40)% to Fire Resistance")).toEqual({
      text: "-17% to Fire Resistance",
      ranges: [{ index: 0, value: -17, min: -40, max: 40, kind: "value" }],
    });
    expect(stripAdvancedRanges("Adds 10(8-12) to 20(18-24) Cold Damage to Attacks")).toEqual({
      text: "Adds 10 to 20 Cold Damage to Attacks",
      ranges: [
        { index: 0, value: 10, min: 8, max: 12, kind: "value" },
        { index: 1, value: 20, min: 18, max: 24, kind: "value" },
      ],
    });
  });

  it("leaves a bare unique range in the text and marks it", () => {
    expect(stripAdvancedRanges("+(150-250)% increased bonuses gained from Equipped Quiver")).toEqual({
      text: "+(150-250)% increased bonuses gained from Equipped Quiver",
      ranges: [{ index: 0, value: 150, min: 150, max: 250, kind: "unique-text" }],
    });
    expect(stripAdvancedRanges("+110 to maximum Life")).toEqual({ text: "+110 to maximum Life", ranges: [] });
  });
});

describe("parseAdvancedItemText", () => {
  it("keeps annotation lines and line numbers while stripping ranges in place", () => {
    const advanced = parseAdvancedItemText(ADVANCED_GLOVES);
    expect(advanced.hasAnnotations).toBe(true);
    expect(advanced.hasRanges).toBe(true);
    expect(advanced.statusFlags).toEqual({
      corrupted: true,
      mirrored: false,
      sanctified: false,
      unidentified: false,
    });
    expect(advanced.annotations.map((entry) => [entry.block, entry.line, entry.kind])).toEqual([
      [3, 10, "explicit"],
      [3, 12, "explicit"],
      [3, 15, "fractured"],
    ]);
    expect(advanced.plainText.split("\n")[6]).toBe("Armour: 120");
    expect(advanced.plainText.split("\n")[16]).toBe("Adds 10 to 20 Cold Damage to Attacks (fractured)");
    expect(advanced.ranges.filter((range) => range.line === 16)).toEqual([
      { line: 16, index: 0, value: 10, min: 8, max: 12, kind: "value" },
      { line: 16, index: 1, value: 20, min: 18, max: 24, kind: "value" },
    ]);

    // The parser reads the stripped text and still reports the original lines.
    const parsed = parseItemText(advanced.plainText);
    expect(parsed.mods.map((mod) => mod.line)).toEqual([11, 13, 14, 16, 17]);
    expect(parsed.quality).toBe(12);
  });

  it("reads the shipped rich-affixes fixture, CRLF and em dashes included", () => {
    const advanced = parseAdvancedItemText(fixture("rich-affixes.txt"));
    expect(advanced.annotations).toHaveLength(3);
    expect(advanced.annotations.map((entry) => entry.line)).toEqual([18, 20, 22]);
    expect(advanced.annotations.every((entry) => entry.block === 5)).toBe(true);
    expect(advanced.annotations[1]).toEqual({
      block: 5,
      line: 20,
      kind: "explicit",
      side: "prefix",
      name: "Glaciated",
      tier: 3,
      tags: ["Cold"],
    });
    expect(advanced.statusFlags.corrupted).toBe(true);
    expect(advanced.hasRanges).toBe(false);
  });

  it("returns an ordinary copy unchanged", () => {
    const raw = fixture("rare-body.txt");
    const advanced = parseAdvancedItemText(raw);
    expect(advanced.hasAnnotations).toBe(false);
    expect(advanced.hasRanges).toBe(false);
    expect(advanced.annotations).toEqual([]);
    expect(advanced.ranges).toEqual([]);
    expect(advanced.plainText).toBe(raw.replace(/\r\n/g, "\n"));
  });
});

describe("attachAnnotations", () => {
  it("binds each mod to the annotation above it and shares a group index", () => {
    const advanced = parseAdvancedItemText(ADVANCED_GLOVES);
    const annotated = attachAnnotations(parseItemText(advanced.plainText), advanced);
    expect(
      annotated.map((entry) => [entry.mod.text, entry.annotation?.name ?? null, entry.groupIndex ?? null]),
    ).toEqual([
      ["+45 to maximum Life", "Robust", 0],
      ["+18 to Strength", "of the Bear", 1],
      ["+31% to Cold Resistance", "of the Bear", 1],
      ["Adds 10 to 20 Cold Damage to Attacks", "Glaciated", 2],
      // A trailing (crafted) tag disagrees with the fractured annotation.
      ["+7 to Dexterity", null, null],
    ]);
    expect(annotated[0]!.ranges).toEqual([{ index: 0, value: 45, min: 40, max: 49, kind: "value" }]);
    expect(annotated[3]!.ranges).toHaveLength(2);
    expect(annotated[4]!.ranges).toEqual([]);
  });

  it("reproduces the rich-affixes worked example", () => {
    const advanced = parseAdvancedItemText(fixture("rich-affixes.txt"));
    const annotated = attachAnnotations(parseItemText(advanced.plainText), advanced);
    expect(annotated.map((entry) => [entry.mod.text, entry.annotation?.kind ?? null])).toEqual([
      ["+12.5 to maximum Life", "implicit"],
      ["Adds -10 to -5 Cold Damage to Attacks", "explicit"],
      ["+7 to Strength", "crafted"],
      // (fractured) ≠ crafted unbinds this line and everything after it.
      ["Gain 1.5 Life, -2 Mana and 3 Rage on Hit", null],
      ["Enemies in your Presence are Chilled", null],
    ]);
    expect(annotated[1]!.annotation?.side).toBe("prefix");
    expect(annotated[2]!.annotation?.side).toBe("suffix");
  });

  it("leaves every mod unbound for an ordinary copy", () => {
    const raw = fixture("rare-body.txt");
    const advanced = parseAdvancedItemText(raw);
    const annotated = attachAnnotations(parseItemText(advanced.plainText), advanced);
    expect(annotated).toHaveLength(4);
    expect(annotated.every((entry) => entry.annotation === undefined && entry.ranges.length === 0)).toBe(true);
  });
});
