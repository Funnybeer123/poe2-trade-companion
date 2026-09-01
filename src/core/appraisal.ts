/**
 * Appraisal engine: how valuable does an item look, and how sure are we?
 *
 * Two independent axes, deliberately kept apart:
 *   - valueScore (0-100): how good the item looks, from the strongest single
 *     piece of evidence (a price-table hit, an explicit rule, or weighted
 *     mod-tier scoring against the mod knowledge base);
 *   - confidence (0-100): how trustworthy that evidence is. A price-table
 *     name match is near-certain; "three matched mod families" is a strong
 *     hint; an unidentified rare is a guess by definition.
 *
 * The tier verdict stays authoritative for WHERE an item goes; the appraisal
 * explains and gates it. Heuristics may only ever promote an item UP
 * (unknown → sell/keep). Nothing heuristic can ever mark an item dump — that
 * verdict remains reserved for explicit rules and price entries.
 */

import {
  matchModFamily,
  modPoints,
  type ModMatch,
} from "./modKnowledge.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import {
  evaluateValueTier,
  type EvaluateTierOptions,
  type TierVerdict,
  type TriageTier,
} from "./valueTiers.js";
import type { ParsedItem } from "./types.js";

export type ConfidenceBand = "very-high" | "high" | "medium" | "low";

export interface ModAppraisal {
  text: string;
  familyId?: string;
  familyLabel?: string;
  judgedValue?: number;
  /** 1 = top tier, 3 = notable, 0 = matched family but low roll. */
  tier?: 0 | 1 | 2 | 3;
  points: number;
}

export interface EstimatedValue {
  amount: number;
  currency: string;
  /** What produced the number. Stack-aware for currency piles. */
  basis: "price-table" | "price-table-stack";
  unitValue: number;
  stackCount?: number;
}

export interface ItemAppraisal {
  /** 0-100: how valuable the item looks. */
  valueScore: number;
  /** 0-100: how trustworthy the evidence is. */
  confidence: number;
  band: ConfidenceBand;
  /** The single strongest evidence source behind the score. */
  evidence: "price-table" | "rule" | "mods" | "unidentified" | "unparseable" | "none";
  reasons: string[];
  mods: ModAppraisal[];
  estimatedValue?: EstimatedValue;
  /** Set when the item looks like worthwhile crafting stock. */
  craftHint?: string;
}

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 85) return "very-high";
  if (confidence >= 65) return "high";
  if (confidence >= 40) return "medium";
  return "low";
}

/** Points that map to valueScore 100: roughly three top-tier heavy mods. */
const FULL_SCORE_POINTS = 70;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function appraiseMods(parsed: ParsedItem): {
  mods: ModAppraisal[];
  points: number;
  t1: number;
  t2: number;
  t3: number;
} {
  const mods: ModAppraisal[] = [];
  let points = 0;
  let t1 = 0;
  let t2 = 0;
  let t3 = 0;
  for (const mod of parsed.mods) {
    const match: ModMatch | undefined = matchModFamily(mod.text);
    if (!match) {
      mods.push({ text: mod.text, points: 0 });
      continue;
    }
    const earned = modPoints(match);
    points += earned;
    if (match.tier === 1) t1 += 1;
    else if (match.tier === 2) t2 += 1;
    else if (match.tier === 3) t3 += 1;
    mods.push({
      text: mod.text,
      familyId: match.family.id,
      familyLabel: match.family.label,
      judgedValue: match.judgedValue,
      tier: match.tier,
      points: Math.round(earned * 10) / 10,
    });
  }
  return { mods, points, t1, t2, t3 };
}

function stackCount(parsed: ParsedItem): number | undefined {
  const property = parsed.properties.find((entry) => /^stack size$/i.test(entry.name));
  const count = property?.rolls?.[0]?.value;
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : undefined;
}

export interface AppraiseOptions {
  priceTable?: PriceTable;
  /** Pre-parsed item to skip re-parsing. */
  parsed?: ParsedItem;
  /** The already-computed tier verdict, when the caller ran the rules. */
  verdict?: TierVerdict;
}

/**
 * Score one item's copied text. Pure and deterministic; safe to run on every
 * item the sorter touches (the text is already in hand — no game input).
 */
export function appraiseItem(itemText: string, options: AppraiseOptions = {}): ItemAppraisal {
  if (!looksLikePoeItemText(itemText)) {
    return {
      valueScore: 0,
      confidence: 0,
      band: "low",
      evidence: "unparseable",
      reasons: ["The text is not recognizable item text."],
      mods: [],
    };
  }
  const parsed = options.parsed ?? parseItemText(itemText);
  const reasons: string[] = [];

  // Price table: the strongest possible evidence, stack-aware for currency.
  let estimatedValue: EstimatedValue | undefined;
  let priceConfidence = 0;
  let priceScore = 0;
  if (options.priceTable) {
    const hit = lookupPrice(options.priceTable, {
      name: parsed.name,
      baseType: parsed.baseType,
      itemClass: parsed.itemClass,
      itemLevel: parsed.itemLevel,
      rarity: parsed.rarity,
    });
    if (hit) {
      const count = /currency/i.test(parsed.itemClass) ? stackCount(parsed) : undefined;
      const amount = Math.round(hit.value * (count ?? 1) * 100) / 100;
      estimatedValue = {
        amount,
        currency: hit.currency,
        basis: count !== undefined ? "price-table-stack" : "price-table",
        unitValue: hit.value,
        ...(count !== undefined ? { stackCount: count } : {}),
      };
      const nameMatch = hit.entry.match.name !== undefined;
      const baseMatch = hit.entry.match.baseType !== undefined;
      priceConfidence = nameMatch ? 95 : baseMatch ? 78 : 55;
      // Score scales with worth: 1 unit ≈ 45, 5 ≈ 75, 20+ ≈ 100.
      priceScore = clamp(Math.round(34 + 21 * Math.log2(Math.max(amount, 0.25) + 1)), 5, 100);
      reasons.push(
        `Price table: ${hit.entry.match.name ?? hit.entry.match.baseType ?? hit.entry.id} ` +
          `≈ ${amount} ${hit.currency}${count !== undefined ? ` (stack of ${count} × ${hit.value})` : ""}.`,
      );
    }
  }

  if (!parsed.identified) {
    return {
      valueScore: Math.max(priceScore, 35),
      confidence: Math.max(priceConfidence, 18),
      band: confidenceBand(Math.max(priceConfidence, 18)),
      evidence: estimatedValue ? "price-table" : "unidentified",
      reasons: [
        ...reasons,
        "Unidentified: real value is unknown until identified — review it, never vendor it.",
      ],
      mods: [],
      ...(estimatedValue ? { estimatedValue } : {}),
    };
  }

  // Explicit rules the caller already evaluated.
  const ruleCount = options.verdict?.source === "rule" ? options.verdict.matchedRules.length : 0;
  const ruleConfidence = ruleCount > 0 ? clamp(72 + 4 * (ruleCount - 1), 72, 85) : 0;
  const ruleScore =
    options.verdict?.source === "rule"
      ? options.verdict.tier === "keep"
        ? 80
        : options.verdict.tier === "sell"
          ? 55
          : 20
      : 0;
  if (ruleCount > 0) {
    reasons.push(
      `Matched ${ruleCount} explicit ${options.verdict!.tier} rule${ruleCount > 1 ? "s" : ""}: ` +
        `${options.verdict!.matchedRules.join(", ")}.`,
    );
  }

  // Mod-tier scoring against the knowledge base.
  const scored = appraiseMods(parsed);
  const strongMods = scored.t1 + scored.t2;
  let modScore = clamp(Math.round((scored.points / FULL_SCORE_POINTS) * 100), 0, 100);
  if (strongMods >= 3) {
    modScore = clamp(modScore + 8, 0, 100);
    reasons.push(`Well-rounded: ${strongMods} high-tier mod families on one item.`);
  }
  const modConfidence =
    scored.points > 0
      ? clamp(25 + 12 * scored.t1 + 6 * scored.t2 + 2 * scored.t3, 25, 80)
      : parsed.mods.length > 0
        ? 30 // mods parsed cleanly, none notable — a confident "meh"
        : 20;
  if (scored.t1 > 0) reasons.push(`${scored.t1} top-tier roll${scored.t1 > 1 ? "s" : ""}.`);

  // Craft stock: a rare with few affixes but at least one strong roll has
  // open affixes to gamble on.
  let craftHint: string | undefined;
  if (/^rare$/i.test(parsed.rarity) && parsed.mods.length <= 4 && strongMods >= 1) {
    craftHint = `Craft base: only ${parsed.mods.length} affixes with ${strongMods} strong roll${strongMods > 1 ? "s" : ""} — open affixes remain.`;
    reasons.push(craftHint);
  }

  const valueScore = Math.max(priceScore, ruleScore, modScore);
  const candidates: Array<{ evidence: ItemAppraisal["evidence"]; confidence: number }> = [
    { evidence: "price-table", confidence: priceConfidence },
    { evidence: "rule", confidence: ruleConfidence },
    { evidence: "mods", confidence: modConfidence },
  ];
  const strongest = candidates.sort((a, b) => b.confidence - a.confidence)[0]!;
  // Two independent sources agreeing lifts certainty a notch.
  const agreeing = candidates.filter((entry) => entry.confidence >= 50).length;
  const confidence = clamp(strongest.confidence + (agreeing >= 2 ? 5 : 0), 0, 98);

  if (reasons.length === 0) {
    reasons.push("No price entry, rule, or notable mod family matched.");
  }

  return {
    valueScore,
    confidence,
    band: confidenceBand(confidence),
    evidence: valueScore === 0 ? "none" : strongest.evidence,
    reasons,
    mods: scored.mods,
    ...(estimatedValue ? { estimatedValue } : {}),
    ...(craftHint ? { craftHint } : {}),
  };
}

export interface PromotionPolicy {
  /** Appraisal score at or above which an unknown item becomes a keep. */
  keepAtScore: number;
  /** Score at or above which an unknown item becomes a sell. */
  sellAtScore: number;
  /** Minimum confidence for any heuristic promotion. */
  minConfidence: number;
}

export const DEFAULT_PROMOTION: PromotionPolicy = {
  keepAtScore: 70,
  sellAtScore: 45,
  minConfidence: 50,
};

export interface EvaluateWithAppraisalOptions extends EvaluateTierOptions {
  /** Enables heuristic promotion of unknown items. Never demotes, never dumps. */
  promote?: PromotionPolicy | false;
}

/**
 * The full decision: explicit tier verdict first, appraisal attached, and —
 * when promotion is enabled — a high-scoring, high-confidence unknown item
 * promoted to sell/keep so it detours to the Review tab instead of filing
 * silently into a class tab.
 */
export function evaluateWithAppraisal(
  itemText: string,
  options: EvaluateWithAppraisalOptions,
): TierVerdict {
  const base = evaluateValueTier(itemText, options);
  const appraisal = appraiseItem(itemText, {
    ...(options.priceTable ? { priceTable: options.priceTable } : {}),
    verdict: base,
  });
  const verdict: TierVerdict = { ...base, appraisal };
  const promote = options.promote === false ? undefined : (options.promote ?? DEFAULT_PROMOTION);
  if (
    promote &&
    verdict.tier === "unknown" &&
    appraisal.confidence >= promote.minConfidence
  ) {
    const promoted: TriageTier | undefined =
      appraisal.valueScore >= promote.keepAtScore
        ? "keep"
        : appraisal.valueScore >= promote.sellAtScore
          ? "sell"
          : undefined;
    if (promoted) {
      return {
        ...verdict,
        tier: promoted,
        source: "heuristic",
        reasons: [
          `Appraised at ${appraisal.valueScore}/100 with ${appraisal.confidence}% confidence — promoted to ${promoted}.`,
          ...appraisal.reasons,
        ],
      };
    }
  }
  return verdict;
}
