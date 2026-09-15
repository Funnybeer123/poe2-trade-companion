import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PriceTrainingStore, PRICE_TRAINING_FILE } from "../src/adapters/priceTrainingStore.js";
import { trainingIdentity, type PriceLessonInput } from "../src/core/priceTraining.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";

const advanced = readFileSync(new URL("../fixtures/items/chilling-sapphire-training.txt", import.meta.url), "utf8");
const plain = parseAdvancedItemText(advanced).plainText.split("\n").filter((line) => !line.startsWith("{")).join("\n");
const lesson: PriceLessonInput = {
  itemText: advanced, league: "Test League", amount: 1, currency: "divine", evidence: "estimate", scope: "exact",
};
const ring = (roll: number) => `Item Class: Rings\nRarity: Rare\nExample Loop\nGold Ring\n--------\nItem Level: 80\n--------\n+${roll} to maximum Life`;

function rig() {
  const dir = mkdtempSync(path.join(tmpdir(), "price-training-store-"));
  const file = path.join(dir, PRICE_TRAINING_FILE);
  let now = new Date("2026-09-14T12:00:00.000Z");
  const store = new PriceTrainingStore(dir, () => now);
  const text = () => readFileSync(file, "utf8");
  const events = () => text().trim().split(/\r?\n/).map((line) => JSON.parse(line));
  return { dir, file, store, text, events, advance: () => { now = new Date(now.getTime() + 60_000); } };
}

describe("append-only price lesson history", () => {
  it("saves, reloads, edits and removes while preserving every prior event byte", () => {
    const r = rig();
    const saved = r.store.save(lesson);
    const initial = r.text();
    expect(new PriceTrainingStore(r.dir).list()).toEqual([saved]);
    r.advance();
    const edited = r.store.save({ ...lesson, amount: 2, evidence: "sale", note: "Actual sale" }, saved.id);
    expect(edited).toMatchObject({ id: saved.id, amount: 2, createdAt: saved.createdAt, evidence: "sale" });
    expect(edited.updatedAt).not.toBe(saved.updatedAt);
    expect(r.text().startsWith(initial)).toBe(true);
    const beforeRemoval = r.text();
    r.store.remove(saved.id);
    expect(r.store.list()).toEqual([]);
    expect(new PriceTrainingStore(r.dir).list()).toEqual([]);
    expect(r.text().startsWith(beforeRemoval)).toBe(true);
    expect(r.events().map((event) => event.kind)).toEqual(["lesson-save", "lesson-save", "lesson-remove"]);
    expect(r.events()[0].lesson.amount).toBe(1);
    expect(r.events()[1].lesson.amount).toBe(2);
  });

  it("replaces the same fingerprint across advanced/plain copies without duplicating lessons", () => {
    const r = rig();
    const first = r.store.save(lesson);
    r.advance();
    const updated = r.store.save({ ...lesson, itemText: plain, amount: 3 });
    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(r.store.list()).toEqual([updated]);
    expect(r.events()).toHaveLength(2);
    expect(r.events()[0].lesson.itemText).toBe(advanced);
    expect(r.events()[1].lesson.itemText).toBe(plain);
  });

  it("keeps the same item in different leagues separate, including after reload", () => {
    const r = rig();
    const first = r.store.save(lesson);
    const other = r.store.save({ ...lesson, league: "Other League", amount: 4 });
    expect(other.id).not.toBe(first.id);
    const reloaded = new PriceTrainingStore(r.dir);
    expect(reloaded.list(" test league ")).toEqual([first]);
    expect(reloaded.list("OTHER LEAGUE")).toEqual([other]);
    expect(reloaded.list()).toHaveLength(2);
  });

  it("rejects an edit into another lesson's fingerprint without changing either record", () => {
    const r = rig();
    const sapphire = r.store.save(lesson);
    const other = r.store.save({ ...lesson, itemText: ring(100), amount: 2 });
    const before = r.text();
    expect(() => r.store.save({ ...lesson, itemText: plain, amount: 3 }, other.id)).toThrow("already has a price lesson");
    expect(r.text()).toBe(before);
    expect(r.store.list()).toEqual(expect.arrayContaining([sapphire, other]));
    expect(r.store.list()).toHaveLength(2);
  });

  it("rejects invalid input or a nonexistent edit ID without writing history", () => {
    const r = rig();
    expect(() => r.store.save({ ...lesson, amount: -1 })).toThrow("positive finite");
    expect(existsSync(r.file)).toBe(false);
    r.store.save(lesson);
    const before = r.text();
    expect(() => r.store.save(lesson, "missing-id")).toThrow("no longer exists");
    r.store.remove("missing-id");
    r.store.dismissReview("missing-id");
    expect(r.text()).toBe(before);
  });

  it("preserves a valid last event without a trailing newline when appending another event", () => {
    const r = rig();
    const first = r.store.save(lesson);
    const original = r.text().trimEnd();
    writeFileSync(r.file, original);
    r.advance();
    r.store.save({ ...lesson, amount: 2 }, first.id);
    expect(r.text().startsWith(original)).toBe(true);
    expect(new PriceTrainingStore(r.dir).list()[0].amount).toBe(2);
    expect(r.events()).toHaveLength(2);
  });
});

describe("price review queue", () => {
  it("deduplicates advanced/plain fingerprints, counts sightings and persists dismissal", () => {
    const r = rig();
    r.store.enqueue("Test League", advanced, "Unknown price");
    const first = r.store.review()[0];
    r.advance();
    r.store.enqueue("Test League", plain, "Low confidence");
    const second = r.store.review()[0];
    expect(r.store.review()).toHaveLength(1);
    expect(second).toMatchObject({ id: first.id, fingerprint: first.fingerprint, firstSeen: first.firstSeen,
      seenCount: 2, reason: "Low confidence", itemText: plain });
    expect(second.lastSeen).not.toBe(first.lastSeen);
    expect(new PriceTrainingStore(r.dir).review()).toEqual([second]);
    const before = r.text();
    r.store.dismissReview(second.id);
    expect(r.store.review()).toEqual([]);
    expect(new PriceTrainingStore(r.dir).review()).toEqual([]);
    expect(r.text().startsWith(before)).toBe(true);
    expect(r.events().map((event) => event.kind)).toEqual(["review-save", "review-save", "review-dismiss"]);
  });

  it("saving a lesson dismisses only that item's same-league review entry", () => {
    const r = rig();
    r.store.enqueue("Test League", advanced, "Unknown price");
    r.store.enqueue("Other League", advanced, "Unknown price elsewhere");
    r.store.enqueue("Test League", ring(100), "Other item");
    const otherLeague = r.store.review("Other League")[0];
    const otherItem = r.store.review("Test League").find((item) => item.itemText === ring(100))!;
    r.store.save({ ...lesson, itemText: plain });
    expect(r.store.review("Test League")).toEqual([otherItem]);
    expect(r.store.review("Other League")).toEqual([otherLeague]);
    expect(r.events().at(-1).kind).toBe("review-dismiss");
  });

  it("deduplicates repeated unassigned-league entries using their stored league name", () => {
    const r = rig();
    r.store.enqueue("", advanced, "No configured league");
    r.store.enqueue("", plain, "Still no configured league");
    expect(r.store.review()).toHaveLength(1);
    expect(r.store.review()[0]).toMatchObject({ league: "Unassigned", seenCount: 2 });
  });
});

describe("training history validation and capacity", () => {
  it.each(["{broken", JSON.stringify({ version: 99, at: "2026-09-14T12:00:00Z", kind: "lesson-remove", id: "x" })])(
    "fails visibly on corrupt history and preserves every byte during attempted changes", (invalid) => {
      const r = rig();
      const saved = r.store.save(lesson);
      appendFileSync(r.file, `${invalid}\n`);
      const before = r.text();
      for (const operation of [() => r.store.list(), () => r.store.review(), () => r.store.save(lesson),
        () => r.store.remove(saved.id), () => r.store.enqueue("Test League", plain, "Review"),
        () => r.store.dismissReview("anything")]) {
        expect(operation).toThrow(/unreadable at line 2; preserve/);
        expect(r.text()).toBe(before);
      }
    },
  );

  it("rejects malformed saved IDs instead of loading values that violate the lesson contract", () => {
    const r = rig();
    r.store.save(lesson);
    const event = r.events()[0];
    event.lesson.id = 42;
    writeFileSync(r.file, `${JSON.stringify(event)}\n`);
    const before = r.text();
    expect(() => r.store.list()).toThrow("unreadable at line 1");
    expect(r.text()).toBe(before);
  });

  it("caps active lessons without preventing an edit at capacity or erasing history", () => {
    const r = rig();
    const at = "2026-09-14T12:00:00.000Z";
    const events = Array.from({ length: 1000 }, (_, index) => ({ version: 1, at, kind: "lesson-save",
      lesson: { ...lesson, itemText: ring(index + 1), id: `lesson-${index}`, observedAt: at, createdAt: at, updatedAt: at } }));
    writeFileSync(r.file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const before = r.text();
    expect(() => r.store.save({ ...lesson, itemText: ring(1001) })).toThrow("library is full");
    expect(r.text()).toBe(before);
    r.store.save({ ...lesson, itemText: ring(1), amount: 2 }, "lesson-0");
    expect(r.store.list()).toHaveLength(1000);
    expect(r.events()).toHaveLength(1001);
    expect(r.text().startsWith(before)).toBe(true);
  });

  it("caps queued items without losing existing entries or blocking duplicate sightings", () => {
    const r = rig();
    const at = "2026-09-14T12:00:00.000Z";
    const events = Array.from({ length: 500 }, (_, index) => {
      const itemText = ring(index + 1);
      const identity = trainingIdentity(itemText);
      return { version: 1, at, kind: "review-save", item: { id: `review-${index}`, itemText,
        league: "Test League", reason: "Unknown price", fingerprint: identity.fingerprint,
        groupKey: identity.groupKey, firstSeen: at, lastSeen: at, seenCount: 1 } };
    });
    writeFileSync(r.file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const before = r.text();
    expect(() => r.store.enqueue("Test League", ring(501), "Unknown price")).toThrow("queue is full");
    expect(r.text()).toBe(before);
    r.store.enqueue("Test League", ring(1), "Seen again");
    expect(r.store.review()).toHaveLength(500);
    expect(r.store.review().find((item) => item.id === "review-0")?.seenCount).toBe(2);
    expect(r.events()).toHaveLength(501);
  });
});
