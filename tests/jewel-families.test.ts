import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import { screenForLookup } from "../src/core/lookupScreen.js";
import { familiesForClass, matchModFamily } from "../src/core/modKnowledge.js";
import { listingSimilarity } from "../src/core/tradeComps.js";

const item = (lines: string[]): string => lines.join("\n");

const jewel = (name: string, mods: string[]): string =>
  item([
    "Item Class: Jewels",
    "Rarity: Rare",
    name,
    "Sapphire",
    "--------",
    "Item Level: 79",
    "--------",
    ...mods,
    "--------",
    "Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.",
  ]);

/**
 * Jewel mods use gear's words at jewel-scale rolls (2026-09-03: 22 rare
 * jewels screened "no notable mods" against gear thresholds). Class-aware
 * families give jewels their own numbers without touching gear scoring.
 */
describe("jewel mod families", () => {
  it("are consulted first for jewels and not at all for gear", () => {
    const onJewel = matchModFamily("6% increased Attack Speed", { itemClass: "Jewels" })!;
    expect(onJewel.family.id).toBe("jewel-attack-speed");
    expect(onJewel.tier).toBe(2);
    const onGear = matchModFamily("6% increased Attack Speed", { itemClass: "Gloves" })!;
    expect(onGear.family.id).toBe("attack-speed");
    expect(onGear.tier).toBe(0);
    const noClass = matchModFamily("6% increased Attack Speed")!;
    expect(noClass.family.id).toBe("attack-speed");
    expect(familiesForClass("Jewels")[0]!.classes).toEqual(["Jewels"]);
    expect(familiesForClass("Gloves").every((family) => !family.classes)).toBe(true);
  });

  it("scores the rolls that sell: life %, speed, crit, resists, damage", () => {
    const of = (text: string) => matchModFamily(text, { itemClass: "Jewels" });
    expect(of("4% increased maximum Life")).toMatchObject({ tier: 2 });
    expect(of("7% increased maximum Life")).toMatchObject({ tier: 1 });
    expect(of("20% increased Critical Damage Bonus")).toMatchObject({
      family: { id: "jewel-crit-damage" },
      tier: 1,
    });
    expect(of("+8% to all Elemental Resistances")).toMatchObject({ tier: 1 });
    expect(of("12% increased Damage")).toMatchObject({ family: { id: "jewel-damage" }, tier: 3 });
    expect(of("9% increased Physical Damage")).toMatchObject({ family: { id: "jewel-damage" }, tier: 0 });
    expect(of("Minions deal 14% increased Damage")).toMatchObject({ family: { id: "jewel-damage" }, tier: 2 });
    expect(of("0.4% of Physical Damage Leeched as Life")).toMatchObject({ tier: 2 });
    expect(of("Damage Penetrates 6% Fire Resistance")).toMatchObject({ tier: 2 });
    expect(of("15% increased Mana Regeneration Rate")).toBeUndefined();
  });

  it("routes a good jewel to a lookup and a junk jewel to the floor", () => {
    const good = appraiseItem(
      jewel("Bramble Star", [
        "4% increased maximum Life",
        "6% increased Attack Speed",
        "9% increased Physical Damage",
      ]),
    );
    const junk = appraiseItem(
      jewel("Foe Wisdom", ["9% increased Physical Damage", "+7% to Fire Resistance", "5% increased Armour"]),
    );
    expect(good.mods.filter((mod) => (mod.tier ?? 0) >= 1)).toHaveLength(2);
    expect(junk.mods.filter((mod) => (mod.tier ?? 0) >= 1)).toHaveLength(0);
    const decisions = screenForLookup([
      { key: "good", name: "Bramble Star", tier: "unknown", rarity: "Rare", baseType: "Sapphire", appraisal: good },
      { key: "junk", name: "Foe Wisdom", tier: "unknown", rarity: "Rare", baseType: "Sapphire", appraisal: junk },
    ]);
    expect(decisions.find((decision) => decision.key === "good")).toMatchObject({ route: "lookup" });
    expect(decisions.find((decision) => decision.key === "junk")).toMatchObject({ route: "floor" });
    expect(decisions[0]!.reason).toContain("Jewel: maximum life %");
  });

  it("judges comps similarity with the same class families", () => {
    const ours = ["4% increased maximum Life", "6% increased Attack Speed"];
    const listing = {
      id: "a",
      name: "Rival Jewel",
      baseType: "Sapphire",
      mods: ["5% increased maximum Life", "10% increased Physical Damage"],
      priceAmount: 3,
      priceCurrency: "exalted",
    };
    // As a jewel: one of our two notable families shared → 0.5.
    expect(listingSimilarity(ours, listing, "Jewels")).toBe(0.5);
    // Judged as gear, neither line is notable, so every listing "matches".
    expect(listingSimilarity(ours, listing, "Gloves")).toBe(1);
  });
});
