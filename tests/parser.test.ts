import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAffixMod, parseItemText } from "../src/core/parseItem.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

describe("item parser", () => {
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

describe("rune and desecrated mod tags", () => {
  const text = [
    "Item Class: Boots",
    "Rarity: Rare",
    "Gale Stride",
    "Advanced Steeltoe Boots",
    "--------",
    "Sockets: S",
    "--------",
    "Item Level: 80",
    "--------",
    "+20% to Fire Resistance (rune)",
    "--------",
    "30% increased Movement Speed",
    "+95 to maximum Life",
    "+31% to Cold Resistance (desecrated)",
  ].join("\n");

  it("strips the tags, keeps the kinds, and treats only slot-occupying mods as affixes", () => {
    const item = parseItemText(text);
    const byText = new Map(item.mods.map((mod) => [mod.text, mod]));
    expect(byText.get("+20% to Fire Resistance")?.kind).toBe("rune");
    expect(byText.get("+31% to Cold Resistance")?.kind).toBe("desecrated");
    expect(byText.get("30% increased Movement Speed")?.kind).toBe("explicit");
    expect(item.mods.filter(isAffixMod).map((mod) => mod.text)).toEqual([
      "30% increased Movement Speed",
      "+95 to maximum Life",
      "+31% to Cold Resistance",
    ]);
  });

  it("does not treat implicits or enchants as affixes either", () => {
    expect(isAffixMod({ kind: "implicit", implicit: true })).toBe(false);
    expect(isAffixMod({ kind: "enchant" })).toBe(false);
    expect(isAffixMod({ kind: "crafted" })).toBe(true);
    expect(isAffixMod({ kind: "fractured" })).toBe(true);
    expect(isAffixMod({})).toBe(true);
  });
});
