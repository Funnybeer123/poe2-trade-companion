import { describe, expect, it } from "vitest";
import {
  classifyBagRead,
  confirmedCompactionItems,
  decideDrop,
  isGearClass,
  mergeAdjacentDuplicates,
  planLeftCompaction,
  planMapTriage,
  resolveBagFootprints,
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

const vaultKeyText = "Item Class: Vault Keys\nRarity: Currency\nTwilight Reliquary Key\n--------\nCan only be used once.";

function read(row: number, col: number, text: string): BagCellRead {
  return { row, col, x: 2900 + col * 70, y: 1300 + row * 70, text };
}

function bagSweep(items: Array<{ row: number; col: number; w: number; h: number; text: string }>): BagCellRead[] {
  return Array.from({ length: 60 }, (_, index) => {
    const row = Math.floor(index / 12);
    const col = index % 12;
    const item = items.find((entry) => row >= entry.row && row < entry.row + entry.h &&
      col >= entry.col && col < entry.col + entry.w);
    return read(row, col, item?.text ?? "");
  });
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
    expect(classifyBagRead(vaultKeyText).kind).toBe("other");
    expect(classifyBagRead(`${vaultKeyText}\n--------\nUnidentified`).kind).toBe("other");
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
    expect(isGearClass("Vault Keys")).toBe(false);
    expect(isGearClass("Made Up Class")).toBe(false);
  });
});

describe("planMapTriage", () => {
  it("counts full item footprints once while preserving adjacent identical items", () => {
    const text = unidGearText();
    const plan = planMapTriage(bagSweep([
      { row: 0, col: 0, w: 1, h: 1, text: scrollText(2) },
      { row: 0, col: 2, w: 2, h: 3, text },
      { row: 0, col: 4, w: 2, h: 3, text },
    ]));
    expect(plan.unidGear.map((entry) => [entry.row, entry.col])).toEqual([[0, 2], [0, 4]]);
    expect(plan.budget).toBe(2);
    expect(plan.issues).toEqual([]);
  });

  it("keeps sparse identical anchors when their full footprints have not been copied", () => {
    const plan = planMapTriage([
      read(0, 0, scrollText(2)), read(1, 2, unidGearText()), read(1, 3, unidGearText()),
    ]);
    expect(plan.unidGear).toHaveLength(2);
    expect(plan.budget).toBe(2);
  });

  it("uses measured sizes to count identical narrower items separately", () => {
    const text = unidGearText("Measured Sceptre").replace("Body Armours", "Sceptres");
    const plan = planMapTriage(bagSweep([
      { row: 0, col: 0, w: 1, h: 1, text: scrollText(2) },
      { row: 0, col: 2, w: 1, h: 3, text },
      { row: 0, col: 3, w: 1, h: 3, text },
    ]), () => ({ w: 1, h: 3 }));
    expect(plan.unidGear.map((entry) => [entry.row, entry.col])).toEqual([[0, 2], [0, 3]]);
    expect(plan.budget).toBe(2);
  });

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
function fakeGame(
  cells: Record<string, string>,
  options: { scrolls: number; dropsAllowed?: boolean; identifyArmMs?: number },
) {
  const state = new Map(Object.entries(cells));
  const key = (cell: { row: number; col: number }) => `${cell.row},${cell.col}`;
  let scrolls = options.scrolls;
  let armed = false;
  let now = 0;
  let armReadyAt = 0;
  let cursor = "";
  const clicks: string[] = [];
  const identifyAt = new Map<string, string>();

  const ops: MapTriageOps = {
    copyCell: async (cell: MapTriageCell) => state.get(key(cell)) ?? "",
    rightClick: async (point, why) => {
      clicks.push(`right:${key(point)}:${why}`);
      if (scrolls > 0) {
        armed = true;
        armReadyAt = now + (options.identifyArmMs ?? 0);
      }
    },
    leftClick: async (point, why) => {
      const at = "row" in point && "col" in point ? key(point as MapTriageCell) : "ground";
      clicks.push(`left:${at}:${why}`);
      if (at === "ground") {
        if (cursor && options.dropsAllowed !== false) cursor = "";
        return;
      }
      const held = state.get(at) ?? "";
      if (armed && now >= armReadyAt) {
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
    sleep: async (ms) => { now += ms; },
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
  it("waits for the live-proven 320ms arm delay before clicking gear", async () => {
    const plan = planMapTriage([read(0, 0, scrollText(5)), read(1, 2, unidGearText())]);
    const game = fakeGame({ "0,0": scrollText(5), "1,2": unidGearText() }, {
      scrolls: 5, identifyArmMs: 320,
    });
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.aborted).toBeUndefined();
    expect(result.scrollsUsed).toBe(1);
    expect(game.cursor).toBe("");
    expect(game.clicks.filter((entry) => entry.startsWith("left:"))).toHaveLength(1);
  });

  it("does not identify a different unidentified item substituted after planning", async () => {
    const plan = planMapTriage([read(0, 0, scrollText(5)), read(1, 2, unidGearText("Coat A"))]);
    const game = fakeGame({ "0,0": scrollText(5), "1,2": unidGearText("Coat B") }, { scrolls: 5 });
    const result = await runIdentifyPass({ plan, ops: game.ops });
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "cell-changed" })]);
    expect(game.clicks).toEqual([]);
  });

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
    expect(result.scrollsUsed).toBe(0);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "identify-misfire-recovered" })]);
    expect(game.cursor).toBe("");
    expect(game.cellText(1, 2)).toContain("Unidentified");
    expect(game.clicks).toHaveLength(3);
    expect(game.clicks[2]).toContain("return item to r1c2");
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
    expect(decideDrop(verdict("dump", "safety")).drop).toBe(false);
  });
});

function sprite(row: number, col: number, w = 1, h = 1): TriageSprite {
  return { id: `${row},${col}:${w}x${h}`, row, col, w, h, x: 3000 + col * 70, y: 1300 + row * 70, cx: 0, cy: 0 };
}

describe("mergeAdjacentDuplicates", () => {
  it("merges reads within an item's catalog footprint, keeps separated twins", () => {
    const text = identifiedGearText("Blight Shell");
    const merged = mergeAdjacentDuplicates([
      { sprite: sprite(1, 2, 1, 3), text },
      { sprite: sprite(1, 3, 1, 3), text },
      { sprite: sprite(1, 8, 1, 3), text },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((read) => read.sprite.col)).toEqual([2, 8]);
  });

  it("preserves adjacent identical complete items at their actual size boundary", () => {
    const text = identifiedGearText("Blight Shell");
    expect(mergeAdjacentDuplicates([
      { sprite: sprite(1, 2, 2, 3), text },
      { sprite: sprite(1, 4, 2, 3), text },
    ])).toHaveLength(2);
    const ring = ["Item Class: Rings", "Rarity: Normal", "Gold Ring", "--------", "Item Level: 80"].join("\n");
    expect(mergeAdjacentDuplicates([
      { sprite: sprite(0, 1), text: ring }, { sprite: sprite(0, 2), text: ring },
    ])).toHaveLength(2);
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
  it("preserves exact confirmed origin and dimensions, excluding empty phantom reads", () => {
    const confirmed = confirmedCompactionItems(
      [
        {
          sprite: sprite(0, 2, 2, 2), text: identifiedGearText("Blight Shell"),
          footprint: { row: 0, col: 2, w: 2, h: 3 },
        },
        { sprite: sprite(2, 6, 1, 1), text: "" },
      ],
      { cols: 12, rows: 5 },
    );
    expect(confirmed).toHaveLength(1);
    const shell = confirmed.find((entry) => entry.fingerprint && entry.item.col === 2);
    expect(shell?.item).toMatchObject({ w: 2, h: 3, row: 0 });
    expect(shell?.pick).toEqual({ x: sprite(0, 2).x, y: sprite(0, 2).y });
  });

  it("rejects guessed, out-of-bounds, overlapping, and unreadable footprints", () => {
    const text = identifiedGearText();
    const grid = { cols: 12, rows: 5 };
    expect(() => confirmedCompactionItems([{ sprite: sprite(4, 8), text }], grid))
      .toThrow("unverified-footprint");
    expect(() => confirmedCompactionItems([
      { sprite: sprite(4, 8), text, footprint: { row: 4, col: 8, w: 2, h: 3 } },
    ], grid)).toThrow("invalid-footprint");
    expect(() => confirmedCompactionItems([
      { sprite: sprite(0, 2), text, footprint: { row: 0, col: 2, w: 2, h: 3 } },
      { sprite: sprite(0, 3), text, footprint: { row: 0, col: 3, w: 2, h: 3 } },
    ], grid)).toThrow("overlapping-footprints");
    expect(() => confirmedCompactionItems([{ sprite: sprite(0, 2), text: "bad clipboard" }], grid))
      .toThrow("unreadable-item");
  });
});

describe("resolveBagFootprints", () => {
  const grid = { cols: 12, rows: 5 };
  // Sanitized live baseline: the six anchors were three multi-cell items.
  const crossbow = identifiedGearText("Baseline Crossbow").replace("Body Armours", "Crossbows");
  const armour = identifiedGearText("Baseline Armour");
  const sceptre = unidGearText("Baseline Sceptre").replace("Body Armours", "Sceptres");
  const baseline = [
    { row: 0, col: 0, w: 1, h: 1, text: scrollText(31) },
    { row: 0, col: 7, w: 2, h: 4, text: crossbow },
    { row: 1, col: 9, w: 2, h: 3, text: armour },
    { row: 2, col: 5, w: 2, h: 3, text: sceptre },
  ];

  it("resolves the baseline duplicate anchors into three correctly sized gear items", () => {
    const anchors = [[0, 7, crossbow], [3, 7, crossbow], [1, 9, armour], [3, 9, armour],
      [2, 5, sceptre], [4, 5, sceptre]] as const;
    expect(mergeAdjacentDuplicates(anchors.map(([row, col, text]) => ({ sprite: sprite(row, col), text }))))
      .toHaveLength(3);
    const result = resolveBagFootprints(bagSweep(baseline), grid);
    expect(result.issues).toEqual([]);
    expect(result.items.map((entry) => entry.item)).toEqual([
      { id: "r0c0", row: 0, col: 0, w: 1, h: 1, fixed: true },
      { id: "r2c5", row: 2, col: 5, w: 2, h: 3 },
      { id: "r0c7", row: 0, col: 7, w: 2, h: 4 },
      { id: "r1c9", row: 1, col: 9, w: 2, h: 3 },
    ]);
    expect(result.reads).toHaveLength(4);
  });

  it("tiles adjacent identical items separately instead of deduplicating fingerprints", () => {
    const result = resolveBagFootprints(bagSweep([
      { row: 0, col: 2, w: 2, h: 3, text: armour },
      { row: 0, col: 4, w: 2, h: 3, text: armour },
    ]), grid);
    expect(result.issues).toEqual([]);
    expect(result.items.map((entry) => entry.item.col)).toEqual([2, 4]);
  });

  it("prefers a measured base size and verifies its entire rectangle", () => {
    const sweep = bagSweep([{ row: 2, col: 5, w: 1, h: 3, text: sceptre }]);
    const result = resolveBagFootprints(sweep, grid, () => ({ w: 1, h: 3 }));
    expect(result.issues).toEqual([]);
    expect(result.items[0]?.item).toMatchObject({ row: 2, col: 5, w: 1, h: 3 });
    expect(resolveBagFootprints(sweep, grid).items).toEqual([]);
  });

  it("resolves the live right-edge spear and vault key and refuses an obsolete two-column spear size", () => {
    const spear = unidGearText("Soaring Spear").replace("Body Armours", "Spears");
    const sweep = bagSweep([
      { row: 0, col: 0, w: 1, h: 1, text: scrollText(27) },
      { row: 0, col: 11, w: 1, h: 4, text: spear },
      { row: 4, col: 4, w: 1, h: 1, text: vaultKeyText },
    ]);
    const result = resolveBagFootprints(sweep, grid);
    expect(result.issues).toEqual([]);
    expect(result.items.map((entry) => entry.item)).toEqual(expect.arrayContaining([
      { id: "r0c11", row: 0, col: 11, w: 1, h: 4 },
      { id: "r4c4", row: 4, col: 4, w: 1, h: 1 },
    ]));
    expect(result.items).toHaveLength(3);
    const plan = planMapTriage(sweep);
    expect(plan.unidGear.map((cell) => [cell.row, cell.col])).toEqual([[0, 11]]);
    expect(plan.budget).toBe(1);
    const bad = resolveBagFootprints(sweep, grid, (item) =>
      item.itemClass === "Spears" ? { w: 2, h: 4 } : undefined);
    expect(bad.items).toEqual([]);
    expect(bad.issues).toContain("invalid-footprint:r0c11:2x4");
  });

  it("rejects the whole movement model for missing, duplicate, unreadable, or conflicting cells", () => {
    const original = bagSweep(baseline);
    const badSweeps = [
      original.slice(1),
      [...original, original[0]!],
      original.map((cell) => cell.row === 0 && cell.col === 1 ? { ...cell, text: "clipboard garbage" } : cell),
      original.map((cell) => cell.row === 3 && cell.col === 7 ? { ...cell, text: "" } : cell),
    ];
    for (const sweep of badSweeps) {
      const result = resolveBagFootprints(sweep, grid);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.items).toEqual([]);
    }
  });

  it("requires known dimensions when adjacent unknown items could have identical text", () => {
    const text = armour.replace("Body Armours", "Uncatalogued Class");
    const result = resolveBagFootprints(bagSweep([{ row: 0, col: 2, w: 2, h: 2, text }]), grid);
    expect(result.issues[0]).toContain("unknown-item-size");
    expect(result.items).toEqual([]);
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

  // Sanitized geometry of the 59-occupied-cell live snapshot: four large
  // items and one hole, with all other cells occupied by one-cell items.
  function nearlyFullBag(): CompactionItem[] {
    const large = [item("boots", 0, 7, 2, 2), item("bow", 0, 9, 2, 4),
      item("belt-a", 2, 5, 2, 1), item("belt-b", 4, 2, 2, 1)];
    const result = [...large];
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        if ((row === 3 && col === 2) || large.some((entry) =>
          row >= entry.row && row < entry.row + entry.h && col >= entry.col && col < entry.col + entry.w)) {
          continue;
        }
        result.push(item(`r${row}c${col}`, row, col, 1, 1));
      }
    }
    return result;
  }

  it("fills the single hole in the 59-cell baseline with one direct move", () => {
    const items = nearlyFullBag();
    expect(items.reduce((total, entry) => total + entry.w * entry.h, 0)).toBe(59);
    expect(planLeftCompaction(items, { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] })).toEqual([
      { id: "r4c11", from: { row: 4, col: 11 }, to: { row: 3, col: 2 }, w: 1, h: 1 },
    ]);
  });

  it("emits no moves when the same mixed-size bag is completely full", () => {
    const items = [...nearlyFullBag(), item("filled-hole", 3, 2, 1, 1)];
    expect(planLeftCompaction(items, { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] })).toEqual([]);
  });

  it("keeps a fixed furthest item in place and fills the hole from the next movable item", () => {
    const items = nearlyFullBag().map((entry) => entry.id === "r4c11" ? { ...entry, fixed: true } : entry);
    expect(planLeftCompaction(items, { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] })).toEqual([
      { id: "r3c11", from: { row: 3, col: 11 }, to: { row: 3, col: 2 }, w: 1, h: 1 },
    ]);
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

  it("never moves the scroll or frees its reserved cell when it appears in the model", () => {
    const moves = planLeftCompaction([
      item("scroll", 0, 0, 1, 1), item("ring", 0, 3, 1, 1),
      { ...item("fixed", 1, 0, 1, 1), fixed: true },
    ], { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] });
    expect(moves).toEqual([
      { id: "ring", from: { row: 0, col: 3 }, to: { row: 2, col: 0 }, w: 1, h: 1 },
    ]);
  });

  it("rejects overlaps, duplicate identities, and out-of-bounds starting positions", () => {
    const grid = { cols: 12, rows: 5 };
    expect(() => planLeftCompaction([item("a", 0, 2, 2, 3), item("b", 0, 3, 2, 3)], grid))
      .toThrow("overlapping-footprints");
    expect(() => planLeftCompaction([item("a", 0, 2, 1, 1), item("a", 0, 3, 1, 1)], grid))
      .toThrow("duplicate-item-id");
    expect(() => planLeftCompaction([item("a", 4, 2, 2, 3)], grid)).toThrow("invalid-footprint");
  });

  it("keeps intermediate states legal: a later move may use space an earlier move vacated", () => {
    const items = [item("a", 3, 1, 2, 2), item("b", 3, 4, 2, 2),
      item("crossbow", 0, 7, 2, 4), item("armour", 1, 9, 2, 3)];
    const moves = planLeftCompaction(items, { cols: 12, rows: 5, reserved: [{ row: 0, col: 0 }] });
    const occupied = new Map<string, string>([["0,0", "scroll"]]);
    const occupy = (item: CompactionItem) => {
      for (let r = item.row; r < item.row + item.h; r += 1) {
        for (let c = item.col; c < item.col + item.w; c += 1) occupied.set(`${r},${c}`, item.id);
      }
    };
    for (const entry of items) occupy(entry);
    const movedIds = new Set<string>();
    for (const move of moves) {
      expect(movedIds.has(move.id)).toBe(false);
      movedIds.add(move.id);
      for (const [cell, id] of occupied) if (id === move.id) occupied.delete(cell);
      for (let r = 0; r < move.h; r += 1) {
        for (let c = 0; c < move.w; c += 1) {
          const key = `${move.to.row + r},${move.to.col + c}`;
          expect(occupied.has(key)).toBe(false);
          expect(move.to.row + r).toBeLessThan(5);
          expect(move.to.col + c).toBeLessThan(12);
          occupied.set(key, move.id);
        }
      }
    }
    expect(occupied.get("0,0")).toBe("scroll");
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.length).toBeLessThanOrEqual(items.length);
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

  it.each([unidGearText(), unidWaystoneText, vaultKeyText, scrollText(5), "garbage"])(
    "never picks up non-identified gear even if an evaluator would dump it", async (text) => {
      const game = fakeGame({ "1,2": text }, { scrolls: 0 });
      const result = await runDropPass({
        identified: identifiedCells(game, [[1, 2]]),
        groundPoint: ground,
        evaluate: () => { throw new Error("must not evaluate unsafe input"); },
        ops: game.ops,
      });
      expect(result.dropped).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("not-identified-gear:");
      expect(game.clicks).toEqual([]);
    },
  );

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
