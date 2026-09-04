/**
 * Mod knowledge base: which modifier families make a PoE2 item worth money,
 * how much each matters, and what roll counts as a high tier.
 *
 * This drives the appraisal engine's heuristic half. Numbers are deliberately
 * editable, league-agnostic approximations — the price table stays the
 * authority for exact worth; this layer answers "does this rare LOOK like it
 * sells" with an explainable per-mod breakdown.
 */

export interface ModFamily {
  id: string;
  label: string;
  /** Case-insensitive pattern matched against a normalized mod line. */
  pattern: string;
  /**
   * How much this family matters when present at a high tier (1-10).
   * Anchors: +skill-levels 10, spirit/movement 9, life/chaos-res 8.
   */
  weight: number;
  /**
   * Roll thresholds on the judged value: at or above t1/t2/t3 scores the mod
   * as that tier. Below t3 the mod still registers with a small residual.
   */
  tiers: { t1: number; t2: number; t3: number };
  /**
   * Which numeric to judge: the first roll (default) or the average of the
   * first two ("Adds 12 to 24 Fire damage" reads as 18).
   */
  judge?: "first" | "average2";
  /**
   * Judged value when the line carries no number at all — "Bow Attacks fire
   * an Additional Arrow" is a top-tier mod written without digits.
   */
  noNumberValue?: number;
  /**
   * Item classes this family applies to (Ctrl+C "Item Class:" values). A
   * family with classes is consulted only for those classes, and BEFORE the
   * generic families: a jewel's "6% increased Attack Speed" is a strong roll
   * on a jewel and a nothing roll on gloves, so the same line needs its own
   * thresholds per class (2026-09-03: every rare jewel screened as "no
   * notable mods" against the gear-scale numbers).
   */
  classes?: string[];
}

/** Jewel mod families: the same words as gear, jewel-scale rolls. */
const JEWEL: string[] = ["Jewels"];

export const MOD_FAMILIES: ModFamily[] = [
  // ---- Jewels (checked first for Item Class: Jewels) ----------------------
  {
    id: "jewel-life",
    label: "Jewel: maximum life %",
    pattern: String.raw`\d+% increased maximum Life`,
    weight: 9,
    tiers: { t1: 6, t2: 4, t3: 3 },
    classes: JEWEL,
  },
  {
    id: "jewel-es",
    label: "Jewel: maximum energy shield %",
    pattern: String.raw`\d+% increased maximum Energy Shield`,
    weight: 7,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-skill-speed",
    label: "Jewel: skill speed",
    pattern: String.raw`\d+% increased Skill Speed`,
    weight: 9,
    tiers: { t1: 6, t2: 4, t3: 3 },
    classes: JEWEL,
  },
  {
    id: "jewel-attack-speed",
    label: "Jewel: attack speed",
    pattern: String.raw`\d+% increased Attack Speed`,
    weight: 8,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-cast-speed",
    label: "Jewel: cast speed",
    pattern: String.raw`\d+% increased Cast Speed`,
    weight: 8,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-minion-speed",
    label: "Jewel: minion attack and cast speed",
    pattern: String.raw`Minions have \d+% increased Attack and Cast Speed`,
    weight: 6,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-crit-chance",
    label: "Jewel: critical hit chance",
    pattern: String.raw`\d+% increased Critical Hit Chance`,
    weight: 7,
    tiers: { t1: 20, t2: 14, t3: 8 },
    classes: JEWEL,
  },
  {
    id: "jewel-crit-damage",
    label: "Jewel: critical damage bonus",
    pattern: String.raw`\d+% increased Critical Damage Bonus`,
    weight: 7,
    tiers: { t1: 20, t2: 14, t3: 8 },
    classes: JEWEL,
  },
  {
    id: "jewel-penetration",
    label: "Jewel: resistance penetration",
    pattern: String.raw`Damage Penetrates \d+% .*Resistances?`,
    weight: 6,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-leech",
    label: "Jewel: life leech",
    pattern: String.raw`[\d.]+% of (?:Physical |Attack )?Damage Leeched as Life`,
    weight: 5,
    tiers: { t1: 0.6, t2: 0.4, t3: 0.2 },
    classes: JEWEL,
  },
  {
    id: "jewel-all-res",
    label: "Jewel: all elemental resistances",
    pattern: String.raw`\+?\d+% to all Elemental Resistances`,
    weight: 7,
    tiers: { t1: 8, t2: 6, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-chaos-res",
    label: "Jewel: chaos resistance",
    pattern: String.raw`\+?\d+% to Chaos Resistance`,
    weight: 6,
    tiers: { t1: 10, t2: 7, t3: 4 },
    classes: JEWEL,
  },
  {
    id: "jewel-rarity",
    label: "Jewel: item rarity found",
    pattern: String.raw`\d+% increased Rarity of Items found`,
    weight: 5,
    tiers: { t1: 12, t2: 9, t3: 6 },
    classes: JEWEL,
  },
  {
    // Generic "increased … Damage" (physical, spell, elemental, projectile,
    // minion, "with Bow Skills" …) — declared after the specific families so
    // "Critical Damage Bonus" keeps its own. Thresholds sit above the junk
    // band: nearly every rare jewel carries some damage roll.
    id: "jewel-damage",
    label: "Jewel: increased damage",
    pattern: String.raw`\d+% increased (?:[A-Za-z' ]+ )?Damage(?! taken)`,
    weight: 6,
    tiers: { t1: 16, t2: 13, t3: 11 },
    classes: JEWEL,
  },
  // ---- Gear (generic) -----------------------------------------------------
  {
    id: "skill-levels",
    label: "+ to skill levels",
    pattern: String.raw`\+\d+ to Level of all .* Skills`,
    weight: 10,
    tiers: { t1: 4, t2: 3, t3: 2 },
  },
  {
    id: "spirit",
    label: "Spirit",
    pattern: String.raw`\+\d+ to Spirit`,
    weight: 9,
    tiers: { t1: 80, t2: 50, t3: 30 },
  },
  {
    id: "movement-speed",
    label: "Movement speed",
    pattern: String.raw`\d+% increased Movement Speed`,
    weight: 9,
    tiers: { t1: 30, t2: 25, t3: 20 },
  },
  {
    id: "life",
    label: "Maximum life",
    pattern: String.raw`\+\d+ to maximum Life`,
    weight: 8,
    tiers: { t1: 150, t2: 100, t3: 60 },
  },
  {
    id: "all-res",
    label: "All elemental resistances",
    pattern: String.raw`\+?\d+% to all Elemental Resistances`,
    weight: 9,
    tiers: { t1: 15, t2: 11, t3: 7 },
  },
  {
    id: "chaos-res",
    label: "Chaos resistance",
    pattern: String.raw`\+?\d+% to Chaos Resistance`,
    weight: 8,
    tiers: { t1: 30, t2: 20, t3: 13 },
  },
  {
    id: "fire-res",
    label: "Fire resistance",
    pattern: String.raw`\+?\d+% to Fire Resistance`,
    weight: 6,
    tiers: { t1: 40, t2: 30, t3: 20 },
  },
  {
    id: "cold-res",
    label: "Cold resistance",
    pattern: String.raw`\+?\d+% to Cold Resistance`,
    weight: 6,
    tiers: { t1: 40, t2: 30, t3: 20 },
  },
  {
    id: "lightning-res",
    label: "Lightning resistance",
    pattern: String.raw`\+?\d+% to Lightning Resistance`,
    weight: 6,
    tiers: { t1: 40, t2: 30, t3: 20 },
  },
  {
    id: "energy-shield-flat",
    label: "Maximum energy shield",
    pattern: String.raw`\+\d+ to maximum Energy Shield`,
    // Patch 0.5 hit Energy Shield with 64 separate nerfs; ES stacking left
    // the meta and buyers followed (was weight 6 pre-0.5).
    weight: 4,
    tiers: { t1: 150, t2: 90, t3: 50 },
  },
  {
    id: "additional-projectiles",
    label: "Additional arrows / projectiles",
    pattern: String.raw`fires? (an|\d+) Additional (Arrow|Projectile)s?`,
    // Chase mod on bows/quivers for the most-played builds (Lightning Arrow
    // Deadeye et al.) — written without digits at its base tier.
    weight: 9,
    tiers: { t1: 2, t2: 1, t3: 1 },
    noNumberValue: 1,
  },
  {
    id: "onslaught-on-kill",
    label: "Onslaught on kill",
    pattern: String.raw`\d+% chance to gain Onslaught on Killing`,
    weight: 5,
    tiers: { t1: 15, t2: 10, t3: 5 },
  },
  {
    id: "attack-speed",
    label: "Attack speed",
    pattern: String.raw`\d+% increased Attack Speed`,
    weight: 7,
    tiers: { t1: 25, t2: 17, t3: 11 },
  },
  {
    id: "cast-speed",
    label: "Cast speed",
    pattern: String.raw`\d+% increased Cast Speed`,
    weight: 7,
    tiers: { t1: 25, t2: 17, t3: 11 },
  },
  {
    id: "crit-chance",
    label: "Critical hit chance",
    pattern: String.raw`\d+% increased Critical Hit Chance`,
    weight: 6,
    tiers: { t1: 35, t2: 25, t3: 15 },
  },
  {
    id: "crit-damage",
    label: "Critical damage bonus",
    pattern: String.raw`\d+% increased Critical Damage Bonus`,
    weight: 7,
    tiers: { t1: 35, t2: 25, t3: 15 },
  },
  {
    id: "phys-pct",
    label: "Increased physical damage",
    pattern: String.raw`\d+% increased Physical Damage`,
    weight: 7,
    tiers: { t1: 120, t2: 80, t3: 50 },
  },
  {
    id: "spell-damage",
    label: "Spell damage",
    pattern: String.raw`\d+% increased Spell Damage`,
    weight: 6,
    tiers: { t1: 80, t2: 55, t3: 35 },
  },
  {
    id: "adds-phys",
    label: "Adds physical damage",
    pattern: String.raw`Adds \d+ to \d+ Physical Damage`,
    weight: 7,
    tiers: { t1: 30, t2: 18, t3: 10 },
    judge: "average2",
  },
  {
    id: "adds-ele",
    label: "Adds elemental damage",
    pattern: String.raw`Adds \d+ to \d+ (Fire|Cold|Lightning) damage`,
    weight: 6,
    tiers: { t1: 40, t2: 25, t3: 14 },
    judge: "average2",
  },
  {
    id: "rarity-found",
    label: "Item rarity found",
    pattern: String.raw`\d+% increased Rarity of Items found`,
    weight: 7,
    tiers: { t1: 35, t2: 25, t3: 15 },
  },
  {
    id: "all-attributes",
    label: "All attributes",
    pattern: String.raw`\+\d+ to all Attributes`,
    weight: 6,
    tiers: { t1: 25, t2: 18, t3: 10 },
  },
  {
    id: "attribute",
    label: "Single attribute",
    pattern: String.raw`\+\d+ to (Strength|Dexterity|Intelligence)`,
    weight: 3,
    tiers: { t1: 50, t2: 35, t3: 20 },
  },
  {
    id: "mana",
    label: "Maximum mana",
    pattern: String.raw`\+\d+ to maximum Mana`,
    weight: 3,
    tiers: { t1: 150, t2: 100, t3: 60 },
  },
  {
    id: "life-regen",
    label: "Life regeneration",
    pattern: String.raw`Regenerate [\d.]+ Life per second`,
    weight: 3,
    tiers: { t1: 30, t2: 18, t3: 8 },
  },
  {
    id: "skill-speed",
    label: "Skill speed",
    pattern: String.raw`\d+% increased Skill Speed`,
    weight: 8,
    tiers: { t1: 12, t2: 9, t3: 6 },
  },
];

export type ModTier = 1 | 2 | 3 | 0;

export interface ModMatch {
  family: ModFamily;
  /** The numeric this family judges (first roll or two-roll average). */
  judgedValue: number;
  tier: ModTier;
}

/** Points a matched mod contributes: weight scaled by tier quality. */
export function modPoints(match: ModMatch): number {
  const factor = match.tier === 1 ? 3 : match.tier === 2 ? 2 : match.tier === 3 ? 1 : 0.25;
  return match.family.weight * factor;
}

function extractNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((entry) => Number(entry[0]));
}

/** The families that apply to an item class: class-specific first, then generic. */
export function familiesForClass(itemClass: string | undefined): ModFamily[] {
  const wanted = (itemClass ?? "").trim().toLowerCase();
  const specific = wanted
    ? MOD_FAMILIES.filter((family) =>
        family.classes?.some((name) => name.toLowerCase() === wanted),
      )
    : [];
  const generic = MOD_FAMILIES.filter((family) => !family.classes);
  return [...specific, ...generic];
}

/**
 * Match one mod line against the knowledge base. Families are checked in
 * declaration order; the first hit wins (order the specific before the
 * general — "all Attributes" precedes single attributes for this reason).
 * With an item class, that class's own families are tried first.
 */
export function matchModFamily(
  modText: string,
  context: { itemClass?: string } = {},
): ModMatch | undefined {
  const line = modText.replace(/\s+/g, " ").trim();
  for (const family of familiesForClass(context.itemClass)) {
    const regex = new RegExp(family.pattern, "i");
    if (!regex.test(line)) continue;
    const numbers = extractNumbers(line);
    if (numbers.length === 0) {
      if (family.noNumberValue === undefined) return { family, judgedValue: 0, tier: 0 };
      const value = family.noNumberValue;
      const { t1, t2, t3 } = family.tiers;
      const noNumberTier: ModTier = value >= t1 ? 1 : value >= t2 ? 2 : value >= t3 ? 3 : 0;
      return { family, judgedValue: value, tier: noNumberTier };
    }
    const judgedValue =
      family.judge === "average2" && numbers.length >= 2
        ? (numbers[0]! + numbers[1]!) / 2
        : numbers[0]!;
    const { t1, t2, t3 } = family.tiers;
    const tier: ModTier = judgedValue >= t1 ? 1 : judgedValue >= t2 ? 2 : judgedValue >= t3 ? 3 : 0;
    return { family, judgedValue, tier };
  }
  return undefined;
}
