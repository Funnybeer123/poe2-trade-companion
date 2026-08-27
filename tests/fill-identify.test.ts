import { describe, expect, it } from "vitest";
import type { StashItem } from "../src/core/bagPack.js";
import { applyCopiedSize, pickCopyTargets, replaceSized, sizeFillPool, spriteNeedsCopy } from "../src/core/fillIdentify.js";
import { emptySizeDatabase, withClassDefaults } from "../src/core/itemSizeStore.js";

function item(id: string, w: number, h: number, row: number, col: number): StashItem {
  const cells: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) cells.push({ row: row + r, col: col + c });
  }
  return {
    id,
    w,
    h,
    grab: { row, col, x: col * 10, y: row * 10, bag: "stash" },
    cells,
  };
}

describe("fill identify middle ground", () => {
  it("trusts an isolated 1x1 and copies multi-cell sprites", () => {
    const one = item("0,0:1x1", 1, 1, 0, 0);
    const helm = item("0,3:2x2", 2, 2, 0, 3);
    expect(spriteNeedsCopy(one, [one, helm])).toBe(false);
    expect(spriteNeedsCopy(helm, [one, helm])).toBe(true);
  });

  it("copies touching 1x1s that may be a split 2x2", () => {
    const a = item("0,0:1x1", 1, 1, 0, 0);
    const b = item("0,1:1x1", 1, 1, 0, 1);
    expect(spriteNeedsCopy(a, [a, b])).toBe(true);
  });

  it("copies a 1x1 that sits on a larger occupied blob", () => {
    const one = item("0,0:1x1", 1, 1, 0, 0);
    expect(spriteNeedsCopy(one, [one], new Set(["0,0", "0,1", "1,0", "1,1"]))).toBe(true);
    expect(spriteNeedsCopy(one, [one], new Set(["0,0"]))).toBe(false);
  });

  it("copies at most eight planned uncertain items", () => {
    const planned = Array.from({ length: 12 }, (_, i) => item(`0,${i * 3}:2x2`, 2, 2, 0, i * 3));
    expect(pickCopyTargets(planned, planned)).toHaveLength(8);
    expect(pickCopyTargets([item("0,0:1x1", 1, 1, 0, 0)], [item("0,0:1x1", 1, 1, 0, 0)])).toHaveLength(0);
  });

  it("sizes a copied helmet from the class database", () => {
    const db = withClassDefaults(emptySizeDatabase());
    const sized = applyCopiedSize(
      item("2,2:1x1", 1, 1, 2, 2),
      ["Item Class: Helmets", "Rarity: Rare", "Ash Crown", "Cryptic Helm"].join("\n"),
      db,
      new Set(["2,2", "2,3", "3,2", "3,3"]),
    );
    expect(sized).toMatchObject({ w: 2, h: 2, itemClass: "Helmets" });
  });

  it("still copies the first burst when the unconfirmed plan already looks full", async () => {
    const sprites = Array.from({ length: 8 }, (_, i) => item(`0,${i}:2x2`, 2, 2, 0, i * 2));
    const occupied = sprites.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    let copies = 0;
    const result = await sizeFillPool({
      sprites,
      occupiedStash: occupied,
      occupiedBag: [],
      bagRegion: { x: 0, y: 0, w: 100, h: 100 },
      stashCols: 24,
      exclude: new Set(),
      sizeDb: withClassDefaults(emptySizeDatabase()),
      copyItem: async () => {
        copies += 1;
        return ["Item Class: Helmets", "Rarity: Normal", "Cryptic Helm"].join("\n");
      },
    });
    expect(copies).toBeGreaterThan(0);
    expect(result.copies).toBe(copies);
  });

  it("replaces a sprite without overlapping leftovers", () => {
    const one = item("0,0:1x1", 1, 1, 0, 0);
    const helm = item("0,2:1x1", 1, 1, 0, 2);
    const sized = { ...item("0,2:2x2", 2, 2, 0, 2), id: "0,2:2x2" };
    const next = replaceSized([one, helm], sized);
    expect(next.map((row) => row.id).sort()).toEqual(["0,0:1x1", "0,2:2x2"]);
  });
});
