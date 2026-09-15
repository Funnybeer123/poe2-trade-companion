import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appraiseItem, evaluateWithAppraisal } from "../src/core/appraisal.js";
import { assessDemand } from "../src/core/buildDemand.js";
import { DEMAND_KNOWLEDGE } from "../src/data/demand/buildDemand.js";
import { planCraft } from "../src/core/crafting.js";
import { categoryForDecision, scoreDesirability } from "../src/core/desirability.js";
import { scoreBuildAwareDesirability } from "../src/core/gearTargetMatcher.js";
import { createBuildProfile } from "../src/core/buildProfiles.js";
import {
  auditDiscard,
  decideItem,
  describeDecision,
  DEMAND_NOT_PRICE,
  evaluateItemDecision,
  MIN_CRAFT_CONFIDENCE,
  MIN_CRAFT_PROFIT_EXALTED,
} from "../src/core/itemDecision.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";
import { valueItemLocally } from "../src/core/localValuation.js";
import { screenForLookup } from "../src/core/lookupScreen.js";
import { decideDrop } from "../src/core/mapTriage.js";
import { parseItemText } from "../src/core/parseItem.js";
import { emptyPriceTable, starterPriceTable, type PriceTable } from "../src/core/priceTable.js";
import type { PriceLesson } from "../src/core/priceTraining.js";
import { emptyValueTierRules, starterValueTierRules, type ValueTierRules } from "../src/core/valueTiers.js";
import { needsPriceReview, reviewReasonFor } from "../src/adapters/priceTrainingStore.js";

const NOW = new Date("2026-09-14T22:00:00Z");
const item = (lines: string[]): string => lines.join("\n");
const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");
const rules = (partial: Partial<ValueTierRules> = {}): ValueTierRules => ({ ...emptyValueTierRules(), ...partial });
const decide = (text: string, options: Parameters<typeof evaluateItemDecision>[1] = { rules: rules() }) =>
  evaluateItemDecision(text, { now: NOW, ...options });

const JUNK_RING = item([
  "Item Class: Rings", "Rarity: Rare", "Doom Loop", "Iron Ring", "--------", "Item Level: 70", "--------",
  "+15 to Accuracy Rating", "10% increased Light Radius", "+12 to maximum Mana",
]);

const LA_BOW = item([
  "Item Class: Bows", "Rarity: Rare", "Storm Fletch", "Composite Bow", "--------",
  "Physical Damage: 120-230 (augmented)", "Lightning Damage: 2-68 (lightning)", "Critical Hit Chance: 5.00%",
  "Attacks per Second: 1.45 (augmented)", "--------", "Item Level: 82", "--------",
  "142% increased Physical Damage", "Adds 2 to 68 Lightning damage", "26% increased Attack Speed",
  "Bow Attacks fire an Additional Arrow", "+3 to Level of all Projectile Skills",
]);

const META_BOOTS = item([
  "Item Class: Boots", "Rarity: Rare", "Gale Track", "Stellar Sandals", "--------", "Item Level: 81", "--------",
  "32% increased Movement Speed", "+112 to maximum Life", "+38% to Fire Resistance", "+35% to Cold Resistance",
]);

const CRAFT_BOOTS = item([
  "Item Class: Boots", "Rarity: Rare", "Gale Track", "Stellar Sandals", "--------", "Item Level: 81", "--------",
  "32% increased Movement Speed", "+112 to maximum Life",
]);

describe("decision precedence", () => {
  it("never discards what a safety gate retained, even against a dump rule", () => {
    const dumpAll = rules({ dump: [{ name: "everything", regex: '"Rarity"' }] });
    const unidentified = decide(item(["Item Class: Rings", "Rarity: Rare", "Gold Ring", "--------", "Unidentified"]), { rules: dumpAll });
    expect(unidentified.decision).toMatchObject({ outcome: "review", review: { priority: 1 } });
    expect(decideDrop(unidentified, false).drop).toBe(false);
    const unreadable = decide("clipboard noise", { rules: dumpAll });
    expect(unreadable.decision).toBeUndefined();
    expect(decideDrop(unreadable, false).drop).toBe(false);
  });

  it("lets a saved price example outrank a dump rule and a demand match", () => {
    const raw = fixture("chilling-sapphire-training.txt");
    const lesson: PriceLesson = {
      id: "sapphire", itemText: raw, league: "Forbidden Rites", amount: 1, currency: "divine", evidence: "estimate",
      scope: "exact", createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z",
    };
    const dump = rules({ dump: [{ name: "jewels", regex: "Sapphire" }] });
    const verdict = decide(raw, { rules: dump, training: { league: "Forbidden Rites", lessons: [lesson], now: NOW } });
    expect(verdict).toMatchObject({ tier: "keep", source: "training", price: 1, currency: "divine" });
    expect(verdict.decision).toMatchObject({ outcome: "keep" });
    expect(verdict.decision?.evidence[0]).toMatchObject({ kind: "saved-price" });
    expect(verdict.decision?.headline).not.toMatch(/divine.*jewel/i);
    // Stale evidence retains for review with the top priority.
    const stale = decide(raw, { rules: dump, training: { league: "Forbidden Rites", lessons: [{ ...lesson, observedAt: "2026-07-01T00:00:00Z" }], now: NOW } });
    expect(stale.decision).toMatchObject({ outcome: "review", review: { priority: 1 } });
    expect(needsPriceReview(stale)).toBe(true);
  });

  it("maps explicit rules to keep / list / discard-eligible and shows conflicts instead of hiding them", () => {
    const keep = decide(META_BOOTS, { rules: rules({ keep: [{ name: "fast boots", regex: '"Movement Speed"' }] }) });
    expect(keep.decision).toMatchObject({ outcome: "keep" });
    expect(keep.decision?.evidence[0]).toMatchObject({ kind: "user-rule", label: "Your keep rule: fast boots" });
    const sell = decide(META_BOOTS, { rules: rules({ sell: [{ name: "fast boots", regex: '"Movement Speed"' }] }) });
    expect(sell.decision?.outcome).toBe("list");
    const dump = decide(META_BOOTS, { rules: rules({ dump: [{ name: "all boots", regex: '"Item Class: Boots"' }] }) });
    expect(dump.decision).toMatchObject({ outcome: "discard-eligible", discard: { eligible: true, basis: "user-rule" } });
    expect(dump.decision?.reasons.join(" ")).toMatch(/Conflict: your dump rule wins over a demand match/);
    expect(decideDrop(dump, true).drop).toBe(true);
  });

  it("uses a real price-table price but treats a rarity-wide floor as a placeholder", () => {
    const named: PriceTable = { ...emptyPriceTable(), entries: [{ id: "widowhail", match: { name: "Widowhail" }, value: 12 }] };
    const priced = decide(fixture("unique-bow.txt"), { rules: rules(), priceTable: named });
    expect(priced).toMatchObject({ tier: "keep", source: "price-table", price: 12 });
    expect(priced.decision).toMatchObject({ outcome: "keep" });
    expect(priced.decision?.evidence[0]).toMatchObject({ kind: "price-table" });

    const floored = decide(fixture("unique-bow.txt"), { rules: rules(), priceTable: starterPriceTable() });
    expect(floored.tier).toBe("sell");
    expect(floored.price).toBeUndefined();
    expect(floored.priceFloor).toMatchObject({ id: "any-unique", value: 1 });
    expect(floored.appraisal?.estimatedValue).toBeUndefined();
    expect(floored.decision?.evidence.some((entry) => entry.kind === "price-floor")).toBe(true);
    // The starter keep rule outranks the floor, so uniques are kept for review, not "sold at 1 ex".
    const starter = decide(fixture("unique-bow.txt"), { rules: starterValueTierRules(), priceTable: starterPriceTable() });
    expect(starter).toMatchObject({ tier: "keep", source: "rule" });
    expect(starter.priceFloor).toBeUndefined();
    // …and the shop screen sends such a unique to a lookup instead of a 1 ex local price.
    const screen = screenForLookup([{ key: "u", name: "Widowhail", tier: "unknown", rarity: "Unique", appraisal: floored.appraisal }]);
    expect(screen[0]).toMatchObject({ route: "lookup" });
  });

  it("promotes an unknown item by a chase demand match with an explanation that is not a price", () => {
    const verdict = decide(LA_BOW);
    expect(verdict).toMatchObject({ tier: "keep", source: "demand" });
    expect(verdict.appraisal?.evidence).toBe("demand");
    expect(verdict.appraisal?.confidence).toBeGreaterThanOrEqual(55);
    expect(verdict.reasons).toContain(DEMAND_NOT_PRICE);
    expect(verdict.decision).toMatchObject({ outcome: "keep", demand: { patternId: "bow-arrows-chase", strength: "chase" } });
    expect(verdict.decision?.demand?.builds).toContain("Ice Shot Deadeye");
    expect(verdict.decision?.demand?.sources.some((source) => source.kind === "ladder" && source.date === "2026-09-14")).toBe(true);
    expect(verdict.decision?.demand?.sources.every((source) => /^https:\/\//.test(source.url) && source.date)).toBe(true);
    expect(verdict.price).toBeUndefined();
    expect(describeDecision(verdict.decision)).toBe("keep (demand: chase — Ice Shot Deadeye, Lightning Arrow Deadeye)");
  });

  it("never overrides a saved price, a rule or a real price with demand", () => {
    const keepRule = decide(LA_BOW, { rules: rules({ sell: [{ name: "bows", regex: '"Item Class: Bows"' }] }) });
    expect(keepRule).toMatchObject({ tier: "sell", source: "rule" });
    expect(keepRule.decision?.outcome).toBe("list");
  });

  it("keeps a defensible craft case and rejects a trivial augment", () => {
    // No demand patterns: the craft fallback has to carry the decision.
    const noPatterns = { ...DEMAND_KNOWLEDGE, patterns: [] };
    const plan = planCraft(CRAFT_BOOTS);
    expect(plan.action).toBe("exalt");
    expect(plan.expectedProfit).toBeGreaterThanOrEqual(MIN_CRAFT_PROFIT_EXALTED);
    expect(plan.confidence).toBeGreaterThanOrEqual(MIN_CRAFT_CONFIDENCE);
    const verdict = decide(CRAFT_BOOTS, { rules: rules(), knowledge: noPatterns });
    expect(verdict.tier).toBe("unknown");
    expect(verdict.decision).toMatchObject({ outcome: "keep", craft: { action: "exalt" } });
    expect(categoryForDecision(verdict.decision!)).toBe("craft");
    // A one-affix magic ring with a tier-2 resistance is not "augment stock".
    const ring = decide(fixture("amethyst-ring-of-the-ice.txt"));
    expect(ring.decision?.craft).toBeUndefined();
  });
});

describe("discard audit", () => {
  it("proposes a discard only when every check passes, and never executes it by default", () => {
    const verdict = decide(JUNK_RING);
    expect(verdict.tier).toBe("unknown");
    expect(verdict.decision).toMatchObject({ outcome: "discard-eligible", discard: { eligible: true, basis: "audit" } });
    expect(verdict.decision?.discard?.checks.every((check) => check.ok)).toBe(true);
    expect(verdict.decision?.policy).toMatch(/Proposal only/);
    expect(decideDrop(verdict).drop).toBe(true); // legacy default of the pure helper: keepUnknown=false
    expect(decideDrop(verdict, true)).toMatchObject({ drop: false });
    expect(decideDrop(verdict, true).reason).toMatch(/^retained \(discard-eligible\)/);
    expect(needsPriceReview(verdict)).toBe(false);
  });

  it.each([
    ["an unjudged line", JUNK_RING.replace("+12 to maximum Mana", "Gain 1.5 Life, -2 Mana and 3 Rage on Hit"), "lines-understood"],
    ["a situational line", JUNK_RING.replace("+12 to maximum Mana", "14% increased Thorns damage"), "no-situational-lines"],
    ["a tier-1 affix", JUNK_RING.replace("+12 to maximum Mana", "+160 to maximum Life"), "no-top-tier-affix"],
    ["a valuable base", JUNK_RING.replace("Iron Ring", "Time-Lost Ruby Ring"), "not-valuable-base"],
    ["an uncovered class", JUNK_RING.replace("Item Class: Rings", "Item Class: Charms"), "class-covered"],
    ["a unique", JUNK_RING.replace("Rarity: Rare", "Rarity: Unique"), "rarity"],
  ])("blocks the audit on %s and asks for review instead", (_label, text, failedCheck) => {
    const verdict = decide(text);
    expect(verdict.decision?.outcome).toBe("review");
    expect(verdict.decision?.discard?.eligible).toBe(false);
    expect(verdict.decision?.discard?.checks.find((check) => check.id === failedCheck)?.ok).toBe(false);
    expect(decideDrop(verdict, false).drop).toBe(false);
    expect(needsPriceReview(verdict)).toBe(true);
  });

  it("stops proposing discards once the knowledge is past its review date", () => {
    const verdict = evaluateItemDecision(JUNK_RING, { rules: rules(), now: new Date("2026-12-01T00:00:00Z") });
    expect(verdict.decision?.outcome).toBe("review");
    expect(verdict.decision?.discard?.checks.find((check) => check.id === "knowledge-current")?.ok).toBe(false);
    expect(verdict.decision?.coverage.expired).toBe(true);
  });

  it("judges weapons by printed DPS: weak drops, unreadable stays", () => {
    const weak = decide(item([
      "Item Class: Bows", "Rarity: Rare", "Dusk Fletch", "Crude Bow", "--------", "Physical Damage: 20-40",
      "Attacks per Second: 1.20", "--------", "Item Level: 65", "--------", "+25 to Accuracy Rating", "10% increased Light Radius",
    ]));
    expect(weak.decision?.outcome).toBe("discard-eligible");
    const unreadable = decide(item([
      "Item Class: Bows", "Rarity: Rare", "Dusk Fletch", "Crude Bow", "--------", "Item Level: 65", "--------",
      "+25 to Accuracy Rating", "10% increased Light Radius",
    ]));
    expect(unreadable.decision).toMatchObject({ outcome: "review", review: { priority: 2 } });
    expect(unreadable.decision?.discard?.checks.find((check) => check.id === "weapon-dps-weak")?.ok).toBe(false);
  });

  it("exposes the audit as data the UI can list", () => {
    const parsed = parseItemText(parseAdvancedItemText(JUNK_RING).plainText);
    const verdict = evaluateWithAppraisal(JUNK_RING, { rules: rules(), parsed });
    const audit = auditDiscard({ parsed, verdict, assessment: assessDemand(parsed, appraiseItem(JUNK_RING, { parsed }), { now: NOW }) });
    expect(audit.checks.map((check) => check.id)).toEqual([
      "identified", "class-covered", "rarity", "no-protection", "no-price-floor", "lines-understood", "no-situational-lines",
      "no-demand", "no-top-tier-affix", "few-strong-affixes", "no-craft-case", "not-valuable-base", "knowledge-current",
    ]);
  });
});

describe("corrections that must survive", () => {
  it.each(["Heavy Belt", "Utility Belt"])("keeps a Normal %s (level 50) as a crafting base by the user's rule", (base) => {
    const text = `Item Class: Belts\nRarity: Normal\n${base}\n--------\nRequires: Level 50\n--------\nItem Level: 60`;
    const verdict = decide(text, { rules: starterValueTierRules(), priceTable: starterPriceTable() });
    expect(verdict).toMatchObject({ tier: "keep", source: "rule", matchedRules: ["Normal belt crafting bases"] });
    expect(verdict.decision?.outcome).toBe("keep");
    expect(decideDrop(verdict, false).drop).toBe(false);
  });

  it("retains the Sapphire for review without a lesson and never turns it into a universal jewel price", () => {
    const raw = fixture("chilling-sapphire-training.txt");
    const verdict = decide(raw, { rules: starterValueTierRules(), priceTable: starterPriceTable() });
    expect(verdict.decision).toMatchObject({ outcome: "review", review: { priority: 2 } });
    expect(verdict.decision?.coverage.unsupported).toEqual(["11% faster Curse Activation"]);
    expect(verdict.price).toBeUndefined();
    expect(reviewReasonFor(verdict)).toMatch(/^\[P2\] cannot judge: 11% faster Curse Activation/);
    const otherSapphire = decide(raw.replace("11(15-5)% faster Curse Activation", "8(15-5)% faster Curse Activation").replace("15(5-15)% increased Cold Damage", "9(5-15)% increased Cold Damage"));
    expect(otherSapphire.decision?.outcome).toBe("review");
    expect(otherSapphire.price).toBeUndefined();
  });

  it("retains the Ghoul Thirst bow without manufacturing a label", () => {
    const verdict = decide(fixture("ghoul-thirst-gemini-bow.txt"), { rules: starterValueTierRules(), priceTable: starterPriceTable() });
    expect(["keep", "list", "review"]).toContain(verdict.decision?.outcome);
    expect(verdict.decision?.outcome).not.toBe("discard-eligible");
    expect(decideDrop(verdict, true).drop).toBe(false);
    expect(verdict.price).toBeUndefined();
    expect(verdict.appraisal?.estimatedValue).toBeUndefined();
  });
});

describe("drop and review semantics", () => {
  it("keeps legacy behaviour for verdicts without a decision", () => {
    const legacy = evaluateWithAppraisal(JUNK_RING, { rules: rules() });
    expect(legacy.decision).toBeUndefined();
    expect(decideDrop(legacy, true)).toMatchObject({ drop: false, reason: "matched no rule (kept by --keep-unknown)" });
    expect(decideDrop(legacy, false)).toMatchObject({ drop: true, reason: "matched no keep/sell rule" });
    expect(needsPriceReview(legacy)).toBe(true);
  });

  it("queues only review outcomes, with a priority tag", () => {
    const listed = decide(fixture("rift-edge-soaring-spear.txt"));
    expect(listed.decision?.outcome).toBe("list");
    expect(needsPriceReview(listed)).toBe(false);
    const review = decide(fixture("retaliating-ruby-jewel.txt"));
    expect(review.decision).toMatchObject({ outcome: "review", review: { priority: 3 } });
    expect(reviewReasonFor(review)).toMatch(/^\[P3\] build-specific line/);
  });
});

describe("recommendations agree with the decision", () => {
  function evaluationFor(text: string) {
    const verdict = decide(text, { rules: starterValueTierRules(), priceTable: starterPriceTable() });
    const parsed = parseItemText(parseAdvancedItemText(text).plainText);
    const valuation = valueItemLocally({ parsed, priceTable: starterPriceTable(), verdict, now: NOW });
    return { verdict, parsed, valuation };
  }

  it("maps keep / list / review / discard-eligible onto the recommendation category", () => {
    const junk = evaluationFor(JUNK_RING);
    expect(scoreDesirability(junk.parsed, junk.valuation, undefined, junk.verdict)).toMatchObject({ category: "dump" });
    const bow = evaluationFor(LA_BOW);
    const desirability = scoreDesirability(bow.parsed, bow.valuation, undefined, bow.verdict);
    expect(desirability.category).toBe("keep");
    expect(desirability.reasons[0]).toBe(bow.verdict.decision?.headline);
    expect(desirability.reasons.some((reason) => reason.startsWith("General demand (not a price)"))).toBe(true);
    const ruby = evaluationFor(fixture("retaliating-ruby-jewel.txt"));
    expect(scoreDesirability(ruby.parsed, ruby.valuation, undefined, ruby.verdict).category).toBe("review");
  });

  it("labels personal build targets as yours, apart from general demand", () => {
    const junk = evaluationFor(JUNK_RING);
    const profile = createBuildProfile({
      name: "Mine", active: true,
      gearTargets: [{ slot: "ring", itemClass: "Rings", statRules: [{ stat: "accuracy rating", operator: "exists", required: true }] }],
    }, { now: NOW });
    const { desirability } = scoreBuildAwareDesirability(junk.parsed, junk.valuation, [profile], junk.verdict);
    expect(desirability.category).toBe("keep");
    expect(desirability.reasons.some((reason) => reason.startsWith("Your build:"))).toBe(true);
    expect(desirability.reasons[0]).toBe(junk.verdict.decision?.headline);
  });
});
