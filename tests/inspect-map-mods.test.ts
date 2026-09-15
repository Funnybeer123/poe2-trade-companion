import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileMapModPattern,
  isMapBonusLine,
  mapItemKind,
  mapWarnings,
  matchMapMod,
  severityAtLeast,
  waystoneTier,
  type MapModSeverity,
} from "../src/core/inspectMapMods.js";
import { DANGEROUS_MAP_MODS, MAP_MOD_TABLE_VERSION } from "../src/data/inspect/dangerousMapMods.js";
import { parseItemText } from "../src/core/parseItem.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/inspect/${name}`, import.meta.url), "utf8");
}

/**
 * One in-game wording per table entry. The point is not that the game
 * prints exactly this (the table is unverified), but that every pattern
 * compiles and claims the line it was written for and no earlier entry
 * steals it.
 */
const EXAMPLES: Record<string, string> = {
  "players-minus-max-res": "Players have -12% to all Maximum Resistances",
  "players-minus-res": "Players have -30% to Fire Resistances",
  "no-regen": "Players cannot regenerate Life, Mana or Energy Shield",
  "less-recovery": "Players have 40% less Recovery Rate of Life and Energy Shield",
  "less-recovery-mana": "Players have 30% less Recovery Rate of Mana",
  "monsters-extra-damage": "Monsters deal 31% extra damage as Fire",
  "monsters-phys-as-extra": "Monsters gain 25% of their Physical Damage as Extra Cold Damage",
  "more-monster-damage": "35% more Monster Damage",
  "monster-crit-chance": "Monsters have 200% increased Critical Hit Chance",
  "monster-crit-damage": "+40% to Monster Critical Damage Bonus",
  "monster-projectiles": "Monsters fire 2 additional Projectiles",
  "monster-aoe": "Monsters have 40% increased Area of Effect",
  "monster-attack-speed": "Monsters have 45% increased Attack Speed",
  "monster-cast-speed": "Monsters have 35% increased Cast Speed",
  "monster-movement-speed": "Monsters have 20% increased Movement Speed",
  "monster-accuracy": "Monsters have 60% increased Accuracy Rating",
  "monster-poison": "Monsters Poison on Hit",
  "monster-ailments": "Monsters have 40% chance to Ignite on Hit",
  "monster-ailment-magnitude": "Monsters have 50% increased Freeze Buildup",
  "monster-stun": "Monsters have 50% increased Stun Buildup",
  "monster-armour-break": "Monsters Break Armour",
  "monster-ele-res": "Monsters have +40% to all Elemental Resistances",
  "monster-chaos-res": "Monsters have +40% to Chaos Resistance",
  "monster-ailment-avoid": "Monsters have 60% chance to Avoid Elemental Ailments",
  "monster-life": "Monsters have 40% increased Life",
  "monster-es": "Monsters gain 20% of Maximum Life as Extra Maximum Energy Shield",
  "monster-reduced-crit-taken": "Monsters take 60% reduced Extra Damage from Critical Hits",
  "monster-block": "Monsters have +30% chance to Block",
  "monster-cannot-stun": "Monsters cannot be Stunned",
  "rare-extra-mods": "Rare Monsters have 1 additional Modifier",
  "rare-more-life": "Rare Monsters have 60% increased Life",
  "boss-damage": "Unique Boss deals 25% increased Damage",
  "boss-life": "Unique Boss has 40% increased Life",
  "boss-speed": "Unique Boss has 20% increased Attack Speed",
  "players-cursed": "Players are Cursed with Temporal Chains",
  "players-less-block": "Players have 30% less Chance to Block",
  "players-less-armour": "Players have 40% less Armour",
  "players-less-evasion": "Players have 40% less Evasion Rating",
  "players-less-accuracy": "Players have 25% reduced Accuracy Rating",
  "players-less-cooldown": "Players have 20% reduced Cooldown Recovery Rate",
  "players-flask-charges": "Players gain 30% reduced Flask Charges",
  "players-marked-for-death": "Players are Marked for Death for 5 seconds after killing a Rare or Unique Monster",
  "ground-effects": "Area has patches of Burning Ground",
  "area-additional-rares": "Area contains 30% more Rare Monsters",
  "area-monster-pack-size": "25% increased Monster Pack Size",
};

describe("the dangerous map modifier table", () => {
  it("has a version, unique ids and is honest about being unverified", () => {
    expect(MAP_MOD_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ids = DANGEROUS_MAP_MODS.map((mod) => mod.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mod of DANGEROUS_MAP_MODS) {
      expect(mod.verified).toBe(false);
      expect(mod.label.length).toBeGreaterThan(0);
      expect(mod.reason.length).toBeGreaterThan(0);
      expect(mod.tags.length).toBeGreaterThan(0);
      expect(["deadly", "dangerous", "caution", "info"]).toContain(mod.severity);
      expect(/^[a-z0-9-]{1,64}$/.test(mod.id)).toBe(true);
    }
  });

  it("compiles every pattern and matches its own example line", () => {
    for (const mod of DANGEROUS_MAP_MODS) {
      const example = EXAMPLES[mod.id];
      expect(example, `no example line for ${mod.id}`).toBeTruthy();
      expect(compileMapModPattern(mod.pattern).test(example!)).toBe(true);
      expect(matchMapMod(example!)?.mod.id).toBe(mod.id);
    }
  });

  it("leaves unknown wording unmatched", () => {
    expect(matchMapMod("Monsters spit out clouds of impossible geometry")).toBeUndefined();
    expect(matchMapMod("   ")).toBeUndefined();
  });
});

describe("mapItemKind, waystoneTier and bonus lines", () => {
  it("recognises waystones and tablets only", () => {
    expect(mapItemKind(parseItemText(fixture("waystone-t15-deadly.txt")))).toBe("waystone");
    expect(mapItemKind(parseItemText(fixture("tablet-precursor.txt")))).toBe("tablet");
    expect(mapItemKind(parseItemText(fixture("armour-quality-12.txt")))).toBeUndefined();
  });

  it("reads the tier from the base type and from the printed property", () => {
    expect(waystoneTier(parseItemText(fixture("waystone-t15-deadly.txt")))).toBe(15);
    expect(waystoneTier(parseItemText(fixture("waystone-t3-clean.txt")))).toBe(3);
    expect(waystoneTier(parseItemText(fixture("armour-quality-12.txt")))).toBeUndefined();
  });

  it("knows the reward lines from the modifier lines", () => {
    expect(isMapBonusLine("Item Rarity: +32%")).toBe(true);
    expect(isMapBonusLine("Waystone Tier: 15")).toBe(true);
    expect(isMapBonusLine("Players have -12% to all Maximum Resistances")).toBe(false);
  });
});

describe("mapWarnings", () => {
  const waystone = parseItemText(fixture("waystone-t15-deadly.txt"));

  it("rates a T15 waystone, lists its rewards and keeps unknown lines visible", () => {
    const report = mapWarnings(waystone)!;
    expect(report.itemKind).toBe("waystone");
    expect(report.tier).toBe(15);
    expect(report.overall).toBe("deadly");
    expect(report.verified).toBe(false);
    expect(report.warnings.map((warning) => warning.id)).toEqual([
      "players-minus-max-res",
      "monsters-extra-damage",
      "monster-attack-speed",
      "rare-extra-mods",
      "area-additional-rares",
    ]);
    expect(report.warnings[0]!.values).toEqual([-12]);
    expect(report.bonuses).toEqual([
      { name: "Item Quantity", value: "+64%" },
      { name: "Item Rarity", value: "+32%" },
      { name: "Monster Pack Size", value: "+25%" },
    ]);
    expect(report.unmatched).toEqual(["Monsters spit out clouds of impossible geometry"]);
    expect(report.ignored).toBe(0);
  });

  it("honours an ignore override and a re-rating", () => {
    const ignored = mapWarnings(waystone, { overrides: { "monster-attack-speed": "ignore" } })!;
    expect(ignored.ignored).toBe(1);
    expect(ignored.warnings.map((warning) => warning.id)).not.toContain("monster-attack-speed");
    expect(ignored.overall).toBe("deadly");

    const softened = mapWarnings(waystone, { overrides: { "players-minus-max-res": "caution" } })!;
    expect(softened.overall).toBe("dangerous");
    expect(softened.warnings[0]).toMatchObject({ severity: "caution", overridden: true });
  });

  it("answers 'none' for a waystone with no modifiers and undefined for a non-map item", () => {
    const clean = mapWarnings(parseItemText(fixture("waystone-t3-clean.txt")))!;
    expect(clean.overall).toBe("none");
    expect(clean.warnings).toEqual([]);
    expect(mapWarnings(parseItemText(fixture("armour-quality-12.txt")))).toBeUndefined();
  });

  it("rates a tablet with the same table", () => {
    const tablet = mapWarnings(parseItemText(fixture("tablet-precursor.txt")))!;
    expect(tablet.itemKind).toBe("tablet");
    expect(tablet.tier).toBeUndefined();
    expect(tablet.warnings.map((warning) => warning.id)).toContain("monster-movement-speed");
  });

  it("only rates against the table it was given", () => {
    const table = [
      {
        id: "custom",
        pattern: String.raw`Monsters have #% increased Attack Speed`,
        severity: "deadly" as MapModSeverity,
        label: "Custom",
        reason: "test",
        tags: ["test"],
        verified: false as const,
      },
    ];
    const report = mapWarnings(waystone, { table })!;
    expect(report.warnings.map((warning) => warning.id)).toEqual(["custom"]);
    expect(report.overall).toBe("deadly");
    expect(report.unmatched).toHaveLength(5);
  });
});

describe("severityAtLeast", () => {
  it("orders the severities and puts 'none' below everything", () => {
    expect(severityAtLeast("deadly", "dangerous")).toBe(true);
    expect(severityAtLeast("caution", "dangerous")).toBe(false);
    expect(severityAtLeast("none", "info")).toBe(false);
  });
});
