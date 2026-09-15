import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  affixLimitsFor,
  attributeElements,
  defenceSummary,
  gemLevelOf,
  isLowerIsBetter,
  isWeaponClass,
  LOWER_IS_BETTER,
  mapItemKind,
  normaliseToQuality,
  openAffixCount,
  requiredLevel,
  runeSocketCount,
  statusFlags,
  weaponDps,
} from "../src/core/itemStats.js";
import { parseItemText } from "../src/core/parseItem.js";
import type { ItemMod } from "../src/core/types.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

const lines = (...entries: string[]) => entries.join("\n");

/** P5 §7.G worked example: 30-50 physical, fire 12-24, lightning 5-60, 1.40 aps, Q12. */
const BOW_ELEMENTAL = lines(
  "Item Class: Bows",
  "Rarity: Rare",
  "Storm Arc",
  "Recurve Bow",
  "--------",
  "Quality: +12%",
  "Physical Damage: 30-50 (augmented)",
  "Elemental Damage: 12-24 (augmented), 5-60 (augmented)",
  "Critical Hit Chance: 6.50%",
  "Attacks per Second: 1.40",
  "--------",
  "Requirements:",
  "Level: 45",
  "Dex: 100",
  "--------",
  "Item Level: 78",
  "--------",
  "Adds 12 to 24 Fire Damage",
  "Adds 5 to 60 Lightning Damage",
  "+25 to maximum Life",
);

describe("isWeaponClass", () => {
  it("knows the PoE2 weapon classes and refuses armour and jewellery", () => {
    expect(isWeaponClass("Bows")).toBe(true);
    expect(isWeaponClass("quarterstaves")).toBe(true);
    expect(isWeaponClass("One Hand Maces")).toBe(true);
    expect(isWeaponClass("Crossbows")).toBe(true);
    expect(isWeaponClass("Body Armours")).toBe(false);
    expect(isWeaponClass("Rings")).toBe(false);
    expect(isWeaponClass("")).toBe(false);
  });
});

describe("weaponDps", () => {
  it("reproduces the bow worked example, including the Q20 estimate", () => {
    const dps = weaponDps(parseItemText(BOW_ELEMENTAL))!;
    expect(dps.aps).toBe(1.4);
    expect(dps.quality).toBe(12);
    expect(dps.critChance).toBe(6.5);
    expect(dps.reloadTime).toBeUndefined();
    expect(dps.components).toEqual([
      { kind: "physical", min: 30, max: 50, average: 40, dps: 56 },
      { kind: "fire", min: 12, max: 24, average: 18, dps: 25.2 },
      { kind: "lightning", min: 5, max: 60, average: 32.5, dps: 45.5 },
    ]);
    expect(dps.physicalDps).toBe(56);
    expect(dps.elementalDps).toBe(70.7);
    expect(dps.chaosDps).toBe(0);
    expect(dps.totalDps).toBe(126.7);
    expect(dps.atQuality20).toEqual({ physicalDps: 60, totalDps: 130.7, exact: false });
    expect(dps.notes).toContain("Q20 assumes no local % physical modifier — an estimate");
  });

  it("folds PoE2's per-element damage lines (Cold Damage: 55-102 (cold)) into the DPS", () => {
    // Live bag copies (2026-09-15) print a single element as its own
    // property instead of a combined Elemental Damage line.
    const dps = weaponDps(parseItemText(fixture("ghoul-thirst-gemini-bow.txt")))!;
    expect(dps.components.map((component) => component.kind)).toEqual(["physical", "cold"]);
    expect(dps.physicalDps).toBe(63.8);
    expect(dps.elementalDps).toBe(90.3);
    expect(dps.totalDps).toBe(154.1);
    const crossbow = weaponDps(parseItemText(fixture("dragon-core-elegant-crossbow.txt")))!;
    expect(crossbow.components.map((component) => component.kind)).toEqual(["physical", "fire"]);
    expect(crossbow.totalDps).toBe(287.9);
    expect(crossbow.reloadTime).toBe(0.85);
  });

  it("uses the printed physical damage of a unique bow with no elemental line", () => {
    const dps = weaponDps(parseItemText(fixture("unique-bow.txt")))!;
    expect(dps.physicalDps).toBe(8.4);
    expect(dps.elementalDps).toBe(0);
    expect(dps.totalDps).toBe(8.4);
    expect(dps.components.map((component) => component.kind)).toEqual(["physical"]);
  });

  it("falls back to per-hit numbers when the item prints no attack rate", () => {
    const dps = weaponDps(
      parseItemText(
        lines(
          "Item Class: Wands",
          "Rarity: Normal",
          "Attuned Wand",
          "--------",
          "Quality: +20%",
          "Physical Damage: 10-20",
          "--------",
          "Item Level: 60",
        ),
      ),
    )!;
    expect(dps.aps).toBe(1);
    expect(dps.physicalDps).toBe(15);
    expect(dps.atQuality20).toBeUndefined();
    expect(dps.notes).toContain("no Attacks per Second line — per-hit only");
  });

  it("reports a crossbow's reload time without folding it into DPS", () => {
    const dps = weaponDps(
      parseItemText(
        lines(
          "Item Class: Crossbows",
          "Rarity: Rare",
          "Gloom Volley",
          "Tense Crossbow",
          "--------",
          "Quality: +20%",
          "Physical Damage: 40-60",
          "Reload Time: 0.75",
          "Attacks per Second: 1.60",
          "--------",
          "Item Level: 80",
        ),
      ),
    )!;
    expect(dps.reloadTime).toBe(0.75);
    expect(dps.physicalDps).toBe(80);
    expect(dps.totalDps).toBe(80);
    expect(dps.notes).toContain("reload time is reported, not folded into DPS");
  });

  it("adds a chaos component and returns undefined for items with no damage line", () => {
    const dps = weaponDps(
      parseItemText(
        lines(
          "Item Class: Daggers",
          "Rarity: Rare",
          "Vile Edge",
          "Stiletto",
          "--------",
          "Quality: +20%",
          "Physical Damage: 10-14",
          "Chaos Damage: 20-30",
          "Attacks per Second: 2.00",
          "--------",
          "Item Level: 80",
        ),
      ),
    )!;
    expect(dps.chaosDps).toBe(50);
    expect(dps.totalDps).toBe(74);
    expect(dps.components.at(-1)).toEqual({ kind: "chaos", min: 20, max: 30, average: 25, dps: 50 });

    expect(weaponDps(parseItemText(fixture("rare-body.txt")))).toBeUndefined();
    expect(weaponDps(parseItemText(fixture("exalted.txt")))).toBeUndefined();
  });
});

describe("attributeElements", () => {
  const mod = (text: string): ItemMod => ({ text });

  it("matches each printed pair to the modifier that produced it", () => {
    expect(
      attributeElements(
        [
          [12, 24],
          [5, 60],
        ],
        [mod("Adds 12 to 24 Fire Damage"), mod("Adds 5 to 60 Lightning Damage")],
      ),
    ).toEqual([
      { kind: "fire", min: 12, max: 24, average: 18, dps: 18 },
      { kind: "lightning", min: 5, max: 60, average: 32.5, dps: 32.5 },
    ]);
  });

  it("sums two modifiers of the same element and ignores spell damage", () => {
    expect(
      attributeElements(
        [[20, 40]],
        [
          mod("Adds 5 to 10 Fire Damage to Attacks"),
          mod("Adds 15 to 30 Fire Damage"),
          mod("Adds 90 to 99 Cold Damage to Spells"),
        ],
      ),
    ).toEqual([{ kind: "fire", min: 20, max: 40, average: 30, dps: 30 }]);
  });

  it("leaves an unexplained pair unknown and returns undefined without pairs", () => {
    expect(attributeElements([[7, 9]], [])).toEqual([
      { kind: "elemental-unknown", min: 7, max: 9, average: 8, dps: 8 },
    ]);
    expect(attributeElements([], [mod("Adds 1 to 2 Fire Damage")])).toBeUndefined();
  });
});

describe("defenceSummary and normaliseToQuality", () => {
  it("normalises every defence to 20 % quality and keeps a Q20 item as printed", () => {
    const q12 = defenceSummary(
      parseItemText(
        lines(
          "Item Class: Body Armours",
          "Rarity: Rare",
          "Dusk Mantle",
          "Advanced Maraketh Coat",
          "--------",
          "Quality: +12%",
          "Armour: 412",
          "Energy Shield: 100",
          "Block chance: 25%",
          "--------",
          "Item Level: 82",
        ),
      ),
    )!;
    expect(q12.quality).toBe(12);
    expect(q12.exact).toBe(false);
    expect(q12.entries).toEqual([
      { name: "Armour", value: 412, atQuality20: 441.4 },
      { name: "Energy Shield", value: 100, atQuality20: 107.1 },
    ]);
    expect(q12.blockChance).toBe(25);

    const q20 = defenceSummary(parseItemText(fixture("rare-body.txt")))!;
    expect(q20.entries).toEqual([
      { name: "Armour", value: 412 },
      { name: "Evasion Rating", value: 380 },
    ]);
    expect(q20.blockChance).toBeUndefined();
  });

  it("reads comma-grouped and decimal defences, and skips items with none", () => {
    const rich = defenceSummary(parseItemText(fixture("rich-affixes.txt")))!;
    expect(rich.entries.map((entry) => entry.value)).toEqual([1234, 98.5]);
    expect(defenceSummary(parseItemText(fixture("exalted.txt")))).toBeUndefined();
  });

  it("scales to the target quality to one decimal", () => {
    expect(normaliseToQuality(412, 12)).toBe(441.4);
    expect(normaliseToQuality(100, 0)).toBe(120);
    expect(normaliseToQuality(100, 20)).toBe(100);
    expect(normaliseToQuality(100, 0, 30)).toBe(130);
  });
});

describe("statusFlags", () => {
  it("reads the raw status lines, which the parser turns into mods", () => {
    expect(statusFlags(parseItemText(fixture("rich-affixes.txt")))).toEqual({
      corrupted: true,
      mirrored: false,
      sanctified: false,
      unidentified: false,
    });
    expect(
      statusFlags(
        parseItemText(
          lines(
            "Item Class: Rings",
            "Rarity: Rare",
            "Doom Loop",
            "Ruby Ring",
            "--------",
            "Item Level: 81",
            "--------",
            "Unidentified",
            "--------",
            "Mirrored",
          ),
        ),
      ),
    ).toEqual({ corrupted: false, mirrored: true, sanctified: false, unidentified: true });
  });
});

describe("requiredLevel, runeSocketCount and gemLevelOf", () => {
  it("reads the requirements block and the one-line form", () => {
    expect(requiredLevel(parseItemText(fixture("rare-body.txt")))).toBe(62);
    expect(
      requiredLevel(
        parseItemText(
          lines(
            "Item Class: Jewels",
            "Rarity: Rare",
            "Hypnotic Joy",
            "Ruby",
            "--------",
            "Requires Level 45",
            "--------",
            "Item Level: 80",
          ),
        ),
      ),
    ).toBe(45);
    expect(requiredLevel(parseItemText(fixture("exalted.txt")))).toBeUndefined();
  });

  it("counts rune sockets and reads a gem's level, never a requirement", () => {
    expect(runeSocketCount(parseItemText(fixture("rare-body.txt")))).toBe(2);
    expect(runeSocketCount(parseItemText(fixture("unique-bow.txt")))).toBeUndefined();

    const gem = parseItemText(
      lines(
        "Item Class: Skill Gems",
        "Rarity: Gem",
        "Lightning Arrow",
        "--------",
        "Level: 20 (Max)",
        "Cost: 8 Mana",
        "--------",
        "Requirements:",
        "Level: 70",
        "Int: 60",
        "--------",
        "Fires an arrow that strikes the target.",
      ),
    );
    expect(gemLevelOf(gem)).toBe(20);
    expect(gemLevelOf(parseItemText(fixture("rare-body.txt")))).toBeUndefined();
  });
});

describe("affixLimitsFor and openAffixCount", () => {
  it("applies the P5 affix-limit table, rarity first", () => {
    expect(affixLimitsFor("Body Armours", "Rare")).toEqual({ prefixes: 3, suffixes: 3 });
    expect(affixLimitsFor("Body Armours", "Magic")).toEqual({ prefixes: 1, suffixes: 1 });
    expect(affixLimitsFor("Body Armours", "Normal")).toEqual({ prefixes: 0, suffixes: 0 });
    expect(affixLimitsFor("Bows", "Unique")).toEqual({ prefixes: 0, suffixes: 0 });
    expect(affixLimitsFor("Jewels", "Rare")).toEqual({ prefixes: 2, suffixes: 2 });
    expect(affixLimitsFor("Tablet", "Rare")).toEqual({ prefixes: 2, suffixes: 2 });
    expect(affixLimitsFor("Life Flasks", "Magic")).toEqual({ prefixes: 1, suffixes: 1 });
    expect(affixLimitsFor("Charms", "Rare")).toEqual({ prefixes: 1, suffixes: 1 });
  });

  it("counts affix lines against the budget and seals corrupted items", () => {
    expect(openAffixCount(parseItemText(fixture("rare-body.txt")))).toEqual({
      affixCount: 4,
      maxAffixes: 6,
      open: 2,
    });
    expect(openAffixCount(parseItemText(fixture("rich-affixes.txt")))).toEqual({
      affixCount: 3,
      maxAffixes: 6,
      open: 0,
      sealedReason: "corrupted",
    });
  });

  it("counts duplicate lines, caps magic at two and a tablet at four", () => {
    const duplicated = parseItemText(
      lines(
        "Item Class: Rings",
        "Rarity: Rare",
        "Doom Loop",
        "Ruby Ring",
        "--------",
        "Item Level: 81",
        "--------",
        "+28% to Fire Resistance",
        "+28% to Fire Resistance",
      ),
    );
    expect(openAffixCount(duplicated)).toEqual({ affixCount: 2, maxAffixes: 6, open: 4 });

    const magic = parseItemText(
      lines(
        "Item Class: Rings",
        "Rarity: Magic",
        "Sapphire Ring of the Mage",
        "--------",
        "Item Level: 60",
        "--------",
        "+20% to Cold Resistance",
      ),
    );
    expect(openAffixCount(magic)).toEqual({ affixCount: 1, maxAffixes: 2, open: 1 });

    const tablet = parseItemText(
      lines(
        "Item Class: Tablet",
        "Rarity: Rare",
        "Grim Vision",
        "Precursor Tablet",
        "--------",
        "Item Level: 80",
        "--------",
        "8% increased Quantity of Items found in your Maps",
      ),
    );
    expect(openAffixCount(tablet)).toEqual({ affixCount: 1, maxAffixes: 4, open: 3 });
  });

  it("seals a mirrored item even when its affix budget is not full", () => {
    const mirrored = parseItemText(
      lines(
        "Item Class: Rings",
        "Rarity: Rare",
        "Doom Loop",
        "Ruby Ring",
        "--------",
        "Item Level: 81",
        "--------",
        "+28% to Fire Resistance",
        "--------",
        "Mirrored",
      ),
    );
    expect(openAffixCount(mirrored)).toMatchObject({ open: 0, sealedReason: "mirrored" });
  });
});

describe("LOWER_IS_BETTER", () => {
  it("matches every authored penalty text and nothing else", () => {
    const penalties = [
      "15% Movement Speed Penalty",
      "5% less Movement Speed",
      "3% reduced Movement Speed",
      "20% increased Charges per use",
      "10% reduced Charm Effect Duration",
      "+12 Physical Damage taken from Attack Hits",
      "Enemies Gain 10% of Physical Damage as Extra Chaos Damage",
      "Take 40% of damage from Blocked Hits",
      "25% increased Slowing Potency of Debuffs on You",
      "15% reduced Rarity of Items found",
      "Traps deal 30% reduced Damage",
    ];
    for (const text of penalties) expect(isLowerIsBetter(text)).toBe(true);
    expect(LOWER_IS_BETTER).toHaveLength(penalties.length);

    expect(isLowerIsBetter("+28% to Fire Resistance")).toBe(false);
    expect(isLowerIsBetter("30% increased Movement Speed")).toBe(false);
    expect(isLowerIsBetter("+110 to maximum Life")).toBe(false);
  });
});

describe("mapItemKind", () => {
  it("separates waystones, tablets and everything else", () => {
    expect(mapItemKind({ itemClass: "Waystones", baseType: "Fortress Waystone" })).toBe("waystone");
    expect(mapItemKind({ itemClass: "Maps", baseType: "Waystone (Tier 15)" })).toBe("waystone");
    expect(mapItemKind({ itemClass: "Tablet", baseType: "Precursor Tablet" })).toBe("tablet");
    expect(mapItemKind({ itemClass: "Maps", baseType: "Overseer Precursor Tablet" })).toBe("tablet");
    expect(mapItemKind({ itemClass: "Body Armours", baseType: "Advanced Maraketh Coat" })).toBeUndefined();
  });
});
