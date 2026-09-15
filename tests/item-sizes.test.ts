import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSpriteItems } from "../src/core/itemSprites.js";
import {
  bucketSpritesBySize,
  enrichItemSize,
  indexByGridSize,
  learnFromClipboard,
  loadItemSizeDatabase,
  mergeSameItemFragments,
  lookupItemSize,
  saveItemSizeDatabase,
  upsertMeasuredSize,
  withClassDefaults,
  emptySizeDatabase,
} from "../src/core/itemSizeStore.js";
import { parseItemText } from "../src/core/parseItem.js";
import { paintGridSprite, stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

const STASH = { x: 80, y: 144, w: 736, h: 630 };

describe("item size database", () => {
  it("looks up currency and flasks by item class before anything is measured", () => {
    const db = withClassDefaults(emptySizeDatabase());
    const orb = enrichItemSize(parseItemText(fixture("exalted.txt")), db);
    expect(orb.gridW).toBe(1);
    expect(orb.gridH).toBe(1);
    expect(lookupItemSize(db, parseItemText(fixture("rare-body.txt")))).toMatchObject({ w: 2, h: 3 });
  });

  it("stores a measured stash sprite size under the Ctrl+C base type", () => {
    let db = withClassDefaults(emptySizeDatabase());
    const learned = learnFromClipboard(db, fixture("rare-body.txt"), { w: 2, h: 4 });
    db = learned.db;
    expect(learned.created).toBe(true);
    expect(learned.item.baseType).toBe("Advanced Maraketh Coat");
    expect(learned.item.gridW).toBe(2);
    expect(learned.item.gridH).toBe(4);
    const again = enrichItemSize(parseItemText(fixture("rare-body.txt")), db);
    expect(again.gridW).toBe(2);
    expect(again.gridH).toBe(4);
    expect(indexByGridSize(db)["2x4"]?.some((row) => row.baseType === "Advanced Maraketh Coat")).toBe(true);
  });

  it.each(["Boar Idol", "Greater Robust Rune"])("keeps live Augment %s at one cell even when adjacent sprites merge", (name) => {
    const text = `Item Class: Augment\nRarity: Currency\n${name}\n--------\nStack Size: 1/10`;
    const db = withClassDefaults(emptySizeDatabase());
    expect(lookupItemSize(db, parseItemText(text))).toMatchObject({ w: 1, h: 1 });
    const learned = learnFromClipboard(db, text, { w: 2, h: 1 });
    expect(lookupItemSize(learned.db, learned.item)).toMatchObject({ w: 1, h: 1 });
  });

  it("keeps a Twilight Reliquary Key at one cell before and after an oversized sprite measurement", () => {
    const text = "Item Class: Vault Keys\nRarity: Currency\nTwilight Reliquary Key\n--------\nCan only be used once.";
    const db = withClassDefaults(emptySizeDatabase());
    expect(lookupItemSize(db, parseItemText(text))).toMatchObject({ w: 1, h: 1 });
    const learned = learnFromClipboard(db, text, { w: 2, h: 2 });
    expect(lookupItemSize(learned.db, learned.item)).toMatchObject({ w: 1, h: 1 });
  });

  it("refreshes obsolete persisted class defaults without changing measured base sizes", () => {
    const item = parseItemText("Item Class: Spears\nRarity: Rare\nSoaring Spear\n--------\nUnidentified");
    const initial = withClassDefaults(emptySizeDatabase());
    const stale = { ...initial, records: initial.records.map((row) =>
      row.key === "class:spears" ? { ...row, w: 2 } : row) };
    const reconciled = withClassDefaults(stale);
    expect(lookupItemSize(reconciled, item)).toMatchObject({
      w: 1, h: 4, record: { kind: "itemClass", source: "class-default" },
    });
    expect(stale.records.find((row) => row.key === "class:spears")?.w).toBe(2);
    const measured = upsertMeasuredSize(stale, item, { w: 2, h: 4 }).db;
    expect(lookupItemSize(withClassDefaults(measured), item)).toMatchObject({
      w: 2, h: 4, record: { kind: "baseType", source: "measured" },
    });
  });

  it("preserves measured class rows and unknown class defaults during reconciliation", () => {
    const initial = withClassDefaults(emptySizeDatabase());
    const measuredClass = { ...initial.records.find((row) => row.key === "class:spears")!,
      w: 2, source: "measured" as const, samples: 1 };
    const unknownClass = { ...measuredClass, key: "class:uncatalogued", itemClass: "Uncatalogued",
      source: "class-default" as const, samples: 0 };
    const input = { ...initial, records: [
      ...initial.records.filter((row) => row.key !== "class:spears"), measuredClass, unknownClass,
    ] };
    const reconciled = withClassDefaults(input);
    expect(reconciled.records).toContainEqual(measuredClass);
    expect(reconciled.records).toContainEqual(unknownClass);
    expect(reconciled).toBe(input);
  });

  it("records a new unknown unique from its measured sprite size", () => {
    const learned = learnFromClipboard(withClassDefaults(emptySizeDatabase()), fixture("unique-bow.txt"), {
      w: 2,
      h: 4,
    });
    expect(learned.created).toBe(true);
    expect(learned.item.baseType).toBe("Crude Bow");
    expect(learned.item.gridW).toBe(2);
    expect(learned.item.gridH).toBe(4);
    const byName = lookupItemSize(learned.db, parseItemText(fixture("unique-bow.txt")));
    expect(byName).toMatchObject({ w: 2, h: 4 });
  });

  it("persists measured sizes so a later Ctrl+C can load them", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "poe2-sizes-")), "item-sizes.json");
    const learned = learnFromClipboard(loadItemSizeDatabase(file), fixture("rare-body.txt"), { w: 2, h: 3 });
    saveItemSizeDatabase(file, learned.db);
    const reloaded = loadItemSizeDatabase(file);
    const item = enrichItemSize(parseItemText(fixture("rare-body.txt")), reloaded);
    expect(item.gridW).toBe(2);
    expect(item.gridH).toBe(3);
  });

  it("indexes an open stash scan by each legal item size", () => {
    const frame = stashAndBagFrame();
    paintGridSprite(frame, STASH, 12, 12, 0, 0, 2, 4);
    paintGridSprite(frame, STASH, 12, 12, 0, 3, 1, 3);
    paintGridSprite(frame, STASH, 12, 12, 0, 5, 2, 2);
    paintGridSprite(frame, STASH, 12, 12, 0, 8, 1, 1);
    const items = detectSpriteItems(frame, TEST_CLIENT, STASH, 12, 12);
    const buckets = bucketSpritesBySize(items);
    expect(buckets["2x4"]?.length).toBe(1);
    expect(buckets["1x3"]?.length).toBe(1);
    expect(buckets["2x2"]?.length).toBe(1);
    expect(buckets["1x1"]?.length).toBe(1);
  });

  it("does not store a merged 2x1 size for currency after Ctrl+C", () => {
    const learned = learnFromClipboard(withClassDefaults(emptySizeDatabase()), fixture("exalted.txt"), {
      w: 2,
      h: 1,
    });
    expect(learned.item.gridW).toBe(1);
    expect(learned.item.gridH).toBe(1);
    expect(lookupItemSize(learned.db, learned.item)).toMatchObject({ w: 1, h: 1 });
  });

  it("merges split fragments of the same copied item into one legal size", () => {
    const item = parseItemText(fixture("unique-bow.txt"));
    const merged = mergeSameItemFragments([
      { item, cells: [{ row: 0, col: 0 }, { row: 1, col: 0 }], w: 1, h: 2 },
      { item, cells: [{ row: 2, col: 0 }, { row: 3, col: 0 }, { row: 2, col: 1 }, { row: 3, col: 1 }], w: 2, h: 2 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ w: 2, h: 4 });
  });

  it("keeps the committed size file loadable", () => {
    const db = loadItemSizeDatabase(path.join(process.cwd(), "fixtures", "item-sizes", "item-sizes.json"));
    expect(lookupItemSize(db, parseItemText(fixture("exalted.txt")))).toMatchObject({ w: 1, h: 1 });
  });
});
