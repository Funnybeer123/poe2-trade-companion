import { describe, expect, it } from "vitest";
import {
  classifyBagRead,
  confirmedCompactionItems,
  decideDrop,
  isGearClass,
  mergeAdjacentDuplicates,
  planLeftCompaction,
  planMapTriage,
  runDropPass,
  runIdentifyPass,
  type BagCellRead,
  type CompactionItem,
  type MapTriageCell,
  type MapTriageOps,
  type TriageSprite,
} from "../src/core/mapTriage.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

const scrollText = (stack: number): string =>
  [
    "Item Class: Stackable Currency",
    "Rarity: Currency",
    "Scroll of Wisdom",
    "--------",
    `Stack Size: ${stack}/40`,
    "--------",
    "Identifies an item",
  ].join("\n");

const unidGearText = (base = "Advanced Maraketh Coat"): string =>
  [
    "Item Class: Body Armours",
    "Rarity: Rare",
    base,
    "--------",
    "Item Level: 82",
    "--------",
    "Unidentified",
  ].join("\n");

const identifiedGearText = (name = "Corruption Carapace"): string =>
  [
    "Item Class: Body Armours",
    "Rarity: Rare",
    name,
    "Advanced Maraketh Coat",
    "--------",
    "Item Level: 82",
    "--------",
    "+30% to Fire Resistance",
    "+25% to Cold Resistance",
  ].join("\n");

const unidWaystoneText = [
  "Item Class: Waystones",
  "Rarity: Rare",
  "Waystone (Tier 12)",
  "--------",
  "Item Level: 79",
  "--------",
  "Unidentified",
].join("\n");

function read(row: number, col: number, text: string): BagCellRead {
  return { row, col, x: 2900 + col * 70, y: 1300 + row * 70, text };
}

function verdict(tier: TierVerdict["tier"], source: TierVerdict["source"] = "rule"): TierVerdict {
  return { tier, source, reasons: [`${tier} because test`], matchedRules: [] };
}

describe("classifyBagRead", () => {
  it("recognises the scroll stack with its count", () => {
    const classified = classifyBagRead(scrollText(18));
    expect(classified.kind).toBe("scroll");
    expect(classified.stack).toBe(18);
  });

  it("splits gear by identification state", () => {
    expect(classifyBagRead(unidGearText()).kind).toBe("unid-gear");
    expect(classifyBagRead(identifiedGearText()).kind).toBe("identified-gear");
  });

  it("never treats map items or currency as identifiable gear", () => {
    expect(classifyBagRead(unidWaystoneText).kind).toBe("other");
    expect(
      classifyBagRead(
        ["Item Class: Currency", "Rarity: Currency", "Exalted Orb", "--------", "Stack Size: 3/20"].join("\n"),
      ).kind,
    ).toBe("other");
  });

  it("flags empty and garbage reads", () => {
    expect(classifyBagRead("").kind).toBe("empty");
    expect(classifyBagRead("random clipboard content").kind).toBe("unreadable");
  });
});

describe("isGearClass", () => {
  it("accepts equipment classes and rejects the never-identify list", () => {
    expect(isGearClass("Body Armours")).toBe(true);
    expect(isGearClass("Rings")).toBe(true);
    expect(isGearClass("Waystones")).toBe(false);
    expect(isGearClass("Stackable Currency")).toBe(false);
    expect(isGearClass("Made Up Class")).toBe(false);
  });
});

describe("planMapTriage", () => {
  it("verifies the scroll at (0,0) and budgets by stack size", () => {
    const plan = planMapTriage([
      read(0, 0, scrollText(1)),
      read(1, 2, unidGearText("Coat A")),
      read(2, 4, unidGearText("Coat B")),
      read(3, 0, identifiedGearText()),
    ]);
    expect(plan.scroll?.stack).toBe(1);
    expect(plan.unidGear).toHaveLength(2);
    expect(plan.budget).toBe(1);
    expect(plan.issues.some((issue) => issue.startsWith("scroll-short"))).toBe(true);
  });

  it("refuses to plan when (0,0) is not the scroll", () => {
    const plan = planMapTriage([read(0, 0, unidGearText()), read(1, 1, unidGearText("Coat B"))]);
    expect(plan.scroll).toBeUndefined();
    expect(plan.budget).toBe(0);
    expect(plan.issues.some((issue) => issue.startsWith("scroll-missing"))).toBe(true);
    // The unid item sitting at (0,0) must never be counted as an identify target.
    expect(plan.unidGear).toHaveLength(1);
  });
});

/**
 * Fake game: bag cells hold text, a right-click on the scroll arms identify
 * mode (unless out of scrolls), and left-clicks follow the real mechanics —
 * an armed click identifies, an unarmed click on an occupied cell lifts the
 * item onto the cursor, a click on an occupied cell with a full cursor swaps.
 */
function fakeGame(cells: Record<string, string>, options: { scrolls: number; dropsAllowed?: boolean }) {
  const state = new Map(Object.entries(cells));
  const key = (cell: { row: number; col: number }) => `${cell.row},${cell.col}`;
  let scrolls = options.scrolls;
  let armed = false;
  let cursor = "";
  const clicks: string[] = [];
  const identifyAt = new Map<string, string>();

  const ops: MapTriageOps = {
    copyCell: async (cell: MapTriageCell) => state.get(key(cell)) ?? "",
    rightClick: async (point, why) => {
      clicks.push(`right:${key(point)}:${why}`);
      if (scrolls > 0) armed = true;
    },
    leftClick: async (point, why) => {
      const at = "row" in point && "col" in point ? key(point as MapTriageCell) : "ground";
      clicks.push(`left:${at}:${why}`);
      if (at === "ground") {
        if (cursor && options.dropsAllowed !== false) cursor = "";
        return;
      }
      const held = state.get(at) ?? "";
      if (armed) {
        armed = false;
        if (held && /Unidentified/.test(held)) {
          scrolls -= 1;
          state.set(at, identifyAt.get(at) ?? identifiedGearText());
        }
        return;
      }
      if (!cursor && held) {
        cursor = held;
        state.set(at, "");
        return;
      }
      if (cursor && !held) {
        state.set(at, cursor);
        cursor = "";
      }
    },
    sleep: async () => {},
    log: () => {},
  };
  return {
    ops,
    clicks,
    identifyAt,
    get cursor() {
      return cursor;
    },
    cellText: (row: number, col: number) => state.get(`${row},${col}`) ?? "",
  };
}

describe("runIdentifyPass", () => {
  it("identifies each unid cell via scroll right-click + cell click, verified by re-copy", async () => {
    const game = fakeGame(
      { "0,0": scrollText(5), "1,2": unidGearText("Coat A"), "2,4": unidGearText("Coat B") },
      { scrolls: 5 },
    );
    game.identifyAt.set("1,2", identifiedGearText("Blight Shell"));
    game.identifyAt.set("2,4", identifiedGearText("Corpse Ward"));
    const plan = planMapTriage([
      read(0, 0, scrollText(5)),
      read(1, 2, unidGearText("Coat A")),
      read(2, 4, unidGearText("Coat B")),
    ]);
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.aborted).toBeUndefined();
    expect(result.identified).toHaveLength(2);
    expect(result.scrollsUsed).toBe(2);
    expect(result.identified[0]?.text).toContain("Blight Shell");
    expect(game.clicks.filter((entry) => entry.startsWith("right:0,0")).length).toBe(2);
  });

  it("stops spending when the budget runs out", async () => {
    const plan = planMapTriage([
      read(0, 0, scrollText(1)),
      read(1, 2, unidGearText("Coat A")),
      read(2, 4, unidGearText("Coat B")),
    ]);
    const game = fakeGame(
      { "0,0": scrollText(1), "1,2": unidGearText("Coat A"), "2,4": unidGearText("Coat B") },
      { scrolls: 1 },
    );
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.identified).toHaveLength(1);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "no-scrolls" })]);
  });

  it("never spends a scroll on a cell that re-reads as already identified", async () => {
    const plan = planMapTriage([read(0, 0, scrollText(5)), read(1, 2, unidGearText())]);
    const game = fakeGame({ "0,0": scrollText(5), "1,2": identifiedGearText() }, { scrolls: 5 });
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.identified).toHaveLength(0);
    expect(result.scrollsUsed).toBe(0);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "already-identified" })]);
  });

  it("returns a lifted item to its cell and aborts when identify mode fails to arm", async () => {
    const plan = planMapTriage([read(0, 0, scrollText(5)), read(1, 2, unidGearText())]);
    // The game has zero scrolls despite the stale plan: the right-click
    // never arms, so the identify click lifts the item instead.
    const game = fakeGame({ "0,0": "", "1,2": unidGearText() }, { scrolls: 0 });
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.aborted).toBe("identify-misfire");
    expect(game.cursor).toBe("");
    expect(game.cellText(1, 2)).toContain("Unidentified");
  });
});

describe("decideDrop", () => {
  it("keeps keep/sell verdicts and drops dump verdicts", () => {
    expect(decideDrop(verdict("keep")).drop).toBe(false);
    expect(decideDrop(verdict("sell")).drop).toBe(false);
    expect(decideDrop(verdict("dump")).drop).toBe(true);
  });

  it("drops rule-less unknowns by default but honours keepUnknown", () => {
    expect(decideDrop(verdict("unknown", "default")).drop).toBe(true);
    expect(decideDrop(verdict("unknown", "default"), true).drop).toBe(false);
  });

  it("never drops a safety verdict", () => {
    expect(decideDrop(verdict("unknown", "safety")).drop).toBe(false);
    expect(decideDrop(verdict("keep", "safety")).drop).toBe(false);
  });
});

function sprite(row: number, col: number, w = 1, h = 1): TriageSprite {
  return { id: `${row},${col}:${w}x${h}`, row, col, w, h, x: 3000 + col * 70, y: 1300 + row * 70, cx: 0, cy: 0 };
}

describe("mergeAdjacentDuplicates", () => {
  it("merges touching regions with the same fingerprint, keeps separated twins", () => {
    const text = identifiedGearText("Blight Shell");
    const merged = mergeAdjacentDuplicates([
      { sprite: sprite(1, 2, 1, 3), text },
      { sprite: sprite(1, 3, 1, 3), text },
      { sprite: sprite(1, 8, 1, 3), text },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((read) => read.sprite.col)).toEqual([2, 8]);
  });

  it("never merges different items even when adjacent", () => {
    const merged = mergeAdjacentDuplicates([
      { sprite: sprite(1, 2), text: identifiedGearText("Blight Shell") },
      { sprite: sprite(1, 3), text: identifiedGearText("Corpse Ward") },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe("confirmedCompactionItems", () => {
  it("drops phantom regions, applies catalog sizes, and clamps origins in-grid", () => {
    const confirmed = confirmedCompactionItems(
      [
        // Real body armour detected as a 2x2 region: catalog corrects to 2x3.
        { sprite: sprite(0, 2, 2, 2), text: identifiedGearText("Blight Shell") },
        // Phantom region (decorative cell art): copied empty, must vanish.
        { sprite: sprite(2, 6, 1, 1), text: "" },
        // Detected at the bottom edge; catalog 2x3 must clamp the origin up.
        { sprite: sprite(4, 8, 2, 1), text: identifiedGearText("Corpse Ward") },
      ],
      { cols: 12, rows: 5 },
    );
    expect(confirmed).toHaveLength(2);
    const shell = confirmed.find((entry) => entry.fingerprint && entry.item.col === 2);
    expect(shell?.item).toMatchObject({ w: 2, h: 3, row: 0 });
    const ward = confirmed.find((entry) => entry.item.col === 8);
    expect(ward?.item).toMatchObject({ w: 2, h: 3, row: 2 });
    // The pick point stays the clipboard-confirmed rep cell.
    expect(shell?.pick).toEqual({ x: sprite(0, 2).x, y: sprite(0, 2).y });
  });
});

describe("planLeftCompaction", () => {
  const item = (id: string, row: number, col: number, w: number, h: number): CompactionItem => ({
    id,
    row,
    col,
    w,
    h,
  });

  it("packs items into the leftmost columns without overlapping the reserved scroll cell", () => {
    const moves = planLeftCompaction(
      [item("body", 0, 4, 2, 3), item("helm", 3, 6, 2, 2), item("ring", 2, 10, 1, 1)],
      { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] },
    );
    const byId = new Map(moves.map((move) => [move.id, move]));
    // The 2x3 tucks under the scroll; the 2x2 takes the top of cols 2-3;
    // the ring fills the free cell below the body.
    expect(byId.get("body")?.to).toEqual({ row: 1, col: 0 });
    expect(byId.get("helm")?.to).toEqual({ row: 0, col: 2 });
    expect(byId.get("ring")?.to).toEqual({ row: 4, col: 0 });
  });

  it("emits no move for an item already as far left as it can sit", () => {
    const moves = planLeftCompaction([item("ring", 1, 0, 1, 1)], {
      cols: 12,
      rows: 5,
      reserved: [{ row: 0, col: 0 }],
    });
    expect(moves).toHaveLength(0);
  });

  it("keeps intermediate states legal: a later move may use space an earlier move vacated", () => {
    // Two 2x2s: the left one moves up first (big-first order ties break by
    // column), freeing nothing the second needs — targets never overlap.
    const moves = planLeftCompaction(
      [item("a", 3, 1, 2, 2), item("b", 3, 4, 2, 2)],
      { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] },
    );
    const occupied = new Set<string>(["0,0"]);
    for (const move of moves) {
      for (let r = 0; r < move.h; r += 1) {
        for (let c = 0; c < move.w; c += 1) {
          const key = `${move.to.row + r},${move.to.col + c}`;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
        }
      }
    }
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe("runDropPass", () => {
  const ground = { x: 1690, y: 1296 };

  function identifiedCells(game: ReturnType<typeof fakeGame>, cells: Array<[number, number]>) {
    return cells.map(([row, col]) => ({
      cell: {
        row,
        col,
        x: 2900 + col * 70,
        y: 1300 + row * 70,
        itemClass: "Body Armours",
        rarity: "Rare",
        fingerprint: "unused-pre-identify",
      },
      text: game.cellText(row, col),
    }));
  }

  it("drops not-good items with pickup, ground click, and put-back probe — and keeps good ones", async () => {
    const game = fakeGame(
      { "1,2": identifiedGearText("Blight Shell"), "2,4": identifiedGearText("Corpse Ward") },
      { scrolls: 0 },
    );
    const result = await runDropPass({
      identified: identifiedCells(game, [
        [1, 2],
        [2, 4],
      ]),
      groundPoint: ground,
      evaluate: (text) => (text.includes("Blight Shell") ? verdict("unknown", "default") : verdict("keep")),
      ops: game.ops,
    });
    expect(result.aborted).toBeUndefined();
    expect(result.dropped).toEqual([expect.objectContaining({ itemName: "Blight Shell" })]);
    expect(result.kept).toEqual([expect.objectContaining({ itemName: "Corpse Ward" })]);
    expect(game.cellText(1, 2)).toBe("");
    expect(game.cellText(2, 4)).toContain("Corpse Ward");
    const lefts = game.clicks.filter((entry) => entry.startsWith("left:"));
    // pickup at the cell, drop at the ground, probe back at the cell.
    expect(lefts[0]).toContain("left:1,2");
    expect(lefts[1]).toContain("left:ground");
    expect(lefts[2]).toContain("left:1,2:probe");
  });

  it("skips a cell whose current item no longer matches what was evaluated", async () => {
    const game = fakeGame({ "1,2": identifiedGearText("Blight Shell") }, { scrolls: 0 });
    const result = await runDropPass({
      identified: [
        {
          cell: { row: 1, col: 2, x: 3040, y: 1370, itemClass: "Body Armours", rarity: "Rare", fingerprint: "x" },
          text: identifiedGearText("Some Other Item"),
        },
      ],
      groundPoint: ground,
      evaluate: () => verdict("dump"),
      ops: game.ops,
    });
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "cell-changed" })]);
    expect(game.cellText(1, 2)).toContain("Blight Shell");
  });

  it("detects a refused ground drop via the probe and aborts with the bag intact", async () => {
    const game = fakeGame(
      { "1,2": identifiedGearText("Blight Shell") },
      { scrolls: 0, dropsAllowed: false },
    );
    const result = await runDropPass({
      identified: identifiedCells(game, [[1, 2]]),
      groundPoint: ground,
      evaluate: () => verdict("dump"),
      ops: game.ops,
    });
    expect(result.aborted).toContain("drop-refused");
    expect(result.dropped).toHaveLength(0);
    expect(game.cursor).toBe("");
    expect(game.cellText(1, 2)).toContain("Blight Shell");
  });

  it("honours the maxDrops cap", async () => {
    const game = fakeGame(
      { "1,2": identifiedGearText("Blight Shell"), "2,4": identifiedGearText("Corpse Ward") },
      { scrolls: 0 },
    );
    const result = await runDropPass({
      identified: identifiedCells(game, [
        [1, 2],
        [2, 4],
      ]),
      groundPoint: ground,
      evaluate: () => verdict("dump"),
      ops: game.ops,
      maxDrops: 1,
    });
    expect(result.dropped).toHaveLength(1);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "max-drops-reached" })]);
  });
});
