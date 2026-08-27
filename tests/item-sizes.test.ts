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
