/**
 * Runs the appraisal + crafting pipeline through best-in-slot-style gear for
 * the top 0.5 "Runes of Aldur" meta builds (researched 2026-08-30: Lightning
 * Arrow Deadeye — most played; Spark Archmage Stormweaver; Ice Strike Monk /
 * Invoker; Twister Spirit Walker; ES got 64 nerfs and left the meta).
 *
 * These tests pin the engine's judgment to the meta: chase gear must score
 * high and be told to SELL, the same gear with open affixes must be slammed,
 * and off-meta stats (post-nerf ES stacking) must rank below life gear.
 */
import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import { archetypeForClass, planCraft } from "../src/core/crafting.js";
import { matchModFamily } from "../src/core/modKnowledge.js";

function item(lines: string[]): string {
  return lines.join("\n");
}

// Lightning Arrow Deadeye — the most-played build's dream bow.
const LA_DEADEYE_BOW = item([
  "Item Class: Bows",
  "Rarity: Rare",
  "Storm Fletch",
  "Composite Bow",
  "--------",
  "Item Level: 82",
  "--------",
  "142% increased Physical Damage",
  "Adds 12 to 24 Physical Damage",
  "Adds 2 to 68 Lightning damage",
  "26% increased Attack Speed",
  "Bow Attacks fire an Additional Arrow",
  "+3 to Level of all Projectile Skills",
]);

const LA_DEADEYE_QUIVER = item([
  "Item Class: Quivers",
  "Rarity: Rare",
  "Hail Barb",
  "Visceral Quiver",
  "--------",
  "Item Level: 81",
  "--------",
  "Adds 5 to 52 Lightning damage",
  "18% increased Attack Speed",
  "15% chance to gain Onslaught on Killing Hits",
]);

// Spark Archmage Stormweaver — caster weapon + focus.
const ARCHMAGE_WAND = item([
  "Item Class: Wands",
  "Rarity: Rare",
  "Storm Spire",
  "Attuned Wand",
  "--------",
  "Item Level: 82",
  "--------",
  "85% increased Spell Damage",
  "22% increased Cast Speed",
  "+4 to Level of all Lightning Spell Skills",
  "+120 to maximum Mana",
]);

const CASTER_FOCUS = item([
  "Item Class: Foci",
  "Rarity: Rare",
  "Mind Turn",
  "Crystal Focus",
  "--------",
  "Item Level: 80",
  "--------",
  "70% increased Spell Damage",
  "+95 to maximum Mana",
  "19% increased Cast Speed",
]);

// Universal: the boots every build buys.
const META_BOOTS = item([
  "Item Class: Boots",
  "Rarity: Rare",
  "Gale Track",
  "Stellar Sandals",
  "--------",
  "Item Level: 81",
  "--------",
  "32% increased Movement Speed",
  "+112 to maximum Life",
  "+38% to Fire Resistance",
  "+35% to Cold Resistance",
]);

// Twister Spirit Walker — spirit amulet.
const SPIRIT_AMULET = item([
  "Item Class: Amulets",
  "Rarity: Rare",
  "Whirl Charm",
  "Solar Amulet",
  "--------",
  "Item Level: 82",
  "--------",
  "+85 to Spirit",
  "+96 to maximum Life",
  "+18% to all Elemental Resistances",
]);

// Post-nerf ES stacking piece: rolls that were chase before 0.5.
const ES_RELIC_OF_THE_PAST = item([
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Ghost Shell",
  "Vaal Regalia",
  "--------",
  "Item Level: 84",
  "--------",
  "+180 to maximum Energy Shield",
  "+42 to maximum Mana",
]);

const LIFE_EQUIVALENT_BODY = item([
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Iron Shell",
  "Vaal Cuirass",
  "--------",
  "Item Level: 84",
  "--------",
  "+180 to maximum Life",
  "+42 to maximum Mana",
]);

describe("meta mod recognition", () => {
  it("reads the digitless additional-arrow chase mod as top tier", () => {
    const match = matchModFamily("Bow Attacks fire an Additional Arrow")!;
    expect(match.family.id).toBe("additional-projectiles");
    expect(match.judgedValue).toBe(1);
    expect(match.tier).toBe(2); // one arrow = strong; two would be t1
    const two = matchModFamily("Bow Attacks fire 2 Additional Arrows")!;
    expect(two.tier).toBe(1);
  });

  it("recognizes onslaught-on-kill", () => {
    const match = matchModFamily("15% chance to gain Onslaught on Killing Hits")!;
    expect(match.family.id).toBe("onslaught-on-kill");
    expect(match.tier).toBe(1);
  });

  it("covers every meta slot with an archetype", () => {
    for (const cls of ["Bows", "Quivers", "Wands", "Foci", "Boots", "Amulets", "Gloves", "Body Armours"]) {
      expect(archetypeForClass(cls), cls).toBeDefined();
    }
    expect(archetypeForClass("Quivers")!.id).toBe("quiver");
    expect(archetypeForClass("Foci")!.id).toBe("focus");
    expect(archetypeForClass("Gloves")!.id).toBe("gloves");
  });
});

describe("pipeline against top-build best-in-slot gear", () => {
  const finished = [
    ["LA Deadeye bow", LA_DEADEYE_BOW],
    ["Archmage wand", ARCHMAGE_WAND],
    ["meta boots", META_BOOTS],
    ["spirit amulet", SPIRIT_AMULET],
  ] as const;

  it.each(finished)("appraises %s as clearly valuable", (_label, text) => {
    const appraisal = appraiseItem(text);
    expect(appraisal.valueScore).toBeGreaterThanOrEqual(60);
    expect(appraisal.confidence).toBeGreaterThanOrEqual(50);
  });

  it("tells the finished six-mod bow to sell, not craft", () => {
    const plan = planCraft(LA_DEADEYE_BOW);
    expect(plan.action).toBe("sell");
    expect(plan.openAffixes).toBe(0);
    expect(plan.onArchetypeMods.length).toBeGreaterThanOrEqual(5);
  });

  it("slams the same bow when affixes are open", () => {
    const openBow = item([
      "Item Class: Bows",
      "Rarity: Rare",
      "Storm Fletch",
      "Composite Bow",
      "--------",
      "Item Level: 82",
      "--------",
      "142% increased Physical Damage",
      "26% increased Attack Speed",
      "Bow Attacks fire an Additional Arrow",
    ]);
    const plan = planCraft(openBow);
    expect(plan.action).toBe("exalt");
    expect(plan.autoEligible).toBe(true);
    expect(plan.expectedProfit).toBeGreaterThan(0);
  });

  it("values the quiver's meta mods through the quiver archetype", () => {
    const plan = planCraft(LA_DEADEYE_QUIVER);
    expect(plan.archetypeId).toBe("quiver");
    expect(plan.onArchetypeMods.length).toBe(3);
    expect(plan.action).toBe("exalt"); // 3 open affixes on coherent substance
    // A weak-rolled version of the same quiver sits at negative slam EV and
    // is correctly declined — the engine slams substance, not slots.
    const weak = planCraft(LA_DEADEYE_QUIVER.replace("Adds 5 to 52", "Adds 1 to 20"));
    expect(weak.action).not.toBe("exalt");
  });

  it("values the focus through the caster archetype", () => {
    const plan = planCraft(CASTER_FOCUS);
    expect(plan.archetypeId).toBe("focus");
    expect(plan.onArchetypeMods.length).toBe(3);
  });

  it("ranks post-nerf ES stacking below the life equivalent", () => {
    const es = appraiseItem(ES_RELIC_OF_THE_PAST);
    const life = appraiseItem(LIFE_EQUIVALENT_BODY);
    expect(life.valueScore).toBeGreaterThan(es.valueScore);
  });
});
