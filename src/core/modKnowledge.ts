/**
 * Mod knowledge base: which modifier families make a PoE2 item worth money,
 * how much each matters, and what roll counts as a high tier.
 *
 * This drives the appraisal engine's heuristic half. Numbers are deliberately
 * editable, league-agnostic approximations — the price table stays the
 * authority for exact worth; this layer answers "does this rare LOOK like it
 * sells" with an explainable per-mod breakdown.
 *
 * Since 2026-09-07 the thresholds are the FALLBACK: when a learned-tier
 * store (tierLearning.ts, fed by every trade2 comps fetch) covers a mod's
 * stat id, the observed ranges decide the tier instead.
 */

import { statIdsForMatch, type StatCatalogue } from "./statIds.js";
import { tierForValue, type LearnedTiers } from "./tierLearning.js";

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
  /**
   * trade2 stat text(s) in the catalogue's `#` form ("+# to maximum Life"),
   * for families whose regex cannot be rewritten into one (statIds.ts
   * derives the text from `pattern` when this is absent).
   */
  statText?: string | string[];
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
    // PoE2 prints "Leech #% of Physical Attack Damage as Life" / "Leeches
    // #% of Physical Damage as Life" / "#% of Spell Damage Leeched as Life".
    pattern: String.raw`(?:Leech(?:es)? [\d.]+% of (?:Physical |Attack |Physical Attack )?Damage as Life|[\d.]+% of (?:Physical |Attack |Spell )?Damage Leeched as Life)`,
    weight: 5,
    tiers: { t1: 0.6, t2: 0.4, t3: 0.2 },
    classes: JEWEL,
    statText: [
      "Leech #% of Physical Attack Damage as Life",
      "Leeches #% of Physical Damage as Life",
      "#% of Spell Damage Leeched as Life",
    ],
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
  // ---- Jewel lines the 2026-09-14 guides ask for (docs/features/build-demand.md;
  // thresholds are estimates until the learned-tier store covers them) ----
  {
    id: "jewel-evasion",
    label: "Jewel: evasion rating %",
    pattern: String.raw`\d+% increased Evasion Rating`,
    weight: 5,
    tiers: { t1: 12, t2: 9, t3: 6 },
    classes: JEWEL,
    statText: "#% increased Evasion Rating",
  },
  {
    id: "jewel-mana-on-kill",
    label: "Jewel: recover mana on kill",
    pattern: String.raw`Recover [\d.]+% of maximum Mana on Kill`,
    weight: 6,
    tiers: { t1: 2, t2: 1.5, t3: 1 },
    classes: JEWEL,
    statText: "Recover #% of maximum Mana on Kill",
  },
  {
    id: "jewel-skill-duration",
    label: "Jewel: skill effect duration",
    pattern: String.raw`\d+% increased Skill Effect Duration`,
    weight: 4,
    tiers: { t1: 10, t2: 7, t3: 5 },
    classes: JEWEL,
    statText: "#% increased Skill Effect Duration",
  },
  {
    id: "jewel-ailment-magnitude",
    label: "Jewel: ailment magnitude",
    pattern: String.raw`\d+% increased Magnitude of Ailments you inflict`,
    weight: 5,
    tiers: { t1: 12, t2: 9, t3: 6 },
    classes: JEWEL,
    statText: "#% increased Magnitude of Ailments you inflict",
  },
  {
    id: "jewel-aoe",
    label: "Jewel: area of effect",
    pattern: String.raw`\d+% increased Area of Effect`,
    weight: 4,
    tiers: { t1: 10, t2: 7, t3: 5 },
    classes: JEWEL,
    statText: "#% increased Area of Effect",
  },
  {
    id: "jewel-es-recharge-start",
    label: "Jewel: faster energy shield recharge start",
    pattern: String.raw`\d+% faster start of Energy Shield Recharge`,
    weight: 4,
    tiers: { t1: 12, t2: 9, t3: 6 },
    classes: JEWEL,
    statText: "#% faster start of Energy Shield Recharge",
  },
  {
    id: "jewel-quiver-bonus",
    label: "Jewel: bonuses from equipped quiver",
    pattern: String.raw`\d+% increased bonuses gained from Equipped Quiver`,
    weight: 5,
    tiers: { t1: 20, t2: 14, t3: 8 },
    classes: JEWEL,
    statText: "#% increased bonuses gained from Equipped Quiver",
  },
  {
    // Generic "increased … Damage" (physical, spell, elemental, projectile,
    // minion, "with Bow Skills" …) — declared after the specific families so
    // "Critical Damage Bonus" keeps its own. Thresholds sit above the junk
    // band: nearly every rare jewel carries some damage roll.
    id: "jewel-damage",
    label: "Jewel: increased damage",
    // Thorns is its own (situational) line, not the item's damage.
    pattern: String.raw`\d+% increased (?!Thorns)(?:[A-Za-z' ]+ )?Damage(?! taken)`,
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
    // The regex covers 261 catalogue texts (every "all X Skills" variant
    // unique items print); pin the ones rare gear rolls.
    statText: [
      "+# to Level of all Skills",
      "+# to Level of all Spell Skills",
      "+# to Level of all Attack Skills",
      "+# to Level of all Melee Skills",
      "+# to Level of all Projectile Skills",
      "+# to Level of all Minion Skills",
      "+# to Level of all Elemental Skills",
      "+# to Level of all Fire Skills",
      "+# to Level of all Cold Skills",
      "+# to Level of all Lightning Skills",
      "+# to Level of all Chaos Skills",
      "+# to Level of all Physical Skills",
      "+# to Level of all Fire Spell Skills",
      "+# to Level of all Cold Spell Skills",
      "+# to Level of all Lightning Spell Skills",
      "+# to Level of all Chaos Spell Skills",
      "+# to Level of all Physical Spell Skills",
    ],
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
    // 0.5.0 nerfed energy shield RECHARGE, not capacity; by Forbidden Rites
    // (2026-09-14 research) Chaos Inoculation is on 18% of the ladder and
    // every caster/minion guide converts, so flat ES is wanted again (life
    // still outranks it for the majority of characters).
    weight: 6,
    tiers: { t1: 150, t2: 90, t3: 50 },
  },
  {
    id: "additional-projectiles",
    label: "Additional arrows / projectiles",
    // "+50% Surpassing chance to fire an additional Arrow" (a Gemini Bow
    // implicit) is a chance, not a count: excluded, or its 50 reads as
    // fifty arrows (live 2026-09-15: a bow appraised 98/100 from it).
    pattern: String.raw`^(?!.*chance to fire).*fires? (an|\d+) Additional (Arrow|Projectile)s?`,
    // Chase mod on bows/quivers for the most-played builds (Lightning Arrow
    // Deadeye et al.) — written without digits at its base tier.
    weight: 9,
    tiers: { t1: 2, t2: 1, t3: 1 },
    noNumberValue: 1,
    statText: "Bow Attacks fire # additional Arrows",
  },
  {
    id: "onslaught-on-kill",
    label: "Onslaught on kill",
    pattern: String.raw`\d+% chance to gain Onslaught on Killing`,
    weight: 5,
    tiers: { t1: 15, t2: 10, t3: 5 },
    statText: "#% chance to gain Onslaught on Killing Hits with this Weapon",
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
  // ---- Gear-form lines the trade2 catalogue prints (2026-09-14) -----------
  // Wordings verified against artifacts/tab-admin/trade-stats.json; the
  // thresholds are curated estimates until the learned-tier store covers
  // them (docs/features/build-demand.md lists them as unverified).
  {
    id: "ele-attack-pct",
    label: "Increased elemental damage with attacks",
    pattern: String.raw`\d+% increased Elemental Damage with Attacks`,
    weight: 6,
    // The advanced copy labels 87-100 as tier 1 (fixture: Ghoul Thirst bow).
    tiers: { t1: 87, t2: 65, t3: 45 },
    statText: "#% increased Elemental Damage with Attacks",
  },
  {
    id: "crit-chance-flat",
    label: "Critical hit chance (weapon, flat)",
    // Martial weapons print "+3.5% to Critical Hit Chance"; jewels and
    // passives print the "increased" form (crit-chance below).
    pattern: String.raw`\+?\d+(?:\.\d+)?% to Critical Hit Chance`,
    weight: 6,
    tiers: { t1: 4, t2: 3, t3: 2 },
    statText: "#% to Critical Hit Chance",
  },
  {
    id: "crit-damage-flat",
    label: "Critical damage bonus (flat)",
    pattern: String.raw`\+?\d+% to Critical Damage Bonus`,
    weight: 6,
    tiers: { t1: 35, t2: 25, t3: 15 },
    statText: "#% to Critical Damage Bonus",
  },
  {
    id: "life-leech",
    label: "Physical life leech",
    pattern: String.raw`Leech(?:es)? [\d.]+% of Physical (?:Attack )?Damage as Life`,
    weight: 4,
    // "of the Lamprey" (tier 2) rolls 8-8.9 on the advanced copy fixture.
    tiers: { t1: 9, t2: 7, t3: 5 },
    statText: ["Leech #% of Physical Attack Damage as Life", "Leeches #% of Physical Damage as Life"],
  },
  {
    id: "minion-damage",
    label: "Minion damage",
    pattern: String.raw`Minions deal \d+% increased Damage`,
    weight: 5,
    tiers: { t1: 40, t2: 28, t3: 18 },
    statText: "Minions deal #% increased Damage",
  },
  {
    id: "minion-life",
    label: "Minion maximum life",
    pattern: String.raw`Minions have \d+% increased maximum Life`,
    weight: 5,
    tiers: { t1: 40, t2: 28, t3: 18 },
    statText: "Minions have #% increased maximum Life",
  },
  {
    id: "ignite-magnitude",
    label: "Ignite magnitude",
    pattern: String.raw`\d+% increased Ignite Magnitude`,
    weight: 6,
    tiers: { t1: 30, t2: 20, t3: 12 },
    statText: "#% increased Ignite Magnitude",
  },
  {
    id: "ailment-magnitude",
    label: "Ailment magnitude",
    pattern: String.raw`\d+% increased Magnitude of Ailments you inflict`,
    weight: 6,
    tiers: { t1: 25, t2: 18, t3: 10 },
    statText: "#% increased Magnitude of Ailments you inflict",
  },
  {
    id: "ailment-faster",
    label: "Damaging ailments deal damage faster",
    pattern: String.raw`Damaging Ailments deal damage \d+% faster`,
    weight: 6,
    tiers: { t1: 15, t2: 10, t3: 6 },
    statText: "Damaging Ailments deal damage #% faster",
  },
  {
    id: "mana-on-kill",
    label: "Mana on kill",
    pattern: String.raw`Gain \d+ Mana per enemy killed`,
    weight: 3,
    // "of Devouring" (tier 2) rolls 28-35 on the advanced copy fixture.
    tiers: { t1: 40, t2: 28, t3: 15 },
    statText: "Gain # Mana per enemy killed",
  },
  {
    id: "mana-pct",
    label: "Increased maximum mana",
    pattern: String.raw`\d+% increased maximum Mana`,
    weight: 5,
    tiers: { t1: 20, t2: 14, t3: 8 },
    statText: "#% increased maximum Mana",
  },
  {
    id: "spirit-pct",
    label: "Increased spirit",
    pattern: String.raw`\d+% increased Spirit`,
    weight: 6,
    tiers: { t1: 12, t2: 8, t3: 5 },
    statText: "#% increased Spirit",
  },
  {
    id: "spell-crit",
    label: "Critical hit chance for spells",
    pattern: String.raw`\d+% increased Critical Hit Chance for Spells`,
    weight: 5,
    tiers: { t1: 60, t2: 40, t3: 25 },
    statText: "#% increased Critical Hit Chance for Spells",
  },
  {
    id: "skill-duration",
    label: "Skill effect duration",
    pattern: String.raw`\d+% increased Skill Effect Duration`,
    weight: 4,
    tiers: { t1: 25, t2: 18, t3: 10 },
    statText: "#% increased Skill Effect Duration",
  },
  {
    id: "es-recharge-start",
    label: "Faster energy shield recharge start",
    pattern: String.raw`\d+% faster start of Energy Shield Recharge`,
    weight: 5,
    tiers: { t1: 30, t2: 20, t3: 12 },
    statText: "#% faster start of Energy Shield Recharge",
  },
  {
    id: "es-recharge-rate",
    label: "Energy shield recharge rate",
    pattern: String.raw`\d+% increased Energy Shield Recharge Rate`,
    weight: 4,
    tiers: { t1: 30, t2: 20, t3: 12 },
    statText: "#% increased Energy Shield Recharge Rate",
  },
  {
    id: "cooldown-recovery",
    label: "Cooldown recovery rate",
    pattern: String.raw`\d+% increased Cooldown Recovery Rate`,
    weight: 4,
    tiers: { t1: 20, t2: 14, t3: 8 },
    statText: "#% increased Cooldown Recovery Rate",
  },
  {
    id: "mana-cost-efficiency",
    label: "Mana cost efficiency",
    pattern: String.raw`\d+% increased Mana Cost Efficiency`,
    weight: 4,
    tiers: { t1: 30, t2: 20, t3: 12 },
    statText: "#% increased Mana Cost Efficiency",
  },
  {
    id: "mana-leech",
    label: "Physical mana leech",
    pattern: String.raw`Leech(?:es)? [\d.]+% of Physical (?:Attack )?Damage as Mana`,
    weight: 3,
    tiers: { t1: 6, t2: 4, t3: 2 },
    statText: ["Leech #% of Physical Attack Damage as Mana", "Leeches #% of Physical Damage as Mana"],
  },
  {
    id: "armour-elemental",
    label: "Armour applies to elemental damage",
    pattern: String.raw`\d+% of Armour also applies to Elemental Damage`,
    weight: 6,
    tiers: { t1: 40, t2: 28, t3: 15 },
    statText: "#% of Armour also applies to Elemental Damage",
  },
  {
    id: "global-phys-pct",
    label: "Global physical damage",
    pattern: String.raw`\d+% increased Global Physical Damage`,
    weight: 5,
    tiers: { t1: 25, t2: 18, t3: 10 },
    statText: "#% increased Global Physical Damage",
  },
  {
    id: "extra-damage",
    label: "Damage as extra element",
    pattern: String.raw`Gain \d+% of Damage as Extra (?:Fire|Cold|Lightning|Chaos) Damage`,
    weight: 7,
    tiers: { t1: 15, t2: 10, t3: 6 },
    statText: [
      "Gain #% of Damage as Extra Fire Damage",
      "Gain #% of Damage as Extra Cold Damage",
      "Gain #% of Damage as Extra Lightning Damage",
      "Gain #% of Damage as Extra Chaos Damage",
    ],
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
    // PoE2 prints "+12.3 Life Regeneration per second".
    pattern: String.raw`(?:Regenerate [\d.]+ Life per second|[\d.]+ Life Regeneration per second)`,
    weight: 3,
    tiers: { t1: 30, t2: 18, t3: 8 },
    statText: "# Life Regeneration per second",
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
  /**
   * "learned" = the tier came from trade2-observed ranges (tierLearning.ts);
   * "threshold" = the family's hand-guessed t1/t2/t3 decided.
   */
  source: "learned" | "threshold";
}

export interface ModMatchContext {
  itemClass?: string;
  /** Observed tier ranges; used ahead of the hand thresholds when they cover the stat. */
  learnedTiers?: LearnedTiers;
  /** Stat-id catalogue that keys a mod line to its learned entry. */
  statIds?: StatCatalogue;
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
  context: ModMatchContext = {},
): ModMatch | undefined {
  const line = modText.replace(/\s+/g, " ").trim();
  for (const family of familiesForClass(context.itemClass)) {
    const regex = new RegExp(family.pattern, "i");
    if (!regex.test(line)) continue;
    const numbers = extractNumbers(line);
    if (numbers.length === 0) {
      if (family.noNumberValue === undefined) {
        return { family, judgedValue: 0, tier: 0, source: "threshold" };
      }
      const value = family.noNumberValue;
      const { t1, t2, t3 } = family.tiers;
      const noNumberTier: ModTier = value >= t1 ? 1 : value >= t2 ? 2 : value >= t3 ? 3 : 0;
      return { family, judgedValue: value, tier: noNumberTier, source: "threshold" };
    }
    const judgedValue =
      family.judge === "average2" && numbers.length >= 2
        ? (numbers[0]! + numbers[1]!) / 2
        : numbers[0]!;
    const learned = learnedTier(line, family, judgedValue, context);
    if (learned !== undefined) return { family, judgedValue, tier: learned, source: "learned" };
    const { t1, t2, t3 } = family.tiers;
    const tier: ModTier = judgedValue >= t1 ? 1 : judgedValue >= t2 ? 2 : judgedValue >= t3 ? 3 : 0;
    return { family, judgedValue, tier, source: "threshold" };
  }
  return undefined;
}

/**
 * The learned verdict for one matched line, when the store covers it: the
 * line's exact stat id is tried first, then the family's sibling ids. The
 * item class narrows to that class's ranges (tierForValue falls back to the
 * class-less entry itself).
 */
function learnedTier(
  line: string,
  family: ModFamily,
  judgedValue: number,
  context: ModMatchContext,
): ModTier | undefined {
  if (!context.learnedTiers || !context.statIds) return undefined;
  for (const statId of statIdsForMatch(context.statIds, family.id, line)) {
    const tier = tierForValue(context.learnedTiers, statId, judgedValue, context.itemClass);
    if (tier !== undefined) return tier;
  }
  return undefined;
}
