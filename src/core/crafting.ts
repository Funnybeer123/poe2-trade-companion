/**
 * Crafting planner: given one item's copied text, decide the single most
 * profitable next crafting action, price it in exalted orbs, and attach a
 * 0-100 confidence score that gates automation.
 *
 * The knowledge encoded here comes from patch-0.5-era community research
 * (maxroll crafting overview, timesaver profit/cost guides, the community
 * crafting codex, currency tier lists — see docs/CRAFTING.md for links):
 *
 *   - Magic items hold at most 1 prefix + 1 suffix; rares hold 3 + 3.
 *   - Transmutation/Augmentation/Alchemy are throwaway cheap. Regal ≈ 1 ex,
 *     Exalted IS the base unit, Chaos ≈ 3.5 ex, Annulment ≈ 8 ex,
 *     Fracturing ≈ 9.5 ex, Divine ≈ 88+ ex and drifts through the league.
 *   - The reliably EV-positive lines are additive: slam open affixes on a
 *     rare whose existing mods are already strong, or regal a magic item
 *     with 1-2 strong mods and then slam. Removal orbs (chaos/annul) are the
 *     expensive mistake-fixers — community guides say hoard them, so this
 *     planner only ever RECOMMENDS them, never automates them.
 *   - Value comes from mod coherence: 3+ potent affixes serving one build
 *     archetype. A high roll on an off-archetype mod adds almost nothing.
 *   - Forcing one specific finished item costs 2-5x buying it, so the
 *     planner crafts speculatively and stops at "good enough to sell".
 *
 * Everything here is pure and deterministic: no I/O, no timers, no input.
 * The executor (scripts/craft-gear.ts) owns the mouse.
 */

import { appraiseItem, confidenceBand, type ConfidenceBand, type ItemAppraisal } from "./appraisal.js";
import { MOD_FAMILIES } from "./modKnowledge.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import type { ParsedItem } from "./types.js";

/** Bump when the encoded research meaningfully changes. */
export const CRAFT_KNOWLEDGE_VERSION = "2026-08-30.2";

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export type OrbId =
  | "transmutation"
  | "augmentation"
  | "alchemy"
  | "regal"
  | "exalted"
  | "chaos"
  | "annulment"
  | "divine"
  | "fracturing"
  | "vaal";

/** In-game item names, used to override costs from the user's price table. */
export const ORB_NAMES: Record<OrbId, string> = {
  transmutation: "Orb of Transmutation",
  augmentation: "Orb of Augmentation",
  alchemy: "Orb of Alchemy",
  regal: "Regal Orb",
  exalted: "Exalted Orb",
  chaos: "Chaos Orb",
  annulment: "Orb of Annulment",
  divine: "Divine Orb",
  fracturing: "Fracturing Orb",
  vaal: "Vaal Orb",
};

/**
 * Fallback orb costs in exalted orbs, verified live against poe2scout on
 * 2026-08-30 ("Runes of Aldur" league). League economies drift hard — the
 * previous guide-derived defaults were 10x off for chaos/annul/divine — so
 * the price feed (src/core/priceFeed.ts) keeps the real numbers current in
 * the price table, which always wins when it prices an orb by name.
 */
export const DEFAULT_ORB_COSTS: Record<OrbId, number> = {
  transmutation: 0.17,
  augmentation: 0.1,
  alchemy: 0.45,
  regal: 0.26,
  exalted: 1,
  chaos: 36,
  annulment: 153,
  divine: 405,
  fracturing: 3000,
  vaal: 2.7,
};

/** Merge price-table orb entries (matched by exact name) over the defaults. */
export function orbCosts(priceTable?: PriceTable): Record<OrbId, number> {
  const costs = { ...DEFAULT_ORB_COSTS };
  if (!priceTable) return costs;
  for (const [id, name] of Object.entries(ORB_NAMES) as Array<[OrbId, string]>) {
    const hit = lookupPrice(priceTable, {
      name,
      baseType: name,
      itemClass: "Stackable Currency",
      rarity: "Currency",
    });
    if (hit && hit.entry.match.name !== undefined && hit.value > 0) {
      costs[id] = hit.value;
    }
  }
  return costs;
}

// ---------------------------------------------------------------------------
// Archetypes: which mod families make THIS item class sell
// ---------------------------------------------------------------------------

export interface Archetype {
  id: string;
  /** Case-insensitive regex over the parsed item class. */
  classPattern: string;
  /** Mod-family ids (modKnowledge.ts) buyers want on this slot. */
  desirableFamilies: string[];
  /**
   * Probability one random added mod lands in a desirable family at a
   * useful tier. No public mod-pool odds exist for PoE2, so these are
   * conservative editable estimates; the confidence score discounts for it.
   */
  pGoodSlam: number;
}

export const ARCHETYPES: Archetype[] = [
  {
    id: "caster-weapon",
    classPattern: "^(Wands?|Staves|Staff|Sceptres?)$",
    desirableFamilies: [
      "skill-levels", "spell-damage", "cast-speed", "crit-chance", "crit-damage", "mana", "skill-speed",
    ],
    pGoodSlam: 0.28,
  },
  {
    id: "attack-weapon",
    classPattern:
      "^(Bows?|Crossbows?|Quarterstaves|Quarterstaff|One Hand(ed)? .*|Two Hand(ed)? .*|Spears?|Maces?|Flails?|Axes?|Swords?|Daggers?|Claws?)$",
    // 0.5 meta (Lightning Arrow Deadeye is the most-played build): flat
    // phys+ele, additional arrows, and attack speed carry bow prices.
    desirableFamilies: [
      "phys-pct", "adds-phys", "adds-ele", "attack-speed", "crit-chance", "crit-damage", "skill-levels", "skill-speed", "additional-projectiles", "onslaught-on-kill",
    ],
    pGoodSlam: 0.3,
  },
  {
    id: "quiver",
    classPattern: "^Quivers?$",
    desirableFamilies: [
      "adds-ele", "adds-phys", "attack-speed", "additional-projectiles", "crit-chance", "crit-damage", "life", "onslaught-on-kill",
    ],
    pGoodSlam: 0.3,
  },
  {
    id: "focus",
    classPattern: "^(Foci|Focus)$",
    desirableFamilies: [
      "spell-damage", "cast-speed", "crit-chance", "crit-damage", "skill-levels", "mana", "energy-shield-flat",
    ],
    pGoodSlam: 0.28,
  },
  {
    id: "body-armour",
    classPattern: "^Body Armours?$",
    desirableFamilies: [
      "life", "energy-shield-flat", "spirit", "all-res", "chaos-res", "fire-res", "cold-res", "lightning-res",
    ],
    pGoodSlam: 0.32,
  },
  {
    id: "boots",
    classPattern: "^Boots$",
    desirableFamilies: [
      "movement-speed", "life", "energy-shield-flat", "all-res", "chaos-res", "fire-res", "cold-res", "lightning-res",
    ],
    pGoodSlam: 0.32,
  },
  {
    id: "gloves",
    classPattern: "^Gloves$",
    // "Flat elemental damage to attacks on as many pieces as possible" is
    // the 0.5 attack-meta rule; gloves and rings are where it lands.
    desirableFamilies: [
      "life", "adds-ele", "adds-phys", "attack-speed", "all-res", "chaos-res", "fire-res", "cold-res", "lightning-res",
    ],
    pGoodSlam: 0.3,
  },
  {
    id: "armour-slot",
    classPattern: "^(Helmets?|Shields?|Bucklers?)$",
    desirableFamilies: [
      "life", "energy-shield-flat", "all-res", "chaos-res", "fire-res", "cold-res", "lightning-res", "attribute",
    ],
    pGoodSlam: 0.3,
  },
  {
    id: "amulet",
    classPattern: "^Amulets?$",
    desirableFamilies: [
      "skill-levels", "spirit", "life", "all-attributes", "all-res", "chaos-res", "rarity-found", "energy-shield-flat",
    ],
    pGoodSlam: 0.26,
  },
  {
    id: "ring-belt",
    classPattern: "^(Rings?|Belts?)$",
    desirableFamilies: [
      "life", "all-res", "chaos-res", "fire-res", "cold-res", "lightning-res", "rarity-found", "all-attributes", "mana", "adds-ele",
    ],
    pGoodSlam: 0.3,
  },
];

export function archetypeForClass(itemClass: string): Archetype | undefined {
  const trimmed = itemClass.trim();
  return ARCHETYPES.find((entry) => new RegExp(entry.classPattern, "i").test(trimmed));
}

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/**
 * Appraisal score → estimated sale value in exalted. Deliberately steeper
 * than the appraisal engine's price-table curve: the trade market is convex
 * (each additional coherent mod multiplies price), and the research stop
 * rules only work when the model sees that convexity. Calibration points:
 * score 55 ≈ 1 ex, 70 ≈ 3 ex, 85 ≈ 7 ex, 100 ≈ 16 ex.
 */
export function exaltedFromScore(score: number): number {
  const clamped = Math.min(100, score);
  if (clamped <= 40) return 0;
  return Math.round((Math.pow(2, (clamped - 40) / 15) - 1) * 100) / 100;
}

/**
 * Sale value of a magic item carrying one coherent strong mod: "regal
 * fodder" the market buys as crafting stock. Anchors the near-free ladder
 * steps (transmute/augment) without pretending they finish an item.
 */
export const MAGIC_FODDER_VALUE = 0.6;

/** Mean knowledge-base weight of an archetype's desirable families. */
function meanDesirableWeight(archetype: Archetype): number {
  const weights = archetype.desirableFamilies
    .map((id) => MOD_FAMILIES.find((family) => family.id === id)?.weight ?? 0)
    .filter((weight) => weight > 0);
  if (weights.length === 0) return 5;
  return weights.reduce((total, weight) => total + weight, 0) / weights.length;
}

/** Same scale the appraisal uses: FULL_SCORE_POINTS(70) points = score 100. */
function scoreDeltaFromPoints(points: number): number {
  return (points / 70) * 100;
}

/**
 * Expected score gain of ONE random added mod: a good hit lands a desirable
 * family between tier 1 and 2 (weight × 2.2 points); a miss contributes
 * residual noise. The value curve, not a headroom damp, prices the gain.
 */
export function expectedSlamGain(archetype: Archetype | undefined, currentScore: number): {
  pGood: number;
  deltaGood: number;
  deltaWeak: number;
  expectedDelta: number;
} {
  void currentScore; // the convex value curve prices score position instead
  const pGood = archetype?.pGoodSlam ?? 0.2;
  const weight = archetype ? meanDesirableWeight(archetype) : 5;
  const deltaGood = scoreDeltaFromPoints(weight * 2.2);
  const deltaWeak = scoreDeltaFromPoints(1);
  return {
    pGood,
    deltaGood,
    deltaWeak,
    expectedDelta: pGood * deltaGood + (1 - pGood) * deltaWeak,
  };
}

/** Expected profit of one exalt slam at the given score, in exalted. */
export function slamEv(
  score: number,
  archetype: Archetype | undefined,
  exaltCost: number,
): number {
  const gain = expectedSlamGain(archetype, score);
  const current = exaltedFromScore(score);
  return (
    gain.pGood * (exaltedFromScore(score + gain.deltaGood) - current) +
    (1 - gain.pGood) * (exaltedFromScore(score + gain.deltaWeak) - current) -
    exaltCost
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type CraftAction =
  | "identify"
  | "transmute"
  | "augment"
  | "regal"
  | "exalt"
  | "chaos-swap"
  | "annul"
  | "divine"
  | "sell"
  | "hold"
  | "skip";

/** Actions the executor may perform without a human. Additive orbs only —
 *  removal (chaos/annul), value rerolls (divine), and corruption stay manual
 *  per the research: they are the expensive ways to ruin an item. */
export const AUTO_CRAFT_WHITELIST: ReadonlySet<CraftAction> = new Set([
  "transmute",
  "augment",
  "regal",
  "exalt",
]);

export interface CraftPolicy {
  /** Confidence at or above which the executor may act unattended. */
  minAutoConfidence: number;
  /** Hard orb spend per item, in exalted. */
  perItemBudget: number;
  /** Item level under which gear is not worth orbs at all. */
  minItemLevel: number;
  /** Appraisal score at which the item is "good enough — list it". */
  sellAtScore: number;
  /** Never slam an item already worth at least this many exalted. */
  maxAutoItemValue: number;
}

export const DEFAULT_CRAFT_POLICY: CraftPolicy = {
  minAutoConfidence: 70,
  perItemBudget: 8,
  minItemLevel: 65,
  sellAtScore: 62,
  maxAutoItemValue: 25,
};

export interface CraftPlan {
  action: CraftAction;
  orb?: OrbId;
  /** Cost of THIS step in exalted. */
  cost: number;
  /** Expected sale-value change of this step minus its cost, in exalted. */
  expectedProfit: number;
  /** 0-100: how sure the planner is that acting (or stopping) is right. */
  confidence: number;
  band: ConfidenceBand;
  /** True when the executor may perform this step unattended. */
  autoEligible: boolean;
  reasons: string[];
  /** Current appraisal the plan was built from. */
  appraisal: ItemAppraisal;
  estimatedValue: number;
  archetypeId?: string;
  /** Mods (their text) that match the slot's desirable families. */
  onArchetypeMods: string[];
  openAffixes: number;
}

export interface CraftPlanOptions {
  priceTable?: PriceTable;
  policy?: Partial<CraftPolicy>;
  /** Exalted already spent on this item (budget tracking across steps). */
  spentSoFar?: number;
  /** Pre-parsed item to skip re-parsing. */
  parsed?: ParsedItem;
}

function explicitMods(parsed: ParsedItem): string[] {
  return parsed.mods.filter((mod) => !mod.implicit).map((mod) => mod.text);
}

function maxAffixes(rarity: string): number {
  if (/^rare$/i.test(rarity)) return 6;
  if (/^magic$/i.test(rarity)) return 2;
  return 0;
}

interface ConfidenceInput {
  base: number;
  adjustments: Array<{ delta: number; why: string }>;
}

function settleConfidence(input: ConfidenceInput, reasons: string[]): number {
  let value = input.base;
  for (const adjustment of input.adjustments) {
    value += adjustment.delta;
    reasons.push(
      `${adjustment.delta >= 0 ? "+" : ""}${Math.round(adjustment.delta)} confidence: ${adjustment.why}`,
    );
  }
  return Math.round(Math.max(5, Math.min(95, value)));
}

/**
 * Decide the next crafting step for one item. Call again after every applied
 * orb — the plan is always "one step, then re-read the item".
 */
export function planCraft(itemText: string, options: CraftPlanOptions = {}): CraftPlan {
  const policy: CraftPolicy = { ...DEFAULT_CRAFT_POLICY, ...options.policy };
  const spent = Math.max(0, options.spentSoFar ?? 0);
  const budgetLeft = policy.perItemBudget - spent;
  const costs = orbCosts(options.priceTable);
  const reasons: string[] = [];

  const finish = (
    partial: Omit<
      CraftPlan,
      "confidence" | "band" | "autoEligible" | "reasons" | "estimatedValue"
    > & { confidenceInput: ConfidenceInput },
  ): CraftPlan => {
    const confidence = settleConfidence(partial.confidenceInput, reasons);
    const estimatedValue =
      partial.appraisal.estimatedValue?.amount ?? exaltedFromScore(partial.appraisal.valueScore);
    const autoEligible =
      AUTO_CRAFT_WHITELIST.has(partial.action) &&
      confidence >= policy.minAutoConfidence &&
      partial.expectedProfit > 0 &&
      partial.cost <= budgetLeft &&
      estimatedValue <= policy.maxAutoItemValue;
    return {
      action: partial.action,
      ...(partial.orb ? { orb: partial.orb } : {}),
      cost: partial.cost,
      expectedProfit: Math.round(partial.expectedProfit * 100) / 100,
      confidence,
      band: confidenceBand(confidence),
      autoEligible,
      reasons,
      appraisal: partial.appraisal,
      estimatedValue,
      ...(partial.archetypeId ? { archetypeId: partial.archetypeId } : {}),
      onArchetypeMods: partial.onArchetypeMods,
      openAffixes: partial.openAffixes,
    };
  };

  if (!looksLikePoeItemText(itemText)) {
    const appraisal = appraiseItem(itemText);
    reasons.push("Not recognizable item text — nothing to craft.");
    return finish({
      action: "skip",
      cost: 0,
      expectedProfit: 0,
      appraisal,
      onArchetypeMods: [],
      openAffixes: 0,
      confidenceInput: { base: 90, adjustments: [] },
    });
  }

  const parsed = options.parsed ?? parseItemText(itemText);
  const appraisal = appraiseItem(itemText, {
    ...(options.priceTable ? { priceTable: options.priceTable } : {}),
    parsed,
  });
  const archetype = archetypeForClass(parsed.itemClass);
  const mods = explicitMods(parsed);
  const openAffixes = Math.max(0, maxAffixes(parsed.rarity) - mods.length);
  const onArchetypeMods = archetype
    ? appraisal.mods
        .filter(
          (mod) =>
            mod.familyId !== undefined &&
            archetype.desirableFamilies.includes(mod.familyId) &&
            (mod.tier === 1 || mod.tier === 2 || mod.tier === 3),
        )
        .map((mod) => mod.text)
    : [];

  const common = {
    appraisal,
    ...(archetype ? { archetypeId: archetype.id } : {}),
    onArchetypeMods,
    openAffixes,
  };

  // --- Absolute stops -----------------------------------------------------
  if (parsed.corrupted) {
    reasons.push("Corrupted — no further crafting is possible.");
    return finish({
      action: appraisal.valueScore >= policy.sellAtScore ? "sell" : "skip",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 92, adjustments: [] },
    });
  }
  if (!parsed.identified) {
    reasons.push("Unidentified — identify before any orb decision.");
    return finish({
      action: "identify",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 88, adjustments: [] },
    });
  }
  if (/^unique$/i.test(parsed.rarity)) {
    reasons.push("Unique items are not orb-craftable — price and sell as-is.");
    return finish({
      action: "sell",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 85, adjustments: [] },
    });
  }
  const itemLevel = parsed.itemLevel ?? 0;
  if (itemLevel > 0 && itemLevel < policy.minItemLevel && appraisal.valueScore < policy.sellAtScore) {
    reasons.push(
      `Item level ${itemLevel} < ${policy.minItemLevel}: high mod tiers cannot roll — not craft stock.`,
    );
    return finish({
      action: "skip",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 82, adjustments: [] },
    });
  }

  // --- Value context ------------------------------------------------------
  const currentValue =
    appraisal.estimatedValue?.amount ?? exaltedFromScore(appraisal.valueScore);
  const rarity = parsed.rarity.toLowerCase();
  // A rare with open affixes and a +EV slam gets the slam BEFORE any sell
  // stop: additive orbs can't make the item worse, so listing first would
  // leave the cheap upside on the table ("exalt only 4-5 mod rares with
  // open slots" — the research's core play).
  const slamFirst =
    rarity === "rare" &&
    openAffixes > 0 &&
    archetype !== undefined &&
    onArchetypeMods.length >= 1 &&
    slamEv(appraisal.valueScore, archetype, costs.exalted) > 0 &&
    currentValue <= policy.maxAutoItemValue;

  if (appraisal.valueScore >= policy.sellAtScore && !slamFirst) {
    reasons.push(
      `Score ${appraisal.valueScore} ≥ sell threshold ${policy.sellAtScore} — good enough, list it. ` +
        "Chasing perfection costs more than the sale-price difference (research stop rule).",
    );
    if (currentValue > policy.maxAutoItemValue && openAffixes > 0) {
      reasons.push(
        `Estimated ${currentValue.toFixed(1)} ex exceeds the ${policy.maxAutoItemValue} ex auto cap — ` +
          "any further craft on this item is a manual decision.",
      );
    }
    return finish({
      action: "sell",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: {
        base: 62,
        adjustments: [
          { delta: appraisal.confidence >= 65 ? 15 : 0, why: "appraisal itself is high-confidence" },
          { delta: onArchetypeMods.length >= 2 ? 8 : 0, why: "mods are coherent for the slot" },
        ],
      },
    });
  }

  // --- Craft ladder -------------------------------------------------------
  const knowledgeAdjust: Array<{ delta: number; why: string }> = [
    archetype
      ? { delta: 10, why: `archetype profile ${archetype.id} covers this item class` }
      : { delta: -12, why: `no archetype profile for class "${parsed.itemClass}"` },
  ];
  if (mods.length > 0) {
    const matched = appraisal.mods.filter((mod) => mod.familyId !== undefined).length;
    const coverage = matched / mods.length;
    knowledgeAdjust.push({
      delta: Math.round(coverage * 12) - 4,
      why: `mod knowledge covers ${matched}/${mods.length} explicit mods`,
    });
  }
  if (itemLevel >= 79) knowledgeAdjust.push({ delta: 5, why: `item level ${itemLevel} reaches top tiers` });

  if (rarity === "normal") {
    // Ladder entry: transmute is near-free; only bother on archetype bases
    // with tier headroom. A coherent strong mod makes the magic item sell
    // as regal fodder even when the ladder goes no further.
    if (!archetype || itemLevel < policy.minItemLevel) {
      reasons.push("White base without a demand profile — not worth the ladder.");
      return finish({
        action: "skip",
        cost: 0,
        expectedProfit: 0,
        ...common,
        confidenceInput: { base: 75, adjustments: [] },
      });
    }
    const gain = expectedSlamGain(archetype, appraisal.valueScore);
    const ev = gain.pGood * MAGIC_FODDER_VALUE - costs.transmutation;
    reasons.push(
      `White ${parsed.itemClass} ilvl ${itemLevel}: transmute (${costs.transmutation.toFixed(2)} ex). ` +
        `A coherent hit (~${Math.round(gain.pGood * 100)}%) makes regal fodder worth ~${MAGIC_FODDER_VALUE} ex; ` +
        "then augment and reassess.",
    );
    return finish({
      action: "transmute",
      orb: "transmutation",
      cost: costs.transmutation,
      expectedProfit: ev,
      ...common,
      confidenceInput: {
        base: 55,
        adjustments: [
          ...knowledgeAdjust,
          { delta: 12, why: "additive ladder steps cannot brick the item" },
          { delta: ev > 0 ? 4 : -20, why: "expected-value margin of the ladder entry" },
        ],
      },
    });
  }

  if (rarity === "magic") {
    if (mods.length <= 1) {
      const gain = expectedSlamGain(archetype, appraisal.valueScore);
      const ev = gain.pGood * MAGIC_FODDER_VALUE - costs.augmentation;
      reasons.push("Magic with one affix — augmentation is near-free and purely additive.");
      return finish({
        action: "augment",
        orb: "augmentation",
        cost: costs.augmentation,
        expectedProfit: archetype ? ev : 0.02,
        ...common,
        confidenceInput: {
          base: 60,
          adjustments: [...knowledgeAdjust, { delta: 14, why: "additive step, cost is negligible" }],
        },
      });
    }
    // Two affixes: regal only when at least one mod is worth building on.
    if (onArchetypeMods.length >= 1) {
      const gain = expectedSlamGain(archetype, appraisal.valueScore);
      const projected = appraisal.valueScore + gain.expectedDelta;
      // Regal's real payoff is the option it opens: a rare with three open
      // affixes to slam. Count one follow-up slam's EV when positive.
      const followUp = Math.max(0, slamEv(projected, archetype, costs.exalted));
      const ev = exaltedFromScore(projected) - currentValue - costs.regal + followUp;
      reasons.push(
        `Magic ${parsed.itemClass} with ${onArchetypeMods.length} on-archetype mod(s) — ` +
          `regal to rare (research line: buy/keep magics with strong mods, regal, then slam). ` +
          `Follow-up slam option adds ${followUp.toFixed(2)} ex of expected value.`,
      );
      return finish({
        action: "regal",
        orb: "regal",
        cost: costs.regal,
        expectedProfit: ev,
        ...common,
        confidenceInput: {
          base: 55,
          adjustments: [
            ...knowledgeAdjust,
            { delta: 12, why: "additive step (regal keeps both existing mods)" },
            { delta: onArchetypeMods.length >= 2 ? 8 : 3, why: "existing mods fit the slot's demand" },
            { delta: ev > 0 ? 4 : -15, why: "expected-value margin" },
          ],
        },
      });
    }
    reasons.push("Magic item whose mods serve no coherent buyer — orbs are better spent elsewhere.");
    return finish({
      action: "skip",
      cost: 0,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 70, adjustments: knowledgeAdjust },
    });
  }

  // Rare.
  if (openAffixes > 0) {
    const gain = expectedSlamGain(archetype, appraisal.valueScore);
    const scoreValue = exaltedFromScore(appraisal.valueScore);
    const evGood = exaltedFromScore(appraisal.valueScore + gain.deltaGood) - scoreValue;
    const evWeak = exaltedFromScore(appraisal.valueScore + gain.deltaWeak) - scoreValue;
    const ev = gain.pGood * evGood + (1 - gain.pGood) * evWeak - costs.exalted;
    const worthIt = onArchetypeMods.length >= 1 && ev > 0;
    reasons.push(
      `Rare with ${openAffixes} open affix(es), ${onArchetypeMods.length} on-archetype mod(s). ` +
        `Exalt slam EV ${ev >= 0 ? "+" : ""}${ev.toFixed(2)} ex ` +
        `(p≈${Math.round(gain.pGood * 100)}% of +${gain.deltaGood.toFixed(0)} score). ` +
        "Slams are additive — the item never gets worse, only the orb is at risk.",
    );
    if (!worthIt) {
      reasons.push("Not enough on-archetype substance to pay for the slam — hold or vendor.");
      return finish({
        action: mods.length >= 4 ? "hold" : "skip",
        cost: 0,
        expectedProfit: 0,
        ...common,
        confidenceInput: { base: 68, adjustments: knowledgeAdjust },
      });
    }
    if (costs.exalted > budgetLeft) {
      reasons.push(
        `Per-item budget exhausted (${spent.toFixed(2)}/${policy.perItemBudget} ex spent) — stop and list.`,
      );
      return finish({
        action: "sell",
        cost: 0,
        expectedProfit: 0,
        ...common,
        confidenceInput: { base: 80, adjustments: [] },
      });
    }
    return finish({
      action: "exalt",
      orb: "exalted",
      cost: costs.exalted,
      expectedProfit: ev,
      ...common,
      confidenceInput: {
        base: 52,
        adjustments: [
          ...knowledgeAdjust,
          { delta: 8, why: "slam is additive — downside capped at the orb cost" },
          { delta: Math.min(12, ev * 6), why: "expected-value margin" },
          { delta: onArchetypeMods.length >= 2 ? 6 : 0, why: "multiple coherent mods already present" },
        ],
      },
    });
  }

  // Full rare: removal territory — recommend, never automate.
  const badMods = appraisal.mods.filter((mod) => mod.familyId === undefined || mod.tier === 0);
  if (onArchetypeMods.length >= 3 && badMods.length >= 1 && badMods.length <= 2) {
    reasons.push(
      `Full rare with ${onArchetypeMods.length} strong mods and ${badMods.length} dud(s) ` +
        `(${badMods.map((mod) => `"${mod.text}"`).join(", ")}). ` +
        `A chaos swap (${costs.chaos} ex) targets a random mod — ${Math.round(
          (badMods.length / Math.max(mods.length, 1)) * 100,
        )}% chance it hits a dud. Manual call: removal orbs are the expensive way to ruin an item.`,
    );
    return finish({
      action: "chaos-swap",
      orb: "chaos",
      cost: costs.chaos,
      expectedProfit: 0,
      ...common,
      confidenceInput: {
        base: 40,
        adjustments: [
          ...knowledgeAdjust,
          { delta: -10, why: "removal orbs can delete a good mod — never automated" },
        ],
      },
    });
  }
  const t1Count = appraisal.mods.filter((mod) => mod.tier === 1).length;
  if (t1Count >= 2 && currentValue >= orbCosts(options.priceTable).divine * 0.5) {
    reasons.push(
      `${t1Count} top-tier families on a full rare — a divine (${costs.divine} ex) rerolls values. ` +
        "Only sensible when rolls sit low in their ranges; the planner cannot see ranges, so this stays manual.",
    );
    return finish({
      action: "divine",
      orb: "divine",
      cost: costs.divine,
      expectedProfit: 0,
      ...common,
      confidenceInput: { base: 35, adjustments: knowledgeAdjust },
    });
  }

  reasons.push("Rare is full and below the sell bar with no clean fix — hold for manual review.");
  return finish({
    action: "hold",
    cost: 0,
    expectedProfit: 0,
    ...common,
    confidenceInput: { base: 60, adjustments: knowledgeAdjust },
  });
}

/** One journal line per applied step; the executor appends these as JSONL. */
export interface CraftStepRecord {
  at: string;
  cell: { row: number; col: number };
  action: CraftAction;
  orb?: OrbId;
  cost: number;
  confidence: number;
  scoreBefore: number;
  scoreAfter?: number;
  itemName: string;
  itemClass: string;
  dryRun: boolean;
}
