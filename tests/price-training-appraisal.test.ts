import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";
import { decideDrop } from "../src/core/mapTriage.js";
import { emptyPriceTable } from "../src/core/priceTable.js";
import type { PriceLesson, PriceLessonInput } from "../src/core/priceTraining.js";
import { emptyValueTierRules } from "../src/core/valueTiers.js";
import { loadTriageExport } from "../src/adapters/triageLoader.js";
import { PRICE_TRAINING_FILE, PriceTrainingStore } from "../src/adapters/priceTrainingStore.js";

const fixture = readFileSync(path.join(process.cwd(), "fixtures/items/chilling-sapphire-training.txt"), "utf8");
const plain = parseAdvancedItemText(fixture).plainText.split("\n").filter((line) => !line.startsWith("{")).join("\n");
const now = new Date("2026-09-14T23:00:00.000Z");
const league = "Training Test League";
const input: PriceLessonInput = {
  itemText: fixture, league, amount: 1, currency: "divine", evidence: "estimate", scope: "exact",
};
const lesson = (overrides: Partial<PriceLesson> = {}): PriceLesson => ({
  ...input, id: "sapphire-example", createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides,
});
const training = (lessons: PriceLesson[] = [lesson()]) => ({ league, lessons, now });

function makeRoot(pinnedLeague = league): { root: string; dir: string; store: PriceTrainingStore } {
  const root = mkdtempSync(path.join(tmpdir(), "training-appraisal-"));
  const dir = path.join(root, "artifacts", "tab-admin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "price-feed.json"), JSON.stringify({ league: pinnedLeague }));
  writeFileSync(path.join(dir, "triage.json"), JSON.stringify({ rules: emptyValueTierRules(), priceTable: emptyPriceTable() }));
  return { root, dir, store: new PriceTrainingStore(dir, () => now) };
}

describe("price training in appraisal", () => {
  it("normalizes advanced ranges before recognizing modifier values without inventing a price", () => {
    const advanced = evaluateWithAppraisal(fixture, { rules: emptyValueTierRules() });
    const ordinary = evaluateWithAppraisal(plain, { rules: emptyValueTierRules() });
    expect(advanced.tier).toBe("unknown");
    expect(advanced.price).toBeUndefined();
    expect(advanced.appraisal?.estimatedValue).toBeUndefined();
    expect(advanced.appraisal?.mods).toEqual(ordinary.appraisal?.mods);
    expect(advanced.appraisal?.mods).toContainEqual(expect.objectContaining({
      text: "15% increased Cold Damage", familyId: "jewel-damage", judgedValue: 15,
    }));
    expect(advanced.appraisal?.mods).toContainEqual(expect.objectContaining({ text: "11% faster Curse Activation" }));
  });

  it("protects a taught one-divine estimate even when an explicit dump rule matches", () => {
    const rules = { ...emptyValueTierRules(), dump: [{ name: "Dump test jewels", regex: "Sapphire" }] };
    expect(evaluateWithAppraisal(fixture, { rules }).tier).toBe("dump");
    const verdict = evaluateWithAppraisal(fixture, { rules, training: training() });
    expect(verdict).toMatchObject({ tier: "keep", source: "training", price: 1, currency: "divine" });
    expect(verdict.training).toMatchObject({ status: "matched", matchKind: "exact", exampleCount: 1 });
    expect(verdict.appraisal?.confidence).toBeLessThanOrEqual(40);
    expect(verdict.reasons.join(" ")).toContain("user estimate");
    expect(verdict.appraisal?.estimatedValue).toMatchObject({ basis: "training", amount: 1, currency: "divine" });
    expect(decideDrop(verdict).drop).toBe(false);
  });

  it("gives plain and advanced copies the same taught price and confidence", () => {
    const options = { rules: emptyValueTierRules(), training: training() };
    const a = evaluateWithAppraisal(fixture, options);
    const b = evaluateWithAppraisal(plain, options);
    expect(b.training).toEqual(a.training);
    expect(b.price).toBe(1);
  });

  it("protects a stale lesson without presenting an old generic table value as a current quote", () => {
    const stale = lesson({ observedAt: "2026-08-01T00:00:00.000Z" });
    const priceTable = { ...emptyPriceTable(), entries: [{ id: "generic-jewel", match: { itemClass: "Jewels" }, value: 2 }] };
    const verdict = evaluateWithAppraisal(fixture, { rules: emptyValueTierRules(), priceTable, training: training([stale]) });
    expect(verdict).toMatchObject({ tier: "keep", source: "training", training: { status: "stale" } });
    expect(verdict.price).toBeUndefined();
    expect(verdict.currency).toBeUndefined();
    expect(verdict.appraisal?.estimatedValue).toBeUndefined();
    expect(decideDrop(verdict).drop).toBe(false);
  });

  it("protects conflicting evidence for review without quoting blended currencies", () => {
    const verdict = evaluateWithAppraisal(fixture, { rules: emptyValueTierRules(), training: training([
      lesson(), lesson({ id: "exalted-example", amount: 100, currency: "exalted" }),
    ]) });
    expect(verdict).toMatchObject({ tier: "keep", source: "training", training: { status: "conflict" } });
    expect(verdict.price).toBeUndefined();
    expect(verdict.appraisal?.estimatedValue).toBeUndefined();
  });

  it("does not borrow a price across different modifiers, rolls, or item corruption", () => {
    for (const itemText of [fixture.replace("Cold Damage", "Fire Damage"),
      fixture.replace("15(5-15)%", "14(5-15)%"), `${fixture}\n--------\nCorrupted`]) {
      const verdict = evaluateWithAppraisal(itemText, { rules: emptyValueTierRules(), training: training() });
      expect(verdict.training?.status).toBe("unknown");
      expect(verdict.source).not.toBe("training");
      expect(verdict.price).toBeUndefined();
    }
  });

  it("does not borrow a current example from another league", () => {
    const verdict = evaluateWithAppraisal(fixture, {
      rules: emptyValueTierRules(), training: { ...training(), league: "Another League" },
    });
    expect(verdict.training?.status).toBe("unknown");
    expect(verdict.price).toBeUndefined();
  });

  it.each(["unreadable clipboard text", `${fixture}\n--------\nUnidentified`])(
    "preserves parser and identification safety gates", (text) => {
      const verdict = evaluateWithAppraisal(text, { rules: emptyValueTierRules(), training: training() });
      expect(verdict.source).toBe("safety");
      expect(verdict.training).toBeUndefined();
      expect(verdict.price).toBeUndefined();
      expect(decideDrop(verdict).drop).toBe(false);
    },
  );
});

describe("price training through the shared triage loader", () => {
  it("loads persisted examples for the pinned league and protects them in the live evaluator", () => {
    const { root, store } = makeRoot();
    const saved = store.save(input);
    const triage = loadTriageExport(root, { now });
    const verdict = triage.evaluate(fixture);
    expect(verdict).toMatchObject({ tier: "keep", source: "training", price: 1, currency: "divine" });
    expect(verdict.training?.lessonIds).toEqual([saved.id]);
    triage.observeEvaluation?.(fixture, verdict);
    expect(store.review()).toEqual([]);
  });

  it("queues an unknown copied item locally and deduplicates plain/advanced repetitions", () => {
    const { root, store } = makeRoot();
    const triage = loadTriageExport(root, { now });
    triage.observeEvaluation?.(fixture, triage.evaluate(fixture));
    triage.observeEvaluation?.(plain, triage.evaluate(plain));
    expect(store.review(league)).toEqual([expect.objectContaining({ league, seenCount: 2 })]);
    store.save(input);
    expect(store.review(league)).toEqual([]);
    expect(loadTriageExport(root, { now }).evaluate(fixture).source).toBe("training");
  });

  it.each(["Different League", "auto", "Unassigned"])(
    "does not apply taught prices when the configured league is %s", (pinned) => {
      const { root, store } = makeRoot(pinned);
      store.save(input);
      const verdict = loadTriageExport(root, { now }).evaluate(fixture);
      expect(verdict.source).not.toBe("training");
      expect(verdict.price).toBeUndefined();
    },
  );

  it("keeps historical lessons for review and requeues the item without quoting an amount", () => {
    const { root, store } = makeRoot();
    store.save({ ...input, observedAt: "2026-08-01T00:00:00.000Z" });
    const triage = loadTriageExport(root, { now });
    const verdict = triage.evaluate(fixture);
    expect(verdict).toMatchObject({ tier: "keep", source: "training", training: { status: "stale" } });
    expect(verdict.price).toBeUndefined();
    triage.observeEvaluation?.(fixture, verdict);
    expect(store.review(league)).toHaveLength(1);
  });

  it("fails conservatively when persisted training history is damaged", () => {
    const { root, dir } = makeRoot();
    const file = path.join(dir, PRICE_TRAINING_FILE);
    const broken = "{broken training history\n";
    writeFileSync(file, broken);
    const messages: string[] = [];
    const triage = loadTriageExport(root, { now, log: (line) => messages.push(line) });
    const verdict = triage.evaluate(fixture);
    expect(verdict).toMatchObject({ tier: "keep", source: "safety" });
    expect(verdict.reasons.join(" ")).toContain("Price lessons unavailable");
    expect(decideDrop(verdict).drop).toBe(false);
    triage.observeEvaluation?.(fixture, verdict);
    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(messages).toEqual([]);
  });
});
