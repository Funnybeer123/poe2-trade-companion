/**
 * Item decision: one of four distinguishable outcomes for an identified item,
 * with the evidence that produced it and an auditable discard check.
 *
 *   keep              — retain: strong evidence it is wanted (a saved price,
 *                       your keep rule, a chase demand match, a craft case);
 *   list              — retain and list: a sell rule, a real price-table
 *                       price, or a strong/useful demand match;
 *   review            — retain for a human or market decision: unidentified,
 *                       unreadable, stale/conflicting price evidence, an
 *                       uncovered item class, or lines the knowledge base
 *                       cannot judge;
 *   discard-eligible  — a PROPOSAL, never an action: either your explicit
 *                       dump rule, or every check in `DiscardAudit` passed.
 *
 * Precedence (tested in tests/item-decision.test.ts):
 *   safety > saved price > explicit rule > real price-table price >
 *   demand > appraisal promotion > craft case > discard audit > review.
 *
 * The verdict's `tier` stays the routing authority for the sorter and the
 * bag runner; the decision explains it and carries the outcome the UI shows.
 * Demand and popularity are never converted into a price here.
 *
 * Pure: no fs, no network, no clock reads (the caller passes `now`).
 */

import {
  appraiseItem,
  evaluateWithAppraisal,
  type EvaluateWithAppraisalOptions,
  type ItemAppraisal,
} from "./appraisal.js";
import {
  assessDemand,
  demandConfidence,
  describeMatch,
  type DemandAssessment,
  type DemandKnowledge,
  type DemandMatch,
  type DemandStrength,
} from "./buildDemand.js";
import { planCraft, type CraftAction } from "./crafting.js";
import { parseAdvancedItemText } from "./itemAnnotations.js";
import { CRAFT_BASE_ILVL } from "./lookupScreen.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { PriceTable } from "./priceTable.js";
import type { ParsedItem } from "./types.js";
import type { TierVerdict, TriageTier } from "./valueTiers.js";

export const ITEM_DECISION_VERSION = 1 as const;

export type DecisionOutcome = "keep" | "list" | "review" | "discard-eligible";

export type DecisionEvidenceKind =
  | "safety"
  | "saved-price"
  | "user-rule"
  | "price-table"
  | "price-floor"
  | "demand"
  | "appraisal"
  | "craft"
  | "coverage"
  | "weapon"
  | "base";

export interface DecisionEvidence {
  kind: DecisionEvidenceKind;
  label: string;
  detail?: string;
  /** ISO date of the underlying source, when there is one. */
  date?: string;
  url?: string;
}

export interface DecisionDemand {
  patternId: string;
  label: string;
  strength: DemandStrength;
  builds: string[];
  sources: Array<{ label: string; kind: string; date: string; url: string; strength: string }>;
  met: string[];
  verified: boolean;
  /** Routing confidence derived from the evidence (0-100); not a sale probability. */
  confidence: number;
}

export interface DecisionCoverage {
  itemClass: string;
  covered: boolean;
  unsupported: string[];
  unsupportedImplicits: string[];
  filler: string[];
  knowledgeVersion: string;
  league: string;
  reviewBy: string;
  expired: boolean;
}

export interface DecisionCraft {
  action: CraftAction;
  expectedProfit: number;
  confidence: number;
  reason: string;
}

export interface DiscardCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DiscardAudit {
  /** True only when every check passed (or your explicit dump rule matched). */
  eligible: boolean;
  basis: "user-rule" | "audit";
  checks: DiscardCheck[];
}

export interface ReviewNeed {
  /** 1 = most useful to look at first. */
  priority: 1 | 2 | 3;
  reason: string;
}

export interface ItemDecision {
  version: typeof ITEM_DECISION_VERSION;
  outcome: DecisionOutcome;
  /** One sentence for the UI and the runner log. */
  headline: string;
  reasons: string[];
  evidence: DecisionEvidence[];
  demand?: DecisionDemand;
  /** The closest chase/strong pattern the item fell short of, when any. */
  nearMiss?: { patternId: string; label: string; met: string[]; missing: string[] };
  coverage: DecisionCoverage;
  craft?: DecisionCraft;
  discard?: DiscardAudit;
  review?: ReviewNeed;
  /** What automation does with this outcome under the current policy. */
  policy: string;
}

export const DEMAND_NOT_PRICE = "Build demand is not a price: no listing or sale for this item was observed.";

/** An additive orb has to promise at least this much (exalted) to make an item crafting stock. */
export const MIN_CRAFT_PROFIT_EXALTED = 0.3;
/** …and the planner has to be at least this sure of the step. */
export const MIN_CRAFT_CONFIDENCE = 60;

const PROPOSAL_POLICY =
  "Proposal only: the bag runner and the sorter retain unknown-tier items until discarding audited proposals is explicitly enabled (--drop-unknown).";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function outcomeForTier(tier: TriageTier): DecisionOutcome {
  return tier === "keep" ? "keep" : tier === "sell" ? "list" : tier === "dump" ? "discard-eligible" : "review";
}

function decisionDemand(match: DemandMatch, assessment: DemandAssessment): DecisionDemand {
  return {
    patternId: match.pattern.id,
    label: match.pattern.label,
    strength: match.pattern.strength,
    builds: match.builds.map((build) => build.name),
    sources: match.sources.map((source) => ({
      label: source.site,
      kind: source.kind,
      date: source.date,
      url: source.url,
      strength: source.strength,
    })),
    met: match.met,
    verified: match.pattern.verified,
    confidence: demandConfidence(match, assessment),
  };
}

function coverageOf(assessment: DemandAssessment): DecisionCoverage {
  return {
    itemClass: assessment.itemClass,
    covered: assessment.covered,
    unsupported: assessment.unsupported,
    unsupportedImplicits: assessment.unsupportedImplicits,
    filler: assessment.lines
      .filter((line) => line.affix && (line.role === "filler" || line.role === "situational" || line.role === "local"))
      .map((line) => line.text),
    knowledgeVersion: assessment.knowledgeVersion,
    league: assessment.league,
    reviewBy: assessment.reviewBy,
    expired: assessment.expired,
  };
}

function demandEvidence(match: DemandMatch): DecisionEvidence[] {
  const out: DecisionEvidence[] = [
    {
      kind: "demand",
      label: `${match.pattern.label} (${match.pattern.strength})`,
      detail: match.met.join("; "),
    },
  ];
  for (const source of match.sources.slice(0, 4)) {
    out.push({ kind: "demand", label: `${source.site} · ${source.kind}`, detail: source.note, date: source.date, url: source.url });
  }
  return out;
}

/**
 * Crafting potential the planner can defend: a positive-expected-value
 * additive orb on a covered class. Deliberately narrow — a partly filled
 * rare with nothing the slot wants is not a base, and every one-affix magic
 * item is not "augment stock".
 */
function craftCase(
  text: string,
  parsed: ParsedItem,
  assessment: DemandAssessment,
  priceTable: PriceTable | undefined,
): DecisionCraft | undefined {
  if (!parsed.identified || parsed.corrupted || !assessment.covered) return undefined;
  const rarity = parsed.rarity.trim().toLowerCase();
  if (rarity === "unique") return undefined;
  const level = parsed.itemLevel ?? 0;
  if (rarity === "normal" && level < CRAFT_BASE_ILVL) return undefined;
  if (rarity === "magic" && level < 75) return undefined;
  let plan: ReturnType<typeof planCraft>;
  try {
    plan = planCraft(text, { parsed, ...(priceTable ? { priceTable } : {}) });
  } catch {
    return undefined;
  }
  if (rarity === "normal") {
    // A white base at or above the craft-stock item level is kept for the
    // base itself (top affix tiers can roll), the same bar the shop screen
    // uses; the planner's transmute expectation is not the base's value.
    if (!plan.archetypeId) return undefined;
    return {
      action: plan.action,
      expectedProfit: round2(Math.max(0, plan.expectedProfit)),
      confidence: plan.confidence,
      reason: `Normal ${parsed.itemClass} at item level ${level} (≥ ${CRAFT_BASE_ILVL}): craft stock, top affix tiers can roll`,
    };
  }
  const additive: ReadonlySet<CraftAction> = new Set(["transmute", "augment", "regal", "exalt"]);
  if (!additive.has(plan.action)) return undefined;
  if (plan.expectedProfit < MIN_CRAFT_PROFIT_EXALTED || plan.confidence < MIN_CRAFT_CONFIDENCE) return undefined;
  if (plan.onArchetypeMods.length === 0) return undefined;
  // A one-affix magic item is only worth an augment when that one affix is
  // a top-tier line the slot wants; "augment is near-free" alone keeps
  // every blue ring forever.
  if (rarity === "magic" && plan.action === "augment" && assessment.topTierAffixes === 0) return undefined;
  const reason = plan.reasons.find((entry) => !/confidence:/i.test(entry)) ?? `${plan.action} is +EV`;
  return {
    action: plan.action,
    expectedProfit: round2(plan.expectedProfit),
    confidence: plan.confidence,
    reason,
  };
}

interface AuditInput {
  parsed: ParsedItem;
  verdict: TierVerdict;
  assessment: DemandAssessment;
  craft?: DecisionCraft;
}

/** Every check has to pass; the list is the audit trail the UI shows. */
export function auditDiscard(input: AuditInput): DiscardAudit {
  const { parsed, verdict, assessment } = input;
  const checks: DiscardCheck[] = [];
  const check = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const rarity = parsed.rarity.trim().toLowerCase();
  check("identified", parsed.identified, parsed.identified ? "item is identified" : "unidentified items are never discarded");
  check("class-covered", assessment.covered, assessment.covered
    ? `${parsed.itemClass} is covered by the demand knowledge (v${assessment.knowledgeVersion})`
    : `${parsed.itemClass} is not covered by the demand knowledge`);
  check("rarity", ["normal", "magic", "rare"].includes(rarity), ["normal", "magic", "rare"].includes(rarity)
    ? `${parsed.rarity} items may be audited`
    : `${parsed.rarity} items are never audited for discard`);
  check("no-protection", verdict.source !== "training" && verdict.tier !== "keep" && verdict.tier !== "sell",
    verdict.source === "training" ? "a saved price example protects this item"
      : verdict.tier === "keep" || verdict.tier === "sell" ? `the ${verdict.tier} verdict (${verdict.source}) protects this item`
        : "no saved price, keep rule or price entry protects it");
  check("no-price-floor", !verdict.priceFloor, verdict.priceFloor
    ? `price-table floor "${verdict.priceFloor.id}" (${verdict.priceFloor.value} ${verdict.priceFloor.currency}) applies`
    : "no price-table floor applies");
  check("lines-understood", assessment.unsupported.length === 0, assessment.unsupported.length === 0
    ? "every affix line is a known family or a recognised low-value line"
    : `cannot judge: ${assessment.unsupported.join("; ")}`);
  check("no-situational-lines", assessment.situational.length === 0, assessment.situational.length === 0
    ? "no build-specific (situational) line"
    : `build-specific line(s) outside the sampled builds: ${assessment.situational.join("; ")}`);
  check("no-demand", assessment.matches.length === 0, assessment.matches.length === 0
    ? "no curated demand pattern matched"
    : `demand matched: ${assessment.matches.map((match) => match.pattern.label).join(", ")}`);
  check("no-top-tier-affix", assessment.topTierAffixes === 0, assessment.topTierAffixes === 0
    ? "no tier-1 affix" : `${assessment.topTierAffixes} tier-1 affix(es) present`);
  check("few-strong-affixes", assessment.strongAffixes <= 1, assessment.strongAffixes <= 1
    ? `${assessment.strongAffixes} tier-1/2 affix(es)` : `${assessment.strongAffixes} tier-1/2 affixes — too much substance to discard blind`);
  check("no-craft-case", !input.craft, input.craft ? `crafting potential: ${input.craft.reason}` : "no defensible craft step");
  check("not-valuable-base", !assessment.valuableBase, assessment.valuableBase
    ? `valuable base (${assessment.valuableBase}) needs a lookup` : "base type is not on the valuable-base list");
  if (assessment.weapon) {
    const weapon = assessment.weapon;
    check("weapon-dps-weak", weapon.tier === "weak", weapon.tier === "weak"
      ? `total DPS ${weapon.totalDps} is below the usable bar (${weapon.usableAt})`
      : weapon.tier === "unknown" ? "weapon DPS could not be read or has no curated bar"
        : `total DPS ${weapon.totalDps} reaches the ${weapon.tier} bar`);
  }
  check("knowledge-current", !assessment.expired, assessment.expired
    ? `demand knowledge v${assessment.knowledgeVersion} is past its review date (${assessment.reviewBy})`
    : `demand knowledge v${assessment.knowledgeVersion} is within its review window (until ${assessment.reviewBy})`);
  return { eligible: checks.every((entry) => entry.ok), basis: "audit", checks };
}

function reviewNeed(input: {
  parsed: ParsedItem;
  verdict: TierVerdict;
  assessment: DemandAssessment;
  audit?: DiscardAudit;
}): ReviewNeed {
  const { parsed, verdict, assessment } = input;
  const rarity = parsed.rarity.trim().toLowerCase();
  if (!parsed.identified) return { priority: 1, reason: "identify it first; its value is unknown until then" };
  if (verdict.training?.status === "stale") return { priority: 1, reason: "saved price evidence is older than 30 days" };
  if (verdict.training?.status === "conflict") return { priority: 1, reason: "saved price examples conflict" };
  if (assessment.valuableBase) return { priority: 1, reason: `valuable base (${assessment.valuableBase}) — worth a market lookup` };
  if (rarity === "unique") return { priority: 1, reason: "unique with no real price entry — look it up before listing" };
  if (assessment.nearest) {
    return {
      priority: 1,
      reason: `close to ${assessment.nearest.pattern.label} (${assessment.nearest.pattern.strength}); missing ${assessment.nearest.missing.join(", ")}`,
    };
  }
  if (assessment.unsupported.length > 0 && (assessment.topTierAffixes > 0 || (parsed.itemLevel ?? 0) >= 80)) {
    return { priority: 1, reason: `cannot judge ${assessment.unsupported.length} line(s) on a high-level item: ${assessment.unsupported.join("; ")}` };
  }
  if (!assessment.covered) return { priority: 2, reason: `${parsed.itemClass} is outside the demand knowledge` };
  if (assessment.unsupported.length > 0) return { priority: 2, reason: `cannot judge: ${assessment.unsupported.join("; ")}` };
  if (assessment.weapon?.tier === "unknown") return { priority: 2, reason: "weapon DPS could not be read against a curated bar" };
  if (assessment.situational.length > 0) {
    return { priority: 3, reason: `build-specific line(s) with no sampled demand: ${assessment.situational.join("; ")}` };
  }
  const failed = input.audit?.checks.filter((entry) => !entry.ok).map((entry) => entry.detail) ?? [];
  return { priority: 3, reason: failed[0] ?? "low information; no rule, price, demand or craft evidence" };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface DecideItemInput {
  text: string;
  parsed: ParsedItem;
  /** The verdict from evaluateWithAppraisal (+ any demand promotion), without a decision yet. */
  verdict: TierVerdict;
  assessment: DemandAssessment;
  priceTable?: PriceTable;
}

export function decideItem(input: DecideItemInput): ItemDecision {
  const { text, parsed, verdict, assessment } = input;
  const coverage = coverageOf(assessment);
  const evidence: DecisionEvidence[] = [];
  const reasons: string[] = [];
  const best = assessment.best;
  const demand = best ? decisionDemand(best, assessment) : undefined;
  const nearMiss = assessment.nearest
    ? { patternId: assessment.nearest.pattern.id, label: assessment.nearest.pattern.label, met: assessment.nearest.met, missing: assessment.nearest.missing }
    : undefined;
  const finish = (
    outcome: DecisionOutcome,
    headline: string,
    extra: Partial<Pick<ItemDecision, "craft" | "discard" | "review" | "policy">> = {},
  ): ItemDecision => {
    if (best) evidence.push(...demandEvidence(best));
    if (assessment.unsupported.length > 0) {
      evidence.push({ kind: "coverage", label: "Lines the knowledge base cannot judge", detail: assessment.unsupported.join("; ") });
    }
    if (!assessment.covered) evidence.push({ kind: "coverage", label: `${parsed.itemClass} is not a covered item class` });
    if (assessment.weapon && assessment.weapon.tier !== "unknown") {
      evidence.push({
        kind: "weapon",
        label: `Printed total DPS ${assessment.weapon.totalDps} (${assessment.weapon.tier})`,
        detail: `usable ≥ ${assessment.weapon.usableAt}, strong ≥ ${assessment.weapon.strongAt}${assessment.weapon.verified ? "" : " — curated bars, not verified against sales"}`,
      });
    }
    if (assessment.valuableBase) evidence.push({ kind: "base", label: `Valuable base: ${assessment.valuableBase}` });
    if (verdict.priceFloor) {
      evidence.push({
        kind: "price-floor",
        label: `Price-table floor "${verdict.priceFloor.id}" = ${verdict.priceFloor.value} ${verdict.priceFloor.currency}`,
        detail: "A placeholder for unreviewed items, not an observed price.",
      });
    }
    if (best) reasons.push(DEMAND_NOT_PRICE);
    if (assessment.expired) reasons.push(`Demand knowledge v${assessment.knowledgeVersion} is past its review date (${assessment.reviewBy}).`);
    return {
      version: ITEM_DECISION_VERSION,
      outcome,
      headline,
      reasons: [headline, ...reasons],
      evidence,
      ...(demand ? { demand } : {}),
      ...(nearMiss ? { nearMiss } : {}),
      coverage,
      ...(extra.craft ? { craft: extra.craft } : {}),
      ...(extra.discard ? { discard: extra.discard } : {}),
      ...(extra.review ? { review: extra.review } : {}),
      policy: extra.policy ?? (outcome === "discard-eligible" ? PROPOSAL_POLICY : `Automation routes this item as ${verdict.tier}.`),
    };
  };

  // 1. Safety gates: unreadable / unidentified / damaged training file.
  if (verdict.source === "safety") {
    evidence.push({ kind: "safety", label: verdict.reasons[0] ?? "safety verdict" });
    return finish("review", verdict.reasons[0] ?? "Retained by a safety gate.", {
      review: reviewNeed({ parsed, verdict, assessment }),
      policy: "Retained; never discarded.",
    });
  }

  // 2. Saved price examples (your corrections) outrank everything else.
  if (verdict.source === "training") {
    const training = verdict.training;
    evidence.push({
      kind: "saved-price",
      label: training?.status === "matched" ? `Saved price example: ${verdict.price} ${verdict.currency} (${training.matchKind})` : `Saved price example needs review (${training?.status})`,
      detail: training?.reasons.join(" "),
    });
    if (training?.status === "matched") return finish("keep", `Keep — ${verdict.reasons[0] ?? "saved price evidence"}`);
    return finish("review", `Review — ${verdict.reasons[0] ?? "saved price evidence needs review"}`, {
      review: reviewNeed({ parsed, verdict, assessment }),
    });
  }

  // 3. Your explicit rules.
  if (verdict.source === "rule") {
    evidence.push({ kind: "user-rule", label: `Your ${verdict.tier} rule: ${verdict.matchedRules.join(", ")}` });
    if (verdict.tier === "dump") {
      // Your rule wins, but a conflict with what the evidence says is shown,
      // not hidden: a dump rule over a craft-grade base or a demand match.
      const craft = craftCase(text, parsed, assessment, input.priceTable);
      if (best) reasons.push(`Conflict: your dump rule wins over a demand match (${best.pattern.label}, ${best.pattern.strength}).`);
      if (craft) reasons.push(`Conflict: your dump rule wins over crafting potential (${craft.action}, +${craft.expectedProfit} ex expected).`);
      const audit: DiscardAudit = {
        eligible: true,
        basis: "user-rule",
        checks: [
          { id: "identified", ok: parsed.identified, detail: "item is identified" },
          { id: "user-rule", ok: true, detail: `your dump rule matched: ${verdict.matchedRules.join(", ")}` },
        ],
      };
      return finish("discard-eligible", `Discard eligible — your dump rule matched (${verdict.matchedRules.join(", ")}).`, {
        discard: audit,
        policy: "Automation drops this item (explicit dump rule) unless a safety gate intervenes.",
      });
    }
    if (verdict.tier === "sell" && best?.pattern.strength === "chase") {
      reasons.push(`Conflict: your sell rule wins over a chase demand match (${best.pattern.label}); loosen the rule to let demand route it to keep.`);
    }
    const outcome = outcomeForTier(verdict.tier);
    return finish(outcome, `${outcome === "keep" ? "Keep" : "List"} — your ${verdict.tier} rule matched (${verdict.matchedRules.join(", ")}).`);
  }

  // 4. A real price-table price (exact name or base).
  if (verdict.source === "price-table" && !verdict.priceFloor) {
    evidence.push({ kind: "price-table", label: `Price table: ${verdict.price} ${verdict.currency}`, detail: verdict.reasons[0] });
    const outcome = outcomeForTier(verdict.tier);
    return finish(outcome, `${outcome === "keep" ? "Keep" : "List"} — ${verdict.reasons[0] ?? "price table"}`);
  }

  // 5. Demand promotion (unknown → keep/sell by a curated pattern).
  if (verdict.source === "demand" && best) {
    const outcome = outcomeForTier(verdict.tier);
    return finish(outcome, `${outcome === "keep" ? "Keep" : "List"} — ${best.pattern.label}: ${describeMatch(best)}.`);
  }

  // 6. Appraisal promotion (score + confidence), or a price-table floor tier.
  if (verdict.source === "heuristic" || (verdict.source === "price-table" && verdict.priceFloor)) {
    const appraisal = verdict.appraisal;
    if (verdict.source === "heuristic" && appraisal) {
      evidence.push({ kind: "appraisal", label: `Appraised ${appraisal.valueScore}/100 at ${appraisal.confidence}% confidence` });
    }
    const outcome = outcomeForTier(verdict.tier);
    return finish(outcome, `${outcome === "keep" ? "Keep" : "List"} — ${verdict.reasons[0] ?? "promoted"}`);
  }

  // 7. Nothing explicit matched: crafting potential, then the discard audit.
  const craft = craftCase(text, parsed, assessment, input.priceTable);
  if (craft) {
    evidence.push({ kind: "craft", label: `Craft step: ${craft.action} (+${craft.expectedProfit} ex expected)`, detail: craft.reason });
    return finish("keep", `Keep as crafting stock — ${craft.reason}`, { craft, policy: "Retained; the sorter's craft tab (when set) receives it." });
  }
  const audit = auditDiscard({ parsed, verdict, assessment });
  if (audit.eligible) {
    return finish("discard-eligible", "Discard eligible — every audit check passed: no demand, no strong or unjudged lines, covered class.", { discard: audit });
  }
  const need = reviewNeed({ parsed, verdict, assessment, audit });
  return finish("review", `Review (P${need.priority}) — ${need.reason}.`, { discard: audit, review: need, policy: "Retained; queued for local review." });
}

// ---------------------------------------------------------------------------
// The full evaluation: verdict + demand promotion + decision
// ---------------------------------------------------------------------------

export interface EvaluateItemDecisionOptions extends EvaluateWithAppraisalOptions {
  knowledge?: DemandKnowledge;
  now?: Date;
}

function promotedTier(strength: DemandStrength): TriageTier {
  return strength === "chase" ? "keep" : "sell";
}

/**
 * evaluateWithAppraisal, then: promote a still-unknown (or merely
 * heuristic) verdict by a curated demand match, and attach the decision.
 * Safety, saved prices, explicit rules and real prices are never overridden.
 */
export function evaluateItemDecision(itemText: string, options: EvaluateItemDecisionOptions): TierVerdict {
  const text = typeof itemText === "string" ? itemText : "";
  const parsed = options.parsed ?? (looksLikePoeItemText(text) ? parseItemText(parseAdvancedItemText(text).plainText) : undefined);
  const base = evaluateWithAppraisal(text, { ...options, ...(parsed ? { parsed } : {}) });
  if (!parsed || base.source === "safety") {
    if (!parsed) return base;
    const assessment = assessDemand(parsed, base.appraisal, { ...(options.knowledge ? { knowledge: options.knowledge } : {}), ...(options.now ? { now: options.now } : {}) });
    return { ...base, decision: decideItem({ text, parsed, verdict: base, assessment, ...(options.priceTable ? { priceTable: options.priceTable } : {}) }) };
  }
  const appraisal: ItemAppraisal = base.appraisal ?? appraiseItem(text, { parsed });
  const assessment = assessDemand(parsed, appraisal, {
    ...(options.knowledge ? { knowledge: options.knowledge } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let verdict: TierVerdict = base;
  const best = assessment.best;
  // A demand match explains and may raise an unknown or appraisal-promoted
  // verdict; it never touches safety, saved prices, rules or real prices.
  const promotable = base.tier === "unknown" || base.source === "heuristic";
  if (best && promotable) {
    const tier: TriageTier = base.tier === "keep" || promotedTier(best.pattern.strength) === "keep" ? "keep" : "sell";
    {
      const confidence = demandConfidence(best, assessment);
      verdict = {
        ...base,
        tier,
        source: "demand",
        reasons: [
          `${best.pattern.label}: ${describeMatch(best)} — ${best.met.join("; ")}.`,
          DEMAND_NOT_PRICE,
          ...base.reasons.filter((reason) => !/routes normally/i.test(reason)),
        ],
        appraisal: {
          ...appraisal,
          evidence: "demand",
          confidence: Math.max(appraisal.confidence, confidence),
          band: bandFor(Math.max(appraisal.confidence, confidence)),
          reasons: [`Build demand: ${best.pattern.label} (${best.pattern.strength}).`, ...appraisal.reasons],
        },
      };
    }
  }
  const decision = decideItem({
    text,
    parsed,
    verdict,
    assessment,
    ...(options.priceTable ? { priceTable: options.priceTable } : {}),
  });
  return { ...verdict, decision };
}

function bandFor(confidence: number): ItemAppraisal["band"] {
  if (confidence >= 85) return "very-high";
  if (confidence >= 65) return "high";
  if (confidence >= 40) return "medium";
  return "low";
}

/** Short label for logs: "keep (demand: chase — Lightning Arrow Deadeye)". */
export function describeDecision(decision: ItemDecision | undefined): string {
  if (!decision) return "no decision";
  const outcome = decision.outcome === "discard-eligible" ? "discard eligible" : decision.outcome;
  const via = decision.demand
    ? `demand: ${decision.demand.strength} — ${decision.demand.builds.slice(0, 3).join(", ") || decision.demand.label}${decision.demand.builds.length > 3 ? ", …" : ""}`
    : decision.discard?.eligible && decision.discard.basis === "audit"
      ? "audit passed: no demand, no strong or unjudged lines"
      : decision.evidence[0]?.label ?? decision.review?.reason ?? "";
  return via ? `${outcome} (${via})` : outcome;
}
