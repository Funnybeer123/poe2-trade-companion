import { describe, expect, it } from "vitest";
import { parseItemText } from "../src/core/parseItem.js";
import {
  JUICE_TARGET_TIER,
  MAPS_SPECIALTY_SKIP_ROWS,
  WAYSTONE_JUICE_KNOWLEDGE_VERSION,
  countExplicitWaystoneAffixes,
  inspectWaystone,
  inventoryOpenFromOcr,
  mapsSpecialtyFromOcr,
  planWaystoneJuice,
  preferNormalStashForWaystones,
  stashOpenFromOcr,
  waystoneTier,
  collapseAdjacentDuplicateReads,
  allocateOrbClicks,
  juiceBatchTargets,
  juiceOrbForPhase,
  juiceUsesShiftApply,
  remainingBatchTargets,
  remainingExaltSlams,
  EXALT_SLAMS_PER_MAP,
  decideVaalProbe,
  isKeepableMagicWaystone,
  isPremiumWaystone,
  isWorthExaltingWaystone,
  itemTextLooksCorrupted,
  planJuiceFromScan,
  shouldRerollWithAlchemy,
  takePickups,
  currencyStackCount,
  classifyCursorText,
  shouldParkVaalResult,
  vaalAfterClick,
  vaalAftermath,
  waystoneClipboardComplete,
} from "../src/core/waystoneJuice.js";

function item(lines: string[]): string {
  return lines.join("\n");
}

const WHITE_T15 = item([
  "Item Class: Waystones",
  "Rarity: Normal",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
]);

const UNID_WHITE_T15 = item([
  "Item Class: Waystones",
  "Rarity: Normal",
  "Waystone (Tier 15)",
  "--------",
  "Item Level: 79",
  "--------",
  "Unidentified",
]);

const MAGIC_T15_COLON = item([
  "Item Class: Waystones",
  "Rarity: Magic",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "Magic Monsters: +30% (augmented)",
  "Item Quantity: +18% (augmented)",
]);

const RARE_OPEN_ANNOTATED = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Scarred Path",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  '{ Prefix Modifier "Painful" (Tier: 3) }',
  "18% increased Monster Damage",
  "20% more Waystones found in Area",
  "25% more Magic and Rare Monsters",
  "Rare Monsters have 25% more chance of Monster Modifiers",
  '{ Prefix Modifier "Tough" (Tier: 3) }',
  "22% more Monster Life",
  "15% more Waystones found in Area",
  "23% more Magic and Rare Monsters",
  '{ Suffix Modifier "of Exposure" (Tier: 2) }',
  "-5% maximum Player Resistances",
  "25% more Waystones found in Area",
  "10% more Pack size",
  '{ Suffix Modifier "of Smothering" (Tier: 2) }',
  "Players have 32% less Recovery Rate of Life and Energy Shield",
  "20% more Waystones found in Area",
  "15% more Rarity of Items found in this Area",
]);

const RARE_FULL_ANNOTATED = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Scarred Path",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  '{ Prefix Modifier "Painful" (Tier: 3) }',
  "18% increased Monster Damage",
  "20% more Waystones found in Area",
  '{ Prefix Modifier "Tough" (Tier: 3) }',
  "22% more Monster Life",
  "15% more Waystones found in Area",
  '{ Prefix Modifier "Thunderous" (Tier: 2) }',
  "Monsters deal 12% of Damage as Extra Lightning",
  "15% more Waystones found in Area",
  '{ Suffix Modifier "of Exposure" (Tier: 2) }',
  "-5% maximum Player Resistances",
  "10% more Pack size",
  '{ Suffix Modifier "of Smothering" (Tier: 2) }',
  "Players have 32% less Recovery Rate of Life and Energy Shield",
  "15% more Rarity of Items found in this Area",
  '{ Suffix Modifier "of Slowing" }',
  "Players are periodically Cursed with Temporal Chains",
  "20% more Waystones found in Area",
  "8% more Pack size",
]);

const RARE_OPEN_UNANNOTATED = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  "18% increased Monster Damage",
  "20% more Waystones found in Area",
  "25% more Magic and Rare Monsters",
  "Rare Monsters have 25% more chance of Monster Modifiers",
  "22% more Monster Life",
  "15% more Waystones found in Area",
  "23% more Magic and Rare Monsters",
  "Players have 32% less Recovery Rate of Life and Energy Shield",
  "20% more Waystones found in Area",
  "15% more Rarity of Items found in this Area",
]);

const PREMIUM_T15 = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Dream Choice",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  '{ Prefix Modifier "Painful" (Tier: 3) }',
  "18% increased Monster Damage",
  "20% more Waystones found in Area",
  '{ Prefix Modifier "Infernal" (Tier: 2) }',
  "Monsters deal 12% of Damage as Extra Fire",
  "25% more Rarity of Items found in this Area",
  '{ Prefix Modifier "Venomous" (Tier: 2) }',
  "Monsters have 20% chance to Poison on Hit",
  "10% more Pack size",
  '{ Suffix Modifier "of Hexwarding" (Tier: 2) }',
  "Players have 30% less effect of Curses on them",
  "15% more Waystones found in Area",
  '{ Suffix Modifier "of the Unwavering" (Tier: 2) }',
  "Monsters have +40% to Stun Threshold",
  '{ Suffix Modifier "of Buffering" (Tier: 2) }',
  "Monsters have 20% extra maximum Energy Shield",
]);

const CORRUPTED_T15 = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  "18% increased Monster Damage",
  "20% more Waystones found in Area",
  "--------",
  "Corrupted",
]);

const T11_MAGIC = item([
  "Item Class: Waystones",
  "Rarity: Magic",
  "Waystone (Tier 11)",
  "--------",
  "Waystone Tier: 11",
  "Magic Monsters: +30% (augmented)",
  "Item Quantity: +18% (augmented)",
]);

const DEAD_MAGIC_T15 = item([
  "Item Class: Waystones",
  "Rarity: Magic",
  "Venomous Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  "Monsters have 20% chance to Poison on Hit",
]);

const DEAD_RARE_T15 = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Poisoned Vector",
  "Waystone (Tier 15)",
  "--------",
  "Waystone Tier: 15",
  "--------",
  '{ Prefix Modifier "Venomous" (Tier: 2) }',
  "Monsters have 20% chance to Poison on Hit",
  '{ Prefix Modifier "Thunderous" (Tier: 2) }',
  "Monsters deal 12% of Damage as Extra Lightning",
  '{ Prefix Modifier "Impacting" (Tier: 2) }',
  "Monsters have 90% increased Stun Buildup",
  '{ Suffix Modifier "of Overpowering" (Tier: 2) }',
  "Monsters have 100% increased Elemental Ailment Application",
]);

const TABLET = item([
  "Item Class: Tablet",
  "Rarity: Magic",
  "Irradiated Tablet",
  "--------",
  "Item Quantity: +8%",
]);

const UNID_RARE_T15 = item([
  "Item Class: Waystones",
  "Rarity: Rare",
  "Waystone (Tier 15)",
  "--------",
  "Item Level: 79",
  "--------",
  "Unidentified",
]);

describe("waystoneJuice knowledge", () => {
  it("pins a dated knowledge version", () => {
    expect(WAYSTONE_JUICE_KNOWLEDGE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(JUICE_TARGET_TIER).toBe(15);
  });
});

describe("waystoneTier / affix count", () => {
  it("reads tier from the display name and Waystone Tier colon line", () => {
    expect(waystoneTier(parseItemText(WHITE_T15))).toBe(15);
    expect(waystoneTier(parseItemText(T11_MAGIC))).toBe(11);
  });

  it("does not count Waystone Tier colon metadata as an affix", () => {
    expect(countExplicitWaystoneAffixes(parseItemText(WHITE_T15))).toBe(0);
    expect(countExplicitWaystoneAffixes(parseItemText(MAGIC_T15_COLON))).toBe(2);
  });

  it("counts annotated prefix/suffix groups, not every reward line", () => {
    expect(countExplicitWaystoneAffixes(parseItemText(RARE_OPEN_ANNOTATED))).toBe(4);
    expect(countExplicitWaystoneAffixes(parseItemText(RARE_FULL_ANNOTATED))).toBe(6);
  });

  it("groups unannotated multi-line prefixes by distinctive family", () => {
    expect(countExplicitWaystoneAffixes(parseItemText(RARE_OPEN_UNANNOTATED))).toBe(3);
  });
});

describe("planWaystoneJuice recipe", () => {
  it("alchs a white T15, including unidentified whites", () => {
    const white = planWaystoneJuice(WHITE_T15);
    expect(white.action).toBe("alchemy");
    expect(white.orb).toBe("alchemy");
    expect(white.autoEligible).toBe(true);

    const unid = planWaystoneJuice(UNID_WHITE_T15);
    expect(unid.action).toBe("alchemy");
    expect(unid.autoEligible).toBe(true);
  });

  it("regals a magic T15 instead of alching it", () => {
    const plan = planWaystoneJuice(MAGIC_T15_COLON);
    expect(plan.action).toBe("regal");
    expect(plan.orb).toBe("regal");
    expect(plan.autoEligible).toBe(true);
  });

  it("exalts an open rare and vaals a 6-mod rare", () => {
    const open = planWaystoneJuice(RARE_OPEN_ANNOTATED);
    expect(open.action).toBe("exalt");
    expect(open.orb).toBe("exalted");
    expect(open.autoEligible).toBe(true);

    const full = planWaystoneJuice(RARE_FULL_ANNOTATED);
    expect(full.action).toBe("vaal");
    expect(full.orb).toBe("vaal");
    expect(full.autoEligible).toBe(true);

    const premium = planWaystoneJuice(PREMIUM_T15);
    expect(isPremiumWaystone(premium.inspection)).toBe(true);
    expect(premium.action).toBe("vaal");
    expect(premium.autoEligible).toBe(true);
    expect(premium.reasons.join(" ")).toMatch(/every 6-mod is corrupted/i);
    expect(isPremiumWaystone(full.inspection)).toBe(false);
  });

  it("alchs a weak magic instead of regaling it, and still slams a dead rare", () => {
    const deadMagic = planWaystoneJuice(DEAD_MAGIC_T15);
    expect(shouldRerollWithAlchemy(deadMagic.inspection)).toBe(true);
    expect(isKeepableMagicWaystone(deadMagic.inspection)).toBe(false);
    expect(deadMagic.action).toBe("alchemy");
    expect(deadMagic.orb).toBe("alchemy");
    expect(deadMagic.reasons.join(" ")).toMatch(/rerolls/i);

    const keeperMagic = planWaystoneJuice(MAGIC_T15_COLON);
    expect(shouldRerollWithAlchemy(keeperMagic.inspection)).toBe(false);
    expect(isKeepableMagicWaystone(keeperMagic.inspection)).toBe(true);
    expect(keeperMagic.action).toBe("regal");

    const deadRare = planWaystoneJuice(DEAD_RARE_T15);
    expect(isWorthExaltingWaystone(deadRare.inspection)).toBe(false);
    expect(deadRare.action).toBe("exalt");
    expect(deadRare.autoEligible).toBe(true);
    expect(deadRare.reasons.join(" ")).toMatch(/3 Exalted Orb slams/i);
  });

  it("vaals a 6-mod Arid Charge with harmful suffixes and does not treat a still-clean copy as done", () => {
    const arid = item([
      "Item Class: Waystones",
      "Rarity: Rare",
      "Arid Charge",
      "Waystone (Tier 15)",
      "--------",
      "Revives Available: 0 (augmented)",
      "Item Rarity: +26% (augmented)",
      "Pack Size: +25% (augmented)",
      "Monster Effectiveness: +13% (augmented)",
      "Waystone Drop Chance: +100% (augmented)",
      "--------",
      "Item Level: 81",
      "--------",
      '{ Prefix Modifier "Venomous" (Tier: 1) }',
      "Monsters have 31(27-33)% chance to Poison on Hit",
      '{ Prefix Modifier "Thunderous" (Tier: 1) }',
      "Monsters deal 15(15-19)% of Damage as Extra Lightning",
      '{ Prefix Modifier "Impacting" (Tier: 1) }',
      "Monsters have 99(90-100)% increased Stun Buildup",
      '{ Suffix Modifier "of Exposure" (Tier: 1) }',
      "-6(-8--6)% maximum Player Resistances",
      '{ Suffix Modifier "of Overpowering" (Tier: 1) }',
      "Monster have 118(100-119)% increased Elemental Ailment Application",
      '{ Suffix Modifier "of Smothering" (Tier: 1) }',
      "Players have 37(40-36)% less Recovery Rate of Life and Energy Shield",
      "--------",
      "Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.",
    ]);
    const plan = planWaystoneJuice(arid);
    expect(isPremiumWaystone(plan.inspection)).toBe(false);
    expect(plan.action).toBe("vaal");
    expect(waystoneClipboardComplete(arid)).toBe(true);
    expect(itemTextLooksCorrupted(arid)).toBe(false);
    expect(vaalAfterClick(arid)).toBe("still-clean");
    expect(vaalAfterClick(`${arid}\nCorrupted`)).toBe("stay");
    expect(vaalAfterClick(arid.split("--------").slice(0, 3).join("--------"))).toBe("unknown");
  });

  it("vaals after an exalt that changed nothing", () => {
    const plan = planWaystoneJuice(RARE_OPEN_ANNOTATED, { exaltDidNothing: true });
    expect(plan.action).toBe("vaal");
    expect(plan.orb).toBe("vaal");
  });

  it("only parks and returns to XV when Vaal changes the tier", () => {
    const t14 = item([
      "Item Class: Waystones",
      "Rarity: Rare",
      "Waystone (Tier 14)",
      "--------",
      "Waystone Tier: 14",
      "--------",
      "Corrupted",
    ]);
    const t16 = item([
      "Item Class: Waystones",
      "Rarity: Rare",
      "Waystone (Tier 16)",
      "--------",
      "Waystone Tier: 16",
      "--------",
      "Corrupted",
    ]);
    const leftoverVaal = item([
      "Item Class: Stackable Currency",
      "Rarity: Currency",
      "Vaal Orb",
      "--------",
      "Stack Size: 11/20",
    ]);
    expect(vaalAftermath(CORRUPTED_T15)).toBe("stayed-t15");
    expect(shouldParkVaalResult(vaalAftermath(CORRUPTED_T15))).toBe(false);
    expect(vaalAfterClick(CORRUPTED_T15)).toBe("stay");
    expect(decideVaalProbe(CORRUPTED_T15)).toBe("nothing");
    expect(vaalAfterClick(PREMIUM_T15)).toBe("unknown");
    expect(vaalAfterClick(`${PREMIUM_T15}\n--------\nCan be used in a Map Device, allowing you to enter a Map.`)).toBe(
      "still-clean",
    );
    expect(vaalAftermath(t14)).toBe("ejected");
    expect(vaalAftermath(t16)).toBe("ejected");
    expect(vaalAftermath("")).toBe("unknown");
    expect(vaalAftermath(leftoverVaal)).toBe("unknown");
    expect(vaalAfterClick("")).toBe("held");
    expect(vaalAfterClick(t14)).toBe("held");
    expect(vaalAfterClick(leftoverVaal)).toBe("held");
    expect(decideVaalProbe("")).toBe("park-tier-change");
    expect(decideVaalProbe(t14)).toBe("park-tier-change");
    expect(shouldParkVaalResult(vaalAftermath(t14))).toBe(true);
    expect(planWaystoneJuice(RARE_FULL_ANNOTATED).reasons.join(" ")).toMatch(/park it in the bag/i);
    expect(planWaystoneJuice(RARE_FULL_ANNOTATED).reasons.join(" ")).toMatch(/click XV/i);
  });

  it("batches the current scan by orb and never allocates more Exalts than the stack has", () => {
    const scan = [
      { row: 0, col: 0, text: WHITE_T15 },
      { row: 0, col: 1, text: MAGIC_T15_COLON },
      { row: 0, col: 2, text: RARE_OPEN_ANNOTATED },
      { row: 0, col: 3, text: RARE_FULL_ANNOTATED },
      { row: 0, col: 4, text: PREMIUM_T15 },
      { row: 0, col: 5, text: DEAD_MAGIC_T15 },
      { row: 0, col: 6, text: DEAD_RARE_T15 },
    ];
    expect(juiceOrbForPhase("exalt")).toBe("exalted");
    expect(juiceBatchTargets(scan, "alchemy")).toEqual([
      { row: 0, col: 0, slams: 1, action: "alchemy" },
      { row: 0, col: 5, slams: 1, action: "alchemy" },
    ]);
    expect(juiceBatchTargets(scan, "regal")).toEqual([
      { row: 0, col: 1, slams: 1, action: "regal" },
    ]);
    const exalt = juiceBatchTargets(scan, "exalt");
    expect(exalt).toEqual([
      { row: 0, col: 2, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
      { row: 0, col: 6, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
    ]);
    expect(juiceBatchTargets(scan, "vaal")).toEqual([
      { row: 0, col: 3, slams: 1, action: "vaal" },
      { row: 0, col: 4, slams: 1, action: "vaal" },
    ]);
    const fromScan = planJuiceFromScan(scan);
    expect(fromScan.alchemy).toEqual([
      { row: 0, col: 0, slams: 1, action: "alchemy" },
      { row: 0, col: 5, slams: 1, action: "alchemy" },
    ]);
    expect(fromScan.regal).toEqual([{ row: 0, col: 1, slams: 1, action: "regal" }]);
    expect(fromScan.exalt).toEqual([
      { row: 0, col: 0, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
      { row: 0, col: 1, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
      { row: 0, col: 2, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
      { row: 0, col: 5, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
      { row: 0, col: 6, slams: EXALT_SLAMS_PER_MAP, action: "exalt" },
    ]);
    expect(fromScan.vaal.map((target) => `${target.row},${target.col}`)).toEqual([
      "0,0",
      "0,1",
      "0,2",
      "0,3",
      "0,4",
      "0,5",
      "0,6",
    ]);
    const stacks = [
      { count: 11, x: 1, y: 1 },
      { count: 20, x: 2, y: 2 },
    ];
    const taken = takePickups(stacks, 15);
    expect(taken).toMatchObject({ used: 15, putBack: true });
    expect(taken.pickups).toEqual([
      { x: 1, y: 1, count: 11 },
      { x: 2, y: 2, count: 4 },
    ]);
    expect(stacks[0]!.count).toBe(0);
    expect(stacks[1]!.count).toBe(16);
    expect(currencyStackCount("Item Class: Stackable Currency\nExalted Orb\nStack Size: 5/20")).toBe(5);
    expect(currencyStackCount("Item Class: Stackable Currency\nVaal Orb\nStack Size: 20/20")).toBe(20);
    expect(currencyStackCount("Item Class: Stackable Currency\nExalted Orb")).toBe(1);
    expect(classifyCursorText("Item Class: Stackable Currency\nRarity: Currency\nExalted Orb\nStack Size: 5/20", "Exalted Orb")).toBe("orb");
    expect(classifyCursorText("Item Class: Waystones\nRarity: Rare\nLost Course\nWaystone (Tier 15)", "Exalted Orb")).toBe("waystone");
    expect(classifyCursorText("", "Exalted Orb")).toBe("empty");
    expect(classifyCursorText("Item Class: Stackable Currency\nVaal Orb\nStack Size: 3/20", "Exalted Orb")).toBe("empty");
    expect(allocateOrbClicks(0, exalt).clicks).toEqual([]);
    const short = allocateOrbClicks(1, [
      { row: 0, col: 2, slams: 3, action: "exalt" },
      { row: 1, col: 0, slams: 2, action: "exalt" },
    ]);
    expect(short).toMatchObject({ used: 1, remaining: 0 });
    expect(short.clicks).toEqual([{ row: 0, col: 2, slams: 1, action: "exalt" }]);
    expect(remainingBatchTargets(
      [
        { row: 0, col: 2, slams: 3, action: "exalt" },
        { row: 1, col: 0, slams: 2, action: "exalt" },
      ],
      short.clicks,
    )).toEqual([
      { row: 0, col: 2, slams: 2, action: "exalt" },
      { row: 1, col: 0, slams: 2, action: "exalt" },
    ]);
  });

  it("holds Shift for every orb while it is on the cursor, including Vaal", () => {
    const open = planWaystoneJuice(RARE_OPEN_ANNOTATED);
    expect(remainingExaltSlams(open.inspection)).toBeGreaterThan(1);
    expect(juiceUsesShiftApply(open)).toBe(true);
    const full = planWaystoneJuice(RARE_FULL_ANNOTATED);
    expect(remainingExaltSlams(full.inspection)).toBe(0);
    expect(juiceUsesShiftApply(full)).toBe(true);
    expect(juiceUsesShiftApply(planWaystoneJuice(WHITE_T15))).toBe(true);
    expect(juiceUsesShiftApply(planWaystoneJuice(MAGIC_T15_COLON))).toBe(true);
  });

  it("finishes a corrupted T15 and skips everything else", () => {
    expect(planWaystoneJuice(CORRUPTED_T15).action).toBe("done");
    expect(planWaystoneJuice(CORRUPTED_T15).autoEligible).toBe(false);
    expect(planWaystoneJuice(T11_MAGIC).action).toBe("skip");
    expect(planWaystoneJuice(TABLET).action).toBe("skip");
    expect(planWaystoneJuice("not an item").action).toBe("skip");
  });

  it("exalts an unidentified rare T15 (mods are hidden)", () => {
    const plan = planWaystoneJuice(UNID_RARE_T15);
    expect(plan.inspection.tier).toBe(15);
    expect(plan.action).toBe("exalt");
  });
});

describe("desirability tags (Alchemy reroll vs finish)", () => {
  it("highlights quantity, pack size, rare monsters and waystone chance", () => {
    const inspection = inspectWaystone(parseItemText(RARE_OPEN_ANNOTATED));
    expect(inspection.rewardTags).toEqual(
      expect.arrayContaining(["rarity", "pack-size", "rare-monsters", "waystone-drop"]),
    );
    expect(inspection.score).toBeGreaterThan(50);
  });

  it("flags recovery, max-res and temporal chains without skipping the recipe", () => {
    const plan = planWaystoneJuice(RARE_FULL_ANNOTATED);
    expect(plan.inspection.dangerTags).toEqual(
      expect.arrayContaining(["less-recovery", "minus-max-res", "temporal-chains", "high-monster-life"]),
    );
    expect(plan.action).toBe("vaal");
    expect(plan.autoEligible).toBe(true);
  });

  it("still juices a magic stone whose only visible rolls are colon rewards", () => {
    const plan = planWaystoneJuice(MAGIC_T15_COLON);
    expect(plan.inspection.rewardTags).toEqual(expect.arrayContaining(["quantity", "rare-monsters"]));
    expect(plan.action).toBe("regal");
  });
});

describe("panel OCR helpers", () => {
  it("treats garbled inventory/stash title bands as open", () => {
    expect(inventoryOpenFromOcr("INVENTORYERY")).toBe(true);
    expect(stashOpenFromOcr("STASHESH")).toBe(true);
    expect(stashOpenFromOcr("Guild Stash")).toBe(false);
  });

  it("recognizes the maps specialty tab and forces 12×12", () => {
    expect(mapsSpecialtyFromOcr("Maps (Remove-only)")).toBe(true);
    expect(mapsSpecialtyFromOcr("MAPS (REMOVE ONLY)")).toBe(true);
    expect(mapsSpecialtyFromOcr("Mapsteps")).toBe(true);
    expect(mapsSpecialtyFromOcr("Currency O Gem Abyss 19 Breach VII 149 VIII")).toBe(true);
    expect(mapsSpecialtyFromOcr("Great Gear")).toBe(false);
    expect(preferNormalStashForWaystones({ mapsSpecialty: true })).toBe(true);
    expect(preferNormalStashForWaystones({ chromeFailed: true })).toBe(true);
    expect(preferNormalStashForWaystones({})).toBe(false);
    expect(MAPS_SPECIALTY_SKIP_ROWS).toBe(3);
  });

  it("collapses a 2×2 quad read of one waystone but keeps two identical whites a cell apart", () => {
    const stone = "Item Class: Waystones\nRarity: Normal\nWaystone (Tier 15)";
    const collapsed = collapseAdjacentDuplicateReads([
      { row: 10, col: 1, text: stone },
      { row: 10, col: 2, text: stone },
      { row: 11, col: 1, text: stone },
      { row: 11, col: 2, text: stone },
      { row: 10, col: 4, text: stone },
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((cell) => `${cell.row},${cell.col}`)).toEqual(["10,1", "10,4"]);
  });
});
