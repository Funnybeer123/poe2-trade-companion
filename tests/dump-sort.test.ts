import { describe, expect, it } from "vitest";
import { createGray, fillRect } from "../src/core/grayImage.js";
import { regionChangedFraction } from "../src/core/itemSprites.js";
import {
  CLICK_SURFACES,
  bagCompletionVerdict,
  classifyListRead,
  clickRefusal,
  decideListToggle,
  describeBagLeftovers,
  packTripByDest,
  phantomSignatureMatches,
  withdrawObservation,
  type GridCell,
} from "../src/core/gearSort.js";

/**
 * Pure decisions behind docs/HANDOFF-dump-sort.md: dropdown visibility with
 * one-click-verified toggles, click-surface refusal, the withdraw
 * postcondition, and the empty-bag completion/report.
 */

describe("dropdown visibility decision", () => {
  it("classifies a folder read as open-folder", () => {
    expect(classifyListRead(18, "folder")).toBe("folder");
    expect(classifyListRead(4, "folder")).toBe("folder");
  });

  it("classifies a scrolled window showing top rows separately from folder rows", () => {
    expect(classifyListRead(12, "top-level")).toBe("top-level");
    expect(classifyListRead(9, "ambiguous")).toBe("ambiguous-open");
  });

  it("reads zero rows as closed and a stray row or two as an unreadable frame", () => {
    expect(classifyListRead(0, "ambiguous")).toBe("closed");
    expect(classifyListRead(2, "ambiguous")).toBe("unreadable");
    // Even a "folder" context on 3 rows is a garbled transition frame — a
    // real open list never has that few rows.
    expect(classifyListRead(3, "folder")).toBe("unreadable");
  });

  it("never clicks when the observed state is already the wanted one", () => {
    expect(decideListToggle("folder", "folder")).toBe("none");
    expect(decideListToggle("top-level", "top-level")).toBe("none");
    expect(decideListToggle("closed", "closed")).toBe("none");
  });

  it("re-reads unreadable frames instead of toggling blind", () => {
    expect(decideListToggle("unreadable", "folder")).toBe("reread");
    expect(decideListToggle("unreadable", "closed")).toBe("reread");
  });

  it("toggles exactly when the state must change (scroll resets included)", () => {
    expect(decideListToggle("closed", "folder")).toBe("toggle"); // open it
    expect(decideListToggle("folder", "closed")).toBe("toggle"); // close it
    // A scrolled/ambiguous window while wanting the folder: close to reset
    // the scroll (the reopen is the NEXT verified decision, never the same
    // blind iteration).
    expect(decideListToggle("top-level", "folder")).toBe("toggle");
    expect(decideListToggle("ambiguous-open", "folder")).toBe("toggle");
  });
});

describe("click-surface refusal", () => {
  it("allows the strip scroll arrow and header clicks on their own band", () => {
    expect(clickRefusal({ x: 52, y: 212 }, CLICK_SURFACES.stripTop)).toBeUndefined();
    expect(clickRefusal({ x: 1217, y: 210 }, CLICK_SURFACES.stripTop)).toBeUndefined();
    expect(clickRefusal({ x: 660, y: 277 }, CLICK_SURFACES.stripFolder)).toBeUndefined();
  });

  it("allows the folder chevron and row clicks inside the dropdown surface", () => {
    expect(clickRefusal({ x: 1287, y: 278 }, CLICK_SURFACES.tabList)).toBeUndefined();
    expect(clickRefusal({ x: 1430, y: 900 }, CLICK_SURFACES.tabList)).toBeUndefined();
  });

  it("refuses a strip-band coordinate sent against the wrong surface", () => {
    // The top-left click-spray incident: an arrow click while the stash was
    // closed. The same point against the grid surface must refuse.
    expect(clickRefusal({ x: 52, y: 212 }, CLICK_SURFACES.stash)).toMatch(/outside its surface/);
  });

  it("refuses a drifted row Y past the dropdown's bottom edge", () => {
    expect(clickRefusal({ x: 1430, y: 1900 }, CLICK_SURFACES.tabList)).toMatch(
      /outside its surface/,
    );
  });

  it("refuses clicks outside the game's client rect before any surface test", () => {
    const client = { left: 0, top: 0, width: 3840, height: 2160 };
    expect(clickRefusal({ x: 5000, y: 900 }, CLICK_SURFACES.tabList, client)).toBe(
      "outside the game's client rect",
    );
    expect(clickRefusal({ x: -4, y: 212 }, CLICK_SURFACES.stripTop, client)).toBe(
      "outside the game's client rect",
    );
    expect(clickRefusal({ x: 1430, y: 900 }, CLICK_SURFACES.tabList, client)).toBeUndefined();
  });
});

describe("race-free switch observation (before/after frames)", () => {
  const client = { left: 0, top: 0, width: 400, height: 300 };
  const region = { x: 40, y: 50, w: 300, h: 200 };

  it("reads identical frames as unchanged", () => {
    const a = createGray(400, 300, 30);
    const b = createGray(400, 300, 30);
    expect(regionChangedFraction(a, b, client, region)).toBe(0);
  });

  it("sees a moved header highlight even when pixwait's late baseline missed it", () => {
    const before = createGray(400, 300, 30);
    const after = createGray(400, 300, 30);
    fillRect(before, 60, 60, 80, 30, 120); // highlight on tab A
    fillRect(after, 200, 60, 80, 30, 120); // highlight moved to tab B
    expect(regionChangedFraction(before, after, client, region)).toBeGreaterThan(0.005);
  });

  it("ignores sub-threshold shimmer", () => {
    const before = createGray(400, 300, 30);
    const after = createGray(400, 300, 38); // uniform +8 < minDelta 15
    expect(regionChangedFraction(before, after, client, region)).toBe(0);
  });

  it("treats mismatched frame sizes as fully changed, never quiet", () => {
    const a = createGray(400, 300, 30);
    const b = createGray(200, 150, 30);
    expect(regionChangedFraction(a, b, client, region)).toBe(1);
  });

  it("only samples inside the probe region", () => {
    const before = createGray(400, 300, 30);
    const after = createGray(400, 300, 30);
    fillRect(after, 0, 0, 35, 300, 200); // change entirely left of the region
    expect(regionChangedFraction(before, after, client, region)).toBe(0);
  });
});

describe("destination-packed trips (placement-simulated)", () => {
  let stamp = 0;
  /** An item with a real w×h rectangular footprint (stash coords arbitrary). */
  const item = (dest: string, w = 1, h = 1) => {
    stamp += 1;
    const cells = [] as Array<{ row: number; col: number; x: number; y: number }>;
    for (let r = 0; r < h; r += 1) {
      for (let c = 0; c < w; c += 1) {
        cells.push({ row: stamp * 10 + r, col: c, x: 100, y: 400 });
      }
    }
    return { dest, itemClass: dest, text: `Item Class: ${dest} #${stamp}`, cells };
  };
  const cellsOf = (batch: ReadonlyArray<{ cells: unknown[] }>) =>
    batch.reduce((sum, b) => sum + b.cells.length, 0);

  it("fills the bag with the largest destination group first", () => {
    const rings = Array.from({ length: 10 }, () => item("Rings"));
    const boots = Array.from({ length: 3 }, () => item("Boots", 2, 2));
    const batch = packTripByDest([...boots, ...rings], []);
    // Boots (12 cells) outranks Rings (10 cells) — Boots leads.
    expect(batch[0]!.dest).toBe("Boots");
    expect(batch).toHaveLength(13); // everything places in an empty 12x5 bag
  });

  it("caps by PLACEMENT, not cell count — the fifteen-helmets incident", () => {
    const helmets = Array.from({ length: 15 }, () => item("Helmets", 2, 2));
    const batch = packTripByDest(helmets, []);
    // 57 free cells would take 14 by cell count, but a 12x5 grid places
    // only twelve 2x2 items (the bottom strip is one row tall). The game
    // refused the extras live — the packer must never plan them.
    expect(batch).toHaveLength(12);
  });

  it("backfills big-item leftovers with a whole smaller group (armour + rings)", () => {
    const armour = Array.from({ length: 9 }, () => item("Body Armor", 2, 3));
    const rings = Array.from({ length: 5 }, () => item("Rings"));
    const batch = packTripByDest([...rings, ...armour], []);
    // Six 2x3 armours fill rows 0-2; the other three cannot place (rows 3-4
    // are two tall). All five rings place in the leftover rows and clear
    // their destination entirely — a free replaced visit.
    expect(batch.filter((b) => b.dest === "Body Armor")).toHaveLength(6);
    expect(batch.filter((b) => b.dest === "Rings")).toHaveLength(5);
  });

  it("after an overflow, refuses a new destination whose group cannot FULLY place", () => {
    const armour = Array.from({ length: 9 }, () => item("Body Armor", 2, 3)); // 6 place
    const rings = Array.from({ length: 30 }, () => item("Rings")); // 24 free cells < 30
    const batch = packTripByDest([...rings, ...armour], []);
    // Rings would have to split across trips AND add a hop — skipped whole.
    expect(new Set(batch.map((b) => b.dest))).toEqual(new Set(["Body Armor"]));
    expect(batch).toHaveLength(6);
  });

  it("lets an oversized group straddle trips at full bag capacity", () => {
    const rings = Array.from({ length: 70 }, () => item("Rings"));
    const batch = packTripByDest(rings, []);
    expect(batch).toHaveLength(60); // every cell of the 12x5 bag
    expect(batch.every((b) => b.dest === "Rings")).toBe(true);
  });

  it("respects cells the bag already holds", () => {
    const occupied: Array<{ row: number; col: number }> = [];
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 12; c += 1) {
        if (r > 0 || c > 1) occupied.push({ row: r, col: c }); // only (0,0),(0,1) free
      }
    }
    const batch = packTripByDest([item("Gloves", 2, 2), item("Belts", 2, 1)], occupied);
    // The 2x2 gloves cannot place in a 2x1 hole; the 2x1 belt group can —
    // and joins whole after the overflow.
    expect(batch.map((b) => b.dest)).toEqual(["Belts"]);
    expect(cellsOf(batch)).toBe(2);
  });

  it("returns nothing when the bag has no room at all", () => {
    const occupied: Array<{ row: number; col: number }> = [];
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 12; c += 1) occupied.push({ row: r, col: c });
    }
    expect(packTripByDest([item("Rings")], occupied)).toHaveLength(0);
  });
});

describe("persistent phantom-cell signatures", () => {
  const stored = { mean: 62, variance: 140 };

  it("matches the unchanged glare cell that proved phantom", () => {
    expect(phantomSignatureMatches(stored, { mean: 60, variance: 150 })).toBe(true);
    expect(phantomSignatureMatches(stored, { mean: 70, variance: 120 })).toBe(true);
  });

  it("stops matching when a real item lands on the cell (skip must lift)", () => {
    expect(phantomSignatureMatches(stored, { mean: 110, variance: 900 })).toBe(false);
    expect(phantomSignatureMatches(stored, { mean: 62, variance: 600 })).toBe(false);
    expect(phantomSignatureMatches(stored, { mean: 20, variance: 140 })).toBe(false);
  });

  it("gives low-variance signatures an absolute band, not a zero one", () => {
    expect(phantomSignatureMatches({ mean: 40, variance: 10 }, { mean: 42, variance: 35 })).toBe(
      true,
    );
    expect(phantomSignatureMatches({ mean: 40, variance: 10 }, { mean: 42, variance: 80 })).toBe(
      false,
    );
  });
});

describe("withdraw postcondition", () => {
  it("accepts only bag growth", () => {
    expect(withdrawObservation(10, 14)).toBe("grew");
  });

  it("flags a flat bag (clicks landed on nothing)", () => {
    expect(withdrawObservation(10, 10)).toBe("flat");
  });

  it("flags a shrinking bag (clicks deposited instead)", () => {
    expect(withdrawObservation(10, 7)).toBe("shrank");
  });
});

describe("empty-bag completion", () => {
  const cell = (row: number, col: number): GridCell => ({
    row,
    col,
    x: 2500 + col * 70,
    y: 1200 + row * 70,
  });

  it("declares an empty bag done", () => {
    expect(bagCompletionVerdict([], new Set())).toBe("empty");
  });

  it("keeps filing while any depositable cell remains", () => {
    expect(bagCompletionVerdict([cell(0, 0), cell(0, 1)], new Set(["0,0"]))).toBe("keep-filing");
  });

  it("stops (and reports) when everything left is blacklisted", () => {
    expect(bagCompletionVerdict([cell(0, 0), cell(1, 2)], new Set(["0,0", "1,2"]))).toBe(
      "only-undepositable",
    );
  });
});

describe("bag leftover report", () => {
  const cell = (row: number, col: number): GridCell => ({
    row,
    col,
    x: 2500 + col * 70,
    y: 1200 + row * 70,
  });

  it("names each leftover with its class and the reason it could not leave", () => {
    const items = [
      { itemClass: "Rings", dest: "Rings", cells: [cell(0, 0)] },
      { itemClass: "Helmets", dest: "Helmets", cells: [cell(1, 0), cell(1, 1)] },
      { itemClass: "Life Flasks", dest: "junk", cells: [cell(2, 0)] },
      { itemClass: "Wands", dest: "Wands", cells: [cell(3, 0)] },
    ];
    const report = describeBagLeftovers(items, [cell(4, 4)], {
      undepositable: new Set(["0,0"]),
      stuckTabs: new Map([["0,0", new Set(["Rings", "Belts"])]]),
      unavailableDests: new Set(["Helmets"]),
    });
    expect(report).toHaveLength(5);
    expect(report[0]).toMatchObject({ cell: "0,0", itemClass: "Rings" });
    expect(report[0]!.why).toContain("bounced in Rings and Belts");
    expect(report[1]!.why).toContain('home tab "Helmets" is full or unreachable');
    expect(report[2]!.why).toContain("no junk tab");
    expect(report[3]!.why).toContain("check it by hand");
    expect(report[4]).toMatchObject({ cell: "4,4" });
    expect(report[4]!.why).toContain("never yielded item text");
  });

  it("reports a multi-cell item once, keyed by its grab cell", () => {
    const items = [
      { itemClass: "Body Armours", dest: "Body Armor", cells: [cell(0, 0), cell(0, 1), cell(1, 0)] },
    ];
    const report = describeBagLeftovers(items, [], { undepositable: new Set() });
    expect(report).toHaveLength(1);
    expect(report[0]!.cell).toBe("0,0");
  });
});
