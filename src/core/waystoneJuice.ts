/**
 * T15 waystone juicing planner. Separate from gear crafting so Alchemy and
 * Vaal stay off the gear whitelist — maps are a fixed recipe, not EV crafting.
 *
 * Recipe (hunt the best T15, then corrupt it):
 *   Normal → Alchemy (4 new mods)
 *   Magic with weak loot mods → Alchemy (PoE2 rerolls the blue into a new 4-mod rare)
 *   Magic with quantity / stacked rarity → Regal (keep the hit)
 *   Rare (any mods) → 3 Exalts, then Vaal
 *   Any uncorrupted 6-mod T15 → Vaal, including former "premium" maps
 *
 * One Ctrl+C sweep. Do not re-read the tab between orb batches.
 *
 * Knowledge is patch-0.5 / Runes of Aldur community practice plus the
 * poe2ref waystone modifier table (2026-09-20).
 */

import { ORB_NAMES, type OrbId } from "./crafting.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { ItemMod, ParsedItem } from "./types.js";

/** Bump when the encoded map-mod research meaningfully changes. */
export const WAYSTONE_JUICE_KNOWLEDGE_VERSION = "2026-09-20.5";

export const JUICE_TARGET_TIER = 15;
export const JUICE_RARE_AFFIX_CAP = 6;

export type JuiceAction = "skip" | "alchemy" | "regal" | "exalt" | "vaal" | "done";

export const JUICE_ORBS: ReadonlySet<OrbId> = new Set(["alchemy", "regal", "exalted", "vaal"]);

export type WaystoneRewardTag =
  | "quantity"
  | "rarity"
  | "pack-size"
  | "rare-monsters"
  | "waystone-drop"
  | "extra-content"
  | "effectiveness";

export type WaystoneDangerTag =
  | "less-recovery"
  | "less-cooldown"
  | "minus-max-res"
  | "temporal-chains"
  | "extra-chaos"
  | "high-monster-life"
  | "monster-crit";

interface AffixFamily {
  id: string;
  pattern: RegExp;
  danger?: WaystoneDangerTag;
}

/** Distinctive difficulty lines — one family is one explicit affix. */
const DISTINCTIVE_FAMILIES: AffixFamily[] = [
  { id: "destructive", pattern: /critical hit chance|critical damage bonus/i, danger: "monster-crit" },
  { id: "fleeting", pattern: /attack, cast and movement speed/i },
  { id: "frostbitten", pattern: /damage as extra cold/i },
  { id: "impacting", pattern: /stun buildup/i },
  { id: "infernal", pattern: /damage as extra fire/i },
  { id: "painful", pattern: /increased monster damage/i },
  { id: "penetrating", pattern: /penetrates? .+ elemental resist/i },
  { id: "precise", pattern: /increased accuracy/i },
  { id: "profane", pattern: /damage as extra chaos/i, danger: "extra-chaos" },
  { id: "puncturing", pattern: /bleeding on hit|inflict bleeding/i },
  { id: "shattering", pattern: /break armour/i },
  { id: "thunderous", pattern: /damage as extra lightning/i },
  { id: "tough", pattern: /more monster life/i, danger: "high-monster-life" },
  { id: "venomous", pattern: /poison on hit/i },
  { id: "flames", pattern: /ignited ground|patches of ignited/i },
  { id: "buffering", pattern: /extra maximum energy shield/i },
  { id: "drought", pattern: /reduced flask charges/i },
  { id: "enduring", pattern: /monsters are armoured/i },
  { id: "enfeebling", pattern: /cursed with enfeeble/i },
  { id: "erosion", pattern: /cursed with elemental weakness/i },
  { id: "evasion", pattern: /monsters are evasive/i },
  { id: "exposure", pattern: /maximum player resistances/i, danger: "minus-max-res" },
  { id: "fatigue", pattern: /less cooldown recovery/i, danger: "less-cooldown" },
  { id: "hexwarding", pattern: /less effect of curses/i },
  { id: "obstruction", pattern: /reduced extra damage from critical/i },
  { id: "overpowering", pattern: /elemental ailment application/i },
  { id: "shocking", pattern: /shocked ground/i },
  { id: "sleet", pattern: /chilled ground/i },
  { id: "slowing", pattern: /temporal chains/i, danger: "temporal-chains" },
  { id: "smothering", pattern: /less recovery rate of life/i, danger: "less-recovery" },
  { id: "prism", pattern: /monster elemental resistances/i },
  { id: "unwavering", pattern: /stun threshold|ailment threshold/i },
];

const METADATA_AFFIX = /^(waystone tier|revives available)\b/i;
const COMPANION_AFFIX =
  /more waystones found|waystone drop chance|more pack size|monster pack size|increased pack size|^pack size:|more rarity|item rarity:|rarity of items|item quantity:|quantity of items|more magic and rare|increased magic monsters|increased number of rare|chance of monster modifiers|more effectiveness|increased effectiveness of monsters/i;
const COLON_REWARD_AFFIX =
  /^(magic monsters|item quantity|item rarity|monster pack size|pack size|waystone drop chance|quantity of items found|rarity of items found)\s*:/i;

const REWARD_PATTERNS: Array<{ tag: WaystoneRewardTag; pattern: RegExp }> = [
  { tag: "quantity", pattern: /item quantity|quantity of items found|increased quantity/i },
  { tag: "rarity", pattern: /item rarity|rarity of items found|more rarity/i },
  { tag: "pack-size", pattern: /pack size/i },
  { tag: "rare-monsters", pattern: /rare monsters|magic and rare|magic monsters/i },
  { tag: "waystone-drop", pattern: /waystones found|waystone drop chance/i },
  { tag: "extra-content", pattern: /additional essence|additional shrine|additional strongbox/i },
  { tag: "effectiveness", pattern: /monster effectiveness|increased effectiveness of monsters|more effectiveness/i },
];

const DANGER_PATTERNS: Array<{ tag: WaystoneDangerTag; pattern: RegExp }> = [
  { tag: "less-recovery", pattern: /less recovery rate of life/i },
  { tag: "less-cooldown", pattern: /less cooldown recovery/i },
  { tag: "minus-max-res", pattern: /maximum player resistances/i },
  { tag: "temporal-chains", pattern: /temporal chains/i },
  { tag: "extra-chaos", pattern: /damage as extra chaos/i },
  { tag: "high-monster-life", pattern: /more monster life/i },
  { tag: "monster-crit", pattern: /critical hit chance|critical damage bonus/i },
];

export interface WaystoneInspection {
  isWaystone: boolean;
  name: string;
  rarity: string;
  identified: boolean;
  corrupted: boolean;
  tier?: number;
  explicitAffixCount: number;
  maxAffixes: number;
  rewardTags: WaystoneRewardTag[];
  dangerTags: WaystoneDangerTag[];
  score: number;
  reasons: string[];
}

export interface JuicePlan {
  action: JuiceAction;
  orb?: OrbId;
  autoEligible: boolean;
  reasons: string[];
  inspection: WaystoneInspection;
  score: number;
}

export interface JuicePlanOptions {
  parsed?: ParsedItem;
  /** Live executor: last Exalt left the clipboard text unchanged. */
  exaltDidNothing?: boolean;
}

export interface JuiceStepRecord {
  at: string;
  cell: { row: number; col: number };
  action: JuiceAction;
  orb?: OrbId;
  score: number;
  rewardTags: WaystoneRewardTag[];
  dangerTags: WaystoneDangerTag[];
  itemName: string;
  itemClass: string;
  tier?: number;
  affixCount: number;
  dryRun: boolean;
  parked?: boolean;
}

/** After Vaal, only a T14/T16 leaves the T15 filter. A corrupted T15 stays. */
export type VaalAftermath = "stayed-t15" | "ejected" | "unknown";
export type VaalAfterClick = "stay" | "held" | "still-clean" | "unknown";
export type VaalProbeDecision = "nothing" | "park-tier-change";

/** Whole-line Corrupted / Twice Corrupted, including odd clipboard whitespace. */
export function itemTextLooksCorrupted(text: string): boolean {
  return /^\s*(?:twice\s+)?corrupted\s*$/im.test(text);
}

/**
 * Live Ctrl+C often lands the header/mods before the footer. Do not call a
 * T15 "still clean" until Corrupted, Unidentified, or the map-device line is
 * present — otherwise already-corrupted stones get Vaaled again.
 */
export function waystoneClipboardComplete(text: string): boolean {
  if (!looksLikePoeItemText(text)) return false;
  if (itemTextLooksCorrupted(text)) return true;
  if (/^\s*Unidentified\s*$/im.test(text)) return true;
  return /can be used in a map device/i.test(text);
}

export function vaalAftermath(afterText: string): VaalAftermath {
  if (!looksLikePoeItemText(afterText)) return "unknown";
  const inspection = inspectWaystone(parseItemText(afterText));
  if (!inspection.isWaystone) return "unknown";
  if (inspection.tier === JUICE_TARGET_TIER) return "stayed-t15";
  return "ejected";
}

/** Ctrl+C the well after Vaal. A still-clean T15 means the click missed. */
export function vaalAfterClick(afterText: string): VaalAfterClick {
  if (!looksLikePoeItemText(afterText)) return "held";
  const inspection = inspectWaystone(parseItemText(afterText));
  if (!inspection.isWaystone) return "held";
  if (inspection.tier !== JUICE_TARGET_TIER) return "held";
  if (inspection.corrupted) return "stay";
  if (!waystoneClipboardComplete(afterText)) return "unknown";
  return "still-clean";
}

/** Park only when the well is empty or the copied stone is no longer T15. */
export function shouldParkVaalResult(aftermath: VaalAftermath): boolean {
  return aftermath === "ejected";
}

export function decideVaalProbe(text: string): VaalProbeDecision {
  return vaalAfterClick(text) === "held" ? "park-tier-change" : "nothing";
}

/** XV tile on the Maps unique tab (below the T15 count badge). */
export const MAPS_TIER15_CLICK = { x: 1013, y: 572 } as const;

export function remainingExaltSlams(inspection: WaystoneInspection): number {
  if (!/^rare$/i.test(inspection.rarity)) return 0;
  return Math.max(0, JUICE_RARE_AFFIX_CAP - inspection.explicitAffixCount);
}

/** Clean rarity/quantity and no harmful suffixes — classification only; still Vaal at 6. */
export function isPremiumWaystone(inspection: WaystoneInspection): boolean {
  if (!inspection.isWaystone || inspection.corrupted) return false;
  if (inspection.tier !== JUICE_TARGET_TIER) return false;
  if (inspection.dangerTags.length > 0) return false;
  return inspection.rewardTags.includes("rarity") || inspection.rewardTags.includes("quantity");
}

/** Quantity, or rarity stacked with another juice hook — worth keeping on a magic stone. */
export function isKeepableMagicWaystone(inspection: WaystoneInspection): boolean {
  const tags = new Set(inspection.rewardTags);
  if (tags.has("quantity")) return true;
  return (
    tags.has("rarity") &&
    (tags.has("pack-size") || tags.has("waystone-drop") || tags.has("effectiveness"))
  );
}

/** Any loot/density hook — worth slamming a rare to 6 instead of abandoning it. */
export function isWorthExaltingWaystone(inspection: WaystoneInspection): boolean {
  if (!inspection.identified) return true;
  const tags = new Set(inspection.rewardTags);
  return (
    tags.has("quantity") ||
    tags.has("rarity") ||
    tags.has("pack-size") ||
    tags.has("waystone-drop") ||
    tags.has("extra-content") ||
    tags.has("effectiveness")
  );
}

/** PoE2 Alchemy on a magic waystone throws away the blues and rolls a new 4-mod rare. */
export function shouldRerollWithAlchemy(inspection: WaystoneInspection): boolean {
  if (!inspection.isWaystone || inspection.corrupted) return false;
  if (inspection.tier !== JUICE_TARGET_TIER) return false;
  if (!/^magic$/i.test(inspection.rarity)) return false;
  if (!inspection.identified) return false;
  return !isKeepableMagicWaystone(inspection);
}

/** Hold Shift the whole time an orb is on the cursor, including Vaal. */
export function juiceUsesShiftApply(plan: JuicePlan): boolean {
  return plan.orb != null;
}

/** Alchemy on a white T15 yields a 4-mod rare; the rest are Exalts. */
export const ALCHEMY_RESULT_AFFIXES = 4;

/** One pass: slam every uncorrupted rare three times instead of counting mods. */
export const EXALT_SLAMS_PER_MAP = 3;

export const JUICE_BATCH_PHASES = ["alchemy", "regal", "exalt", "vaal"] as const;
export type JuiceBatchPhase = (typeof JUICE_BATCH_PHASES)[number];

export interface JuiceBatchTarget {
  row: number;
  col: number;
  slams: number;
  action: JuiceAction;
}

export function juiceOrbForPhase(phase: JuiceBatchPhase): OrbId {
  if (phase === "alchemy") return "alchemy";
  if (phase === "regal") return "regal";
  if (phase === "exalt") return "exalted";
  return "vaal";
}

/** Current-scan targets for one orb phase. Never includes corrupted or off-tier stones. */
export function juiceBatchTargets(
  reads: Array<{ row: number; col: number; text: string }>,
  phase: JuiceBatchPhase,
): JuiceBatchTarget[] {
  const want: JuiceAction = phase;
  const targets: JuiceBatchTarget[] = [];
  for (const read of reads) {
    const plan = planWaystoneJuice(read.text);
    if (!plan.autoEligible || plan.action !== want) continue;
    const slams = phase === "exalt" ? EXALT_SLAMS_PER_MAP : 1;
    if (slams <= 0) continue;
    targets.push({ row: read.row, col: read.col, slams, action: plan.action });
  }
  return targets;
}

/**
 * Spend at most `available` orbs. Extra slams are left on the target so the
 * next stack can finish them. Zero orbs ⇒ no clicks (never pick up a map).
 */
export function allocateOrbClicks(
  available: number,
  targets: readonly JuiceBatchTarget[],
): { clicks: JuiceBatchTarget[]; used: number; remaining: number } {
  const clicks: JuiceBatchTarget[] = [];
  let left = Math.max(0, Math.floor(available));
  for (const target of targets) {
    if (left <= 0) break;
    const slams = Math.min(Math.max(0, target.slams), left);
    if (slams <= 0) continue;
    clicks.push({ ...target, slams });
    left -= slams;
  }
  return { clicks, used: Math.max(0, available) - left, remaining: left };
}

/** One sweep: Alchemy/Regal now, then 3 Exalts and a Vaal on every uncorrupted T15. */
export function planJuiceFromScan(
  reads: Array<{ row: number; col: number; text: string }>,
): Record<JuiceBatchPhase, JuiceBatchTarget[]> {
  const planned: Record<JuiceBatchPhase, JuiceBatchTarget[]> = {
    alchemy: [],
    regal: [],
    exalt: [],
    vaal: [],
  };
  for (const read of reads) {
    const plan = planWaystoneJuice(read.text);
    if (plan.inspection.corrupted || plan.inspection.tier !== JUICE_TARGET_TIER) continue;
    const cell = { row: read.row, col: read.col };
    if (plan.action === "alchemy") {
      planned.alchemy.push({ ...cell, slams: 1, action: "alchemy" });
      planned.exalt.push({ ...cell, slams: EXALT_SLAMS_PER_MAP, action: "exalt" });
      planned.vaal.push({ ...cell, slams: 1, action: "vaal" });
      continue;
    }
    if (plan.action === "regal") {
      planned.regal.push({ ...cell, slams: 1, action: "regal" });
      planned.exalt.push({ ...cell, slams: EXALT_SLAMS_PER_MAP, action: "exalt" });
      planned.vaal.push({ ...cell, slams: 1, action: "vaal" });
      continue;
    }
    if (plan.action === "exalt") {
      planned.exalt.push({ ...cell, slams: EXALT_SLAMS_PER_MAP, action: "exalt" });
      planned.vaal.push({ ...cell, slams: 1, action: "vaal" });
      continue;
    }
    if (plan.action === "vaal") {
      planned.vaal.push({ ...cell, slams: 1, action: "vaal" });
    }
  }
  return planned;
}

export interface JuiceOrbPickup {
  x: number;
  y: number;
  count: number;
}

/** Spend bag stacks in order while Shift stays down. Put back only the last leftover. */
/** Current pile size from `Stack Size: 5/20`. Missing line → 1 so we never overspend. */
export function currencyStackCount(text: string): number {
  const sized = text.match(/stack size:\s*(\d+)\s*\/\s*(\d+)/i);
  if (sized) return Math.max(1, Number(sized[1]));
  const lone = text.match(/stack size:\s*(\d+)/i);
  if (lone) return Math.max(1, Number(lone[1]));
  return 1;
}

export type CursorHold = "orb" | "waystone" | "empty";

/** Classify a Ctrl+C from an empty bag cell while something may be on the cursor. */
export function classifyCursorText(text: string, expectName?: string): CursorHold {
  const trimmed = text.trim();
  if (!trimmed || !looksLikePoeItemText(trimmed)) return "empty";
  if (/item class:\s*waystones/i.test(trimmed)) return "waystone";
  const isCurrency = /item class:\s*(?:stackable\s+)?currency/i.test(trimmed);
  if (!isCurrency) return "empty";
  if (expectName && !trimmed.toLowerCase().includes(expectName.toLowerCase())) return "empty";
  return "orb";
}

export function takePickups(
  stacks: Array<{ count: number; x: number; y: number }>,
  need: number,
): { pickups: JuiceOrbPickup[]; putBack: boolean; used: number } {
  const pickups: JuiceOrbPickup[] = [];
  let left = Math.max(0, Math.floor(need));
  let last: { count: number } | undefined;
  for (const stack of stacks) {
    if (left <= 0) break;
    if (stack.count <= 0) continue;
    const n = Math.min(stack.count, left);
    pickups.push({ x: stack.x, y: stack.y, count: n });
    stack.count -= n;
    left -= n;
    last = stack;
  }
  return {
    pickups,
    putBack: Boolean(last && last.count > 0),
    used: Math.max(0, need) - left,
  };
}

export function remainingBatchTargets(
  targets: readonly JuiceBatchTarget[],
  applied: readonly JuiceBatchTarget[],
): JuiceBatchTarget[] {
  const spent = new Map<string, number>();
  for (const click of applied) {
    const key = `${click.row},${click.col}`;
    spent.set(key, (spent.get(key) ?? 0) + click.slams);
  }
  const leftover: JuiceBatchTarget[] = [];
  for (const target of targets) {
    const used = spent.get(`${target.row},${target.col}`) ?? 0;
    const slams = target.slams - used;
    if (slams > 0) leftover.push({ ...target, slams });
  }
  return leftover;
}

export function isWaystoneClass(itemClass: string): boolean {
  return /^waystones?$/i.test(itemClass.trim());
}

export function waystoneTier(parsed: ParsedItem): number | undefined {
  const sources = [
    parsed.name,
    parsed.baseType,
    ...parsed.properties.map((property) => `${property.name}: ${property.value}`),
    ...parsed.mods.map((mod) => mod.text),
  ];
  for (const text of sources) {
    const named = text.match(/waystone\s*\(\s*tier\s*(\d+)\s*\)/i);
    if (named) return Number(named[1]);
    const colon = text.match(/waystone\s*tier:\s*(\d+)/i);
    if (colon) return Number(colon[1]);
  }
  if (/waystone/i.test(`${parsed.itemClass} ${parsed.name} ${parsed.baseType}`)) {
    for (const text of sources) {
      const paren = text.match(/\(\s*tier\s*(\d+)\s*\)/i);
      if (paren) return Number(paren[1]);
    }
  }
  return undefined;
}

function rarityCap(rarity: string): number {
  if (/^rare$/i.test(rarity)) return JUICE_RARE_AFFIX_CAP;
  if (/^magic$/i.test(rarity)) return 2;
  return 0;
}

function isMetadataAffix(text: string): boolean {
  return METADATA_AFFIX.test(text.trim());
}

function matchFamily(text: string): AffixFamily | undefined {
  return DISTINCTIVE_FAMILIES.find((family) => family.pattern.test(text));
}

export function countExplicitWaystoneAffixes(parsed: ParsedItem): number {
  const cap = rarityCap(parsed.rarity);
  if (cap === 0) return 0;
  const mods = parsed.mods.filter((mod) => !isMetadataAffix(mod.text));
  const annotated = new Set<number>();
  for (const mod of mods) {
    if (mod.affixGroup != null) annotated.add(mod.affixGroup);
  }
  if (annotated.size > 0) return Math.min(cap, annotated.size);

  const families = new Set<string>();
  const leftover: ItemMod[] = [];
  for (const mod of mods) {
    const family = matchFamily(mod.text);
    if (family) families.add(family.id);
    else leftover.push(mod);
  }
  if (families.size > 0) {
    const unknown = leftover.filter((mod) => !COMPANION_AFFIX.test(mod.text)).length;
    return Math.min(cap, families.size + unknown);
  }
  const colonRewards = mods.filter((mod) => COLON_REWARD_AFFIX.test(mod.text)).length;
  if (colonRewards > 0) return Math.min(cap, colonRewards);
  return Math.min(cap, leftover.filter((mod) => !COMPANION_AFFIX.test(mod.text)).length);
}

function collectTags(texts: string[]): {
  rewardTags: WaystoneRewardTag[];
  dangerTags: WaystoneDangerTag[];
} {
  const reward = new Set<WaystoneRewardTag>();
  const danger = new Set<WaystoneDangerTag>();
  for (const text of texts) {
    for (const entry of REWARD_PATTERNS) {
      if (entry.pattern.test(text)) reward.add(entry.tag);
    }
    for (const entry of DANGER_PATTERNS) {
      if (entry.pattern.test(text)) danger.add(entry.tag);
    }
  }
  return { rewardTags: [...reward], dangerTags: [...danger] };
}

function scoreWaystone(
  rewardTags: WaystoneRewardTag[],
  _dangerTags: WaystoneDangerTag[],
  affixCount: number,
): number {
  const tags = new Set(rewardTags);
  let score = 18;
  if (tags.has("quantity")) score += 28;
  if (tags.has("rarity")) score += 18;
  if (tags.has("pack-size")) score += 16;
  if (tags.has("effectiveness")) score += 12;
  if (tags.has("waystone-drop")) score += 10;
  if (tags.has("rare-monsters")) score += 8;
  if (tags.has("extra-content")) score += 10;
  if (affixCount >= JUICE_RARE_AFFIX_CAP) score += 6;
  return Math.max(0, Math.min(100, score));
}

export function inspectWaystone(parsed: ParsedItem): WaystoneInspection {
  const isWaystone = isWaystoneClass(parsed.itemClass);
  const tier = isWaystone ? waystoneTier(parsed) : undefined;
  const explicitAffixCount = isWaystone ? countExplicitWaystoneAffixes(parsed) : 0;
  const maxAffixes = rarityCap(parsed.rarity);
  const texts = [
    ...parsed.mods.map((mod) => mod.text),
    ...parsed.properties.map((property) => property.text),
  ];
  const { rewardTags, dangerTags } = isWaystone
    ? collectTags(texts)
    : { rewardTags: [] as WaystoneRewardTag[], dangerTags: [] as WaystoneDangerTag[] };
  const score = isWaystone ? scoreWaystone(rewardTags, dangerTags, explicitAffixCount) : 0;
  const reasons: string[] = [];
  if (!isWaystone) reasons.push(`item class is ${parsed.itemClass}, not Waystones`);
  else {
    reasons.push(
      tier != null ? `tier ${tier}` : "tier unknown",
      `${parsed.rarity.toLowerCase()} · ${explicitAffixCount}/${maxAffixes || 0} explicit affixes`,
    );
    const corrupted = Boolean(parsed.corrupted) || itemTextLooksCorrupted(parsed.rawText ?? "");
    if (corrupted) reasons.push("already corrupted");
    if (rewardTags.length) reasons.push(`reward: ${rewardTags.join(", ")}`);
    if (dangerTags.length) reasons.push(`danger: ${dangerTags.join(", ")}`);
  }
  return {
    isWaystone,
    name: parsed.name || parsed.baseType,
    rarity: parsed.rarity,
    identified: parsed.identified,
    corrupted: Boolean(parsed.corrupted) || itemTextLooksCorrupted(parsed.rawText ?? ""),
    tier,
    explicitAffixCount,
    maxAffixes,
    rewardTags,
    dangerTags,
    score,
    reasons,
  };
}

function actionFor(inspection: WaystoneInspection, exaltDidNothing: boolean): {
  action: JuiceAction;
  orb?: OrbId;
  reasons: string[];
} {
  if (!inspection.isWaystone) {
    return { action: "skip", reasons: ["not a waystone"] };
  }
  if (inspection.tier !== JUICE_TARGET_TIER) {
    return {
      action: "skip",
      reasons: [
        inspection.tier != null
          ? `tier ${inspection.tier} is not T${JUICE_TARGET_TIER}`
          : "could not read waystone tier",
      ],
    };
  }
  if (inspection.corrupted) {
    return { action: "done", reasons: ["already corrupted — recipe complete"] };
  }
  if (/^unique$/i.test(inspection.rarity)) {
    return { action: "skip", reasons: ["unique waystones are not juiced"] };
  }
  if (/^normal$/i.test(inspection.rarity)) {
    return { action: "alchemy", orb: "alchemy", reasons: ["white T15 — Orb of Alchemy (4 new mods)"] };
  }
  if (/^magic$/i.test(inspection.rarity)) {
    if (shouldRerollWithAlchemy(inspection)) {
      return {
        action: "alchemy",
        orb: "alchemy",
        reasons: [
          "magic T15 loot mods are too weak — Alchemy rerolls it into a new 4-mod rare",
          inspection.rewardTags.length
            ? `current reward: ${inspection.rewardTags.join(", ")}`
            : "current reward: none",
        ],
      };
    }
    return {
      action: "regal",
      orb: "regal",
      reasons: ["magic T15 has a keeper loot hook — Regal Orb (do not Alchemy; that would reroll it)"],
    };
  }
  if (/^rare$/i.test(inspection.rarity)) {
    if (exaltDidNothing || inspection.explicitAffixCount >= JUICE_RARE_AFFIX_CAP) {
      return {
        action: "vaal",
        orb: "vaal",
        reasons: [
          exaltDidNothing
            ? "exalt did not add an affix — treating as full and corrupting"
            : `rare T15 at ${inspection.explicitAffixCount} affixes — Vaal Orb (every 6-mod is corrupted)`,
          "Vaal can flip the tier to 14 or 16 and put the stone on the cursor — park it in the bag, ctrl-click it back, then click XV",
        ],
      };
    }
    return {
      action: "exalt",
      orb: "exalted",
      reasons: [
        `rare T15 — ${EXALT_SLAMS_PER_MAP} Exalted Orb slams (no second scan)`,
      ],
    };
  }
  return { action: "skip", reasons: [`unsupported rarity ${inspection.rarity}`] };
}

export function planWaystoneJuice(text: string, options: JuicePlanOptions = {}): JuicePlan {
  if (!looksLikePoeItemText(text)) {
    const empty = inspectWaystone({
      itemClass: "Unknown",
      rarity: "Normal",
      name: "Unknown Item",
      baseType: "Unknown Item",
      requirements: {},
      mods: [],
      identified: true,
      fingerprint: "",
      rawText: text,
      rawSections: [],
      sections: [],
      properties: [],
      defenses: [],
      modifierBlocks: [],
      corrupted: false,
    });
    return {
      action: "skip",
      autoEligible: false,
      reasons: ["clipboard text is not a Path of Exile item"],
      inspection: empty,
      score: 0,
    };
  }
  const parsed = options.parsed ?? parseItemText(text);
  const inspection = inspectWaystone(parsed);
  const next = actionFor(inspection, options.exaltDidNothing === true);
  const autoEligible = next.orb != null && JUICE_ORBS.has(next.orb);
  return {
    action: next.action,
    orb: next.orb,
    autoEligible,
    reasons: [...next.reasons, ...inspection.reasons],
    inspection,
    score: inspection.score,
  };
}

export function describeJuicePlan(label: string, plan: JuicePlan): string {
  const orb = plan.orb ? ` (${ORB_NAMES[plan.orb]})` : "";
  const head =
    `${label}: ${plan.action.toUpperCase()}${orb}` +
    ` · score ${plan.score}` +
    (plan.autoEligible ? " · AUTO" : " · hold");
  return [head, ...plan.reasons.map((reason) => `    ${reason}`)].join("\n");
}

/** Title-band OCR — same /inventor/i rule as DrainKit / gearSorter. */
export function inventoryOpenFromOcr(text: string): boolean {
  return /inventor/i.test(text);
}

/** Stash title band. Ignore Guild Stash. */
export function stashOpenFromOcr(text: string): boolean {
  return /stash/i.test(text) && !/guild\s*stash/i.test(text);
}

/**
 * Maps affinity / specialty tab. The T1–T16 strip sits inside the calibrated
 * stash box, so a 24×24 occupancy read is almost always a hallucination.
 */
export function mapsSpecialtyFromOcr(text: string): boolean {
  if (/map/i.test(text) || /waystone/i.test(text)) return true;
  const roman = text.match(/\b(xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi) ?? [];
  if (roman.length >= 3) return true;
  return /currency/i.test(text) && /(gem|abyss|breach)/i.test(text) && roman.length >= 2;
}

/** Skip the T1–T16 selector rows on the maps specialty layout. */
export const MAPS_SPECIALTY_SKIP_ROWS = 3;

/** Prefer the 12×12 grid on maps specialty / failed chrome — never the quad hint. */
export function preferNormalStashForWaystones(input: {
  mapsSpecialty?: boolean;
  chromeFailed?: boolean;
}): boolean {
  return input.mapsSpecialty === true || input.chromeFailed === true;
}

/**
 * A 24×24 read of 1×1 waystones copies the same stone from adjacent cells.
 * Collapse neighbors that returned identical clipboard text.
 */
export function collapseAdjacentDuplicateReads<T extends { row: number; col: number; text: string }>(
  reads: T[],
): T[] {
  const kept: T[] = [];
  for (const read of reads) {
    const duplicate = kept.some(
      (other) =>
        Math.abs(other.row - read.row) <= 1 &&
        Math.abs(other.col - read.col) <= 1 &&
        other.text === read.text,
    );
    if (!duplicate) kept.push(read);
  }
  return kept;
}
