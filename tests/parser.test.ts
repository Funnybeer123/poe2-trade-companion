import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractItemMods, parseItemText } from "../src/core/parseItem.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

describe("item parser", () => {
  it("keeps advanced unique effects and preserves multiline flavour separately", () => {
    const raw = ["Item Class: Rings", "Rarity: Unique", "Thief's Torment", "Emerald Ring", "--------", "Item Level: 80", "--------",
      "{ Implicit Modifier — Attack }", "+133(120-160) to Accuracy Rating", "--------",
      "{ Unique Modifier }", "Can't use other Rings — Unscalable Value",
      "{ Unique Modifier — Caster, Curse }", "50% reduced Duration of Curses on you",
      "{ Unique Modifier — Life, Attack }", "Gain 25 Life per Enemy Hit with Attacks",
      "{ Unique Modifier — Mana, Attack }", "Gain 15 Mana per Enemy Hit with Attacks",
      "{ Unique Modifier — Elemental, Resistance }", "+11(10-15)% to all Elemental Resistances",
      "{ Unique Modifier }", "39(30-40)% increased Rarity of Items found", "--------",
      "The ring I stole,", "My finger they took,", "A shrouded mind,", "Cut their curses short,", "As I drained their spirit",
      "And stole their soul.", "A blessing is often a curse."].join("\n");
    const parsed = parseItemText(raw);
    expect(parsed.mods.map(mod => mod.text)).toEqual(["+133 to Accuracy Rating", "Can't use other Rings",
      "50% reduced Duration of Curses on you", "Gain 25 Life per Enemy Hit with Attacks", "Gain 15 Mana per Enemy Hit with Attacks",
      "+11% to all Elemental Resistances", "39% increased Rarity of Items found"]);
    expect(parsed.mods.map(mod => mod.kind)).toEqual(["implicit", ...Array(6).fill("explicit")]);
    expect(parsed.mods[1]?.rawText).toBe("Can't use other Rings — Unscalable Value");
    expect(parsed.rawText).toBe(raw);
    expect(parsed.sections.at(-1)?.rawText).toContain("The ring I stole,");
    expect(parsed.sections.at(-1)?.mods).toEqual([]);
    expect(extractItemMods(raw)).toEqual(parsed.mods);
  });

  it("trusts unique modifier annotations for punctuation and keeps unannotated legacy behavior", () => {
    const header = "Item Class: Rings\nRarity: Unique\nTest Ring\nEmerald Ring\n--------\n";
    const annotated = parseItemText(`${header}{ Unique Modifier }\nSkills fire an additional Projectile.\nGranted effect: Test\n--------\nFlavour line without punctuation`);
    expect(annotated.mods.map(mod => mod.text)).toEqual(["Skills fire an additional Projectile.", "Granted effect: Test"]);
    const legacy = parseItemText(`${header}Can't use other Rings — Unscalable Value\n--------\nLegacy line without punctuation`);
    expect(legacy.mods.map(mod => mod.text)).toEqual(["Can't use other Rings — Unscalable Value", "Legacy line without punctuation"]);
  });

  it("uses actual advanced-copy rolls while preserving ranges and annotations in raw text", () => {
    const raw = ["Item Class: Jewels", "Rarity: Magic", "Test Sapphire", "--------", "Item Level: 82", "--------",
      '{ Prefix Modifier "Test" (Tier: 1) — Life }', "6(4-6)% increased maximum Life",
      '{ Suffix Modifier "of Test" (Tier: 1) }', "0.6(0.4–0.6)% of Physical Damage Leeched as Life",
      "Adds 12(10-15) to 24(20-30) Fire Damage", "-10(-15--5)% to Fire Resistance"].join("\n");
    const parsed = parseItemText(raw);
    expect(parsed.rawText).toBe(raw);
    expect(parsed.mods.map(mod => mod.text)).toEqual(["6% increased maximum Life",
      "0.6% of Physical Damage Leeched as Life", "Adds 12 to 24 Fire Damage", "-10% to Fire Resistance"]);
    expect(parsed.mods.map(mod => mod.values)).toEqual([[6], [0.6], [12, 24], [-10]]);
    expect(parsed.mods[0]?.rawText).toBe("6(4-6)% increased maximum Life");
    expect(parsed.mods[0]?.kind).toBe("explicit");
  });

  it("parses rare body armour", () => {
    const item = parseItemText(fixture("rare-body.txt"));
    expect(item.itemClass).toBe("Body Armours");
    expect(item.rarity).toBe("Rare");
    expect(item.name).toBe("Storm Veil");
    expect(item.baseType).toBe("Advanced Maraketh Coat");
    expect(item.itemLevel).toBe(82);
    expect(item.quality).toBe(20);
    expect(item.requirements.Level).toBe(62);
    expect(item.mods.length).toBeGreaterThanOrEqual(3);
    expect(item.fingerprint).toHaveLength(16);
  });

  it("parses currency and uniques", () => {
    const orb = parseItemText(fixture("exalted.txt"));
    expect(orb.itemClass).toBe("Currency");
    const bow = parseItemText(fixture("unique-bow.txt"));
    expect(bow.rarity).toBe("Unique");
    expect(bow.name).toBe("Widowhail");
  });

  it("reads name and base type from the header only, ignoring implicit blocks", () => {
    const item = parseItemText(fixture("poe2-amulet.txt"));
    expect(item.itemClass).toBe("Amulets");
    expect(item.name).toBe("Soul Thread");
    expect(item.baseType).toBe("Stellar Amulet");
    expect(item.itemLevel).toBe(67);
  });
});
