import { describe, expect, it } from "vitest";
import {
  brightHeaderRuns,
  brightestCellPoint,
  cellEdgeContinuity,
} from "../src/core/itemSprites.js";
import { createGray, fillRect } from "../src/core/grayImage.js";
import {
  BAG_AREA,
  GEAR_TAB_NAMES,
  STASH_AREA,
  clampToArea,
  claimNeedsReverify,
  correctedPoint,
  canonicalTTabLabel,
  destForItemClass,
  detectGridDivisions,
  groupIdentifiedCells,
  guildDestForItem,
  parseItemClass,
  foreignItemsFor,
  minFootprintForClass,
  isTTabLabel,
  parseCorrections,
  stashRegionSane,
  summarizeCorrections,
} from "../src/core/gearSort.js";

describe("gear sort clamps", () => {
  it("rejects withdraw targets over the tab strip (y<340) and outside the stash panel", () => {
    const cells = [
      { x: 100, y: 300 }, // phantom lit cell over a tab header — switched tabs mid-burst once
      { x: 100, y: 400 },
      { x: 1400, y: 400 }, // right of the stash panel
      { x: 1310, y: 1760 },
    ];
    expect(clampToArea(cells, STASH_AREA)).toEqual([
      { x: 100, y: 400 },
      { x: 1310, y: 1760 },
    ]);
  });

  it("rejects deposit clicks outside the bag area", () => {
    const cells = [
      { x: 2500, y: 1200 },
      { x: 660, y: 1200 }, // stash side — a deposit click there would withdraw
      { x: 2500, y: 900 }, // above the bag grid
    ];
    expect(clampToArea(cells, BAG_AREA)).toEqual([{ x: 2500, y: 1200 }]);
  });

  it("treats an inventory-locked region as insane", () => {
    expect(stashRegionSane({ x: 60, w: 1200 })).toBe(true);
    expect(stashRegionSane({ x: 2450, w: 1200 })).toBe(false); // inventory grid
    expect(stashRegionSane({ x: 60, w: 400 })).toBe(false); // too narrow
    expect(stashRegionSane(undefined)).toBe(false);
  });
});

describe("T-tab label handling", () => {
  it("canonicalizes garbled T labels so live rows and synthetics dedupe", () => {
    expect(canonicalTTabLabel("O T13")).toBe("T13");
    expect(canonicalTTabLabel("TIO")).toBe("T10");
    expect(canonicalTTabLabel("Til")).toBe("T11");
    expect(canonicalTTabLabel("T15")).toBe("T15");
    expect(canonicalTTabLabel("Gear")).toBeUndefined();
    expect(canonicalTTabLabel("T15 (Remove-only)")).toBeUndefined();
  });

  it("recognises T* junk tabs through live OCR garble, never remove-only", () => {
    for (const label of ["T1", "T15", "O T13", "TIO", "Til", "t 4"]) {
      expect(isTTabLabel(label), label).toBe(true);
    }
    for (const label of ["Rit (Remove-only)", "T15 (Remove-only)", "Gear", "AFFINITIES", "~price 5 exalted", "T99"]) {
      expect(isTTabLabel(label), label).toBe(false);
    }
  });
});

describe("ground-truth item identification", () => {
  it("parses the Item Class line from a Ctrl+C copy", () => {
    expect(parseItemClass("Item Class: Body Armours\r\nRarity: Rare\r\nDoom Shell")).toBe(
      "Body Armours",
    );
    expect(parseItemClass("no class line here")).toBeUndefined();
  });

  it("maps item classes to their gear tabs, junking the rest", () => {
    expect(destForItemClass("Rings")).toBe("Rings");
    expect(destForItemClass("Body Armours")).toBe("Body Armor");
    expect(destForItemClass("Quivers")).toBe("OffHands");
    expect(destForItemClass("Foci")).toBe("OffHands");
    expect(destForItemClass("Charms")).toBe("Belts");
    expect(destForItemClass("Waystones")).toBe("junk");
    expect(destForItemClass("Skill Gems")).toBe("junk");
    expect(destForItemClass(undefined)).toBe("junk");
  });

  it("routes weapon classes to their dedicated standard tabs", () => {
    expect(destForItemClass("One Hand Maces")).toBe("1h Mace");
    expect(destForItemClass("Maces")).toBe("1h Mace");
    expect(destForItemClass("Two Hand Maces")).toBe("2h Mace");
    expect(destForItemClass("Quarterstaves")).toBe("QuarterStaff");
    expect(destForItemClass("Crossbows")).toBe("Bow/Crossbow");
    expect(destForItemClass("Spears")).toBe("Spears");
    expect(destForItemClass("Wands")).toBe("Wands");
    expect(destForItemClass("Sceptres")).toBe("Sceptres");
    expect(destForItemClass("Staves")).toBe("Staves");
    expect(destForItemClass("Shields")).toBe("Shields");
    expect(destForItemClass("Bucklers")).toBe("Shields");
    expect(destForItemClass("Bows")).toBe("Bow/Crossbow");
    // No dedicated tab — the Weapons quad keeps them.
    expect(destForItemClass("Flails")).toBe("Weapons");
    // Every dedicated destination is a real tab.
    const names = new Set<string>(GEAR_TAB_NAMES);
    for (const cls of ["Helmets", "One Hand Maces", "Quarterstaves", "Crossbows", "Shields"]) {
      expect(names.has(destForItemClass(cls) as string), cls).toBe(true);
    }
  });

  it("groups adjacent identical-text cells into one item, separates distant twins", () => {
    const armour = "Item Class: Body Armours\nRarity: Rare\nSame Armour";
    const reads = [
      { cell: { row: 0, col: 0, x: 58, y: 368 }, text: armour },
      { cell: { row: 0, col: 1, x: 114, y: 368 }, text: armour },
      { cell: { row: 1, col: 0, x: 58, y: 424 }, text: armour },
      // Identical text far away — a different physical item.
      { cell: { row: 8, col: 8, x: 506, y: 816 }, text: armour },
      { cell: { row: 3, col: 3, x: 226, y: 536 }, text: "Item Class: Rings\nGold Ring" },
    ];
    const items = groupIdentifiedCells(reads);
    expect(items).toHaveLength(3);
    expect(items[0]!.cells).toHaveLength(3);
    expect(items[0]!.dest).toBe("Body Armor");
    expect(items[2]!.dest).toBe("Rings");
  });
});

describe("grid size detection", () => {
  it("reads 24x24 when odd and even boundary lines are equally dark", () => {
    const dark = Array(46).fill(14);
    expect(detectGridDivisions(dark, dark).divisions).toBe(24);
  });

  it("reads 12x12 when odd positions differ clearly from the separator lines", () => {
    // Measured live on the 1h Mace standard tab: interiors darker than lines.
    const darkInteriors = detectGridDivisions(Array(46).fill(7), Array(44).fill(27));
    expect(darkInteriors.divisions).toBe(12);
    // The direction must not matter (bright item art can flip it).
    const brightInteriors = detectGridDivisions(Array(46).fill(48), Array(44).fill(13));
    expect(brightInteriors.divisions).toBe(12);
  });

  it("defaults to 24x24 on empty samples and near-ties", () => {
    expect(detectGridDivisions([], []).divisions).toBe(24);
    expect(detectGridDivisions(Array(46).fill(20), Array(44).fill(16)).divisions).toBe(24);
  });
});

describe("verified sprite-continuation claims", () => {
  const cell = (row: number, col: number) => ({ row, col, x: 100 + col * 56, y: 400 + row * 56 });
  const keys = (...cells: Array<{ row: number; col: number }>) =>
    new Set(cells.map((c) => `${c.row},${c.col}`));

  it("claims only the guaranteed minimum footprint per class", () => {
    expect(minFootprintForClass("Body Armours")).toEqual({ w: 2, h: 3 });
    expect(minFootprintForClass("Helmets")).toEqual({ w: 2, h: 2 });
    expect(minFootprintForClass("Quivers")).toEqual({ w: 1, h: 3 });
    expect(minFootprintForClass("Wands")).toEqual({ w: 1, h: 2 });
    expect(minFootprintForClass("Rings")).toEqual({ w: 1, h: 1 });
    expect(minFootprintForClass(undefined)).toEqual({ w: 1, h: 1 });
  });

  it("trusts an item with no claimed cells regardless of shape", () => {
    const item = { itemClass: "Rings", cells: [cell(0, 0), cell(0, 1)] };
    expect(claimNeedsReverify(item, new Set())).toBe(false);
  });

  it("trusts a claimed item whose bounding box exactly matches the class footprint", () => {
    const helmet = {
      itemClass: "Helmets",
      cells: [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)],
    };
    expect(claimNeedsReverify(helmet, keys(cell(0, 1), cell(1, 1)))).toBe(false);
  });

  it("re-verifies a 1x1 class that a claim grew (ring swallowed by its neighbour)", () => {
    const ring = { itemClass: "Rings", cells: [cell(0, 0), cell(0, 1)] };
    expect(claimNeedsReverify(ring, keys(cell(0, 1)))).toBe(true);
  });

  it("re-verifies a wand claim that widened past the 1x2 footprint", () => {
    const wand = {
      itemClass: "Wands",
      cells: [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)],
    };
    expect(claimNeedsReverify(wand, keys(cell(0, 1), cell(1, 1)))).toBe(true);
  });

  it("re-verifies a claimed item with holes (bbox right, cell count wrong)", () => {
    const helmet = {
      itemClass: "Helmets",
      cells: [cell(0, 0), cell(0, 1), cell(1, 1)],
    };
    expect(claimNeedsReverify(helmet, keys(cell(0, 1)))).toBe(true);
  });

  it("re-verifies unknown classes claimed past 1x1", () => {
    const unknown = { itemClass: undefined, cells: [cell(0, 0), cell(0, 1)] };
    expect(claimNeedsReverify(unknown, keys(cell(0, 1)))).toBe(true);
  });
});

describe("pixel edge continuity (skip proposals)", () => {
  const client = { left: 0, top: 0, width: 200, height: 100 };
  const region = { x: 0, y: 0, w: 200, h: 100 };

  it("sees one sprite flowing across the boundary", () => {
    const frame = createGray(200, 100, 10);
    // Horizontal stripes spanning both cells: identical, varied profiles.
    for (let y = 10; y < 90; y += 12) {
      fillRect(frame, 60, y, 100, 6, 150);
      fillRect(frame, 60, y + 6, 100, 6, 50);
    }
    expect(cellEdgeContinuity(frame, client, region, 2, 1, 0, 1)).toBe(true);
  });

  it("refuses when the right cell edge is dark (separate items leave a gutter)", () => {
    const frame = createGray(200, 100, 10);
    for (let y = 10; y < 90; y += 12) {
      fillRect(frame, 60, y, 35, 6, 150); // sprite ends before the boundary
    }
    expect(cellEdgeContinuity(frame, client, region, 2, 1, 0, 1)).toBe(false);
  });

  it("refuses flat empty cells on a colored background", () => {
    const frame = createGray(200, 100, 60); // bright but flat
    expect(cellEdgeContinuity(frame, client, region, 2, 1, 0, 1)).toBe(false);
  });

  it("refuses anti-correlated edges (two different sprites touching)", () => {
    const frame = createGray(200, 100, 10);
    for (let y = 10; y < 90; y += 24) {
      fillRect(frame, 60, y, 40, 12, 150); // left: bright then dark
      fillRect(frame, 100, y + 12, 40, 12, 150); // right: dark then bright
    }
    expect(cellEdgeContinuity(frame, client, region, 2, 1, 0, 1)).toBe(false);
  });

  it("never claims across the grid's left edge", () => {
    const frame = createGray(200, 100, 128);
    expect(cellEdgeContinuity(frame, client, region, 2, 1, 0, 0)).toBe(false);
  });
});

describe("bright header detection", () => {
  const client = { left: 0, top: 0, width: 1400, height: 300 };
  const band = { x: 40, y: 186, w: 1240, h: 53 };

  it("finds the one light-coloured header among brown headers (measured live values)", () => {
    const frame = createGray(1400, 300, 15); // background ≈15
    fillRect(frame, 320, 180, 140, 65, 105); // silver Dump header ≈98-113
    fillRect(frame, 500, 180, 110, 65, 70); // brown header ≈70
    fillRect(frame, 650, 180, 190, 65, 78); // brown header peak ≈78
    const runs = brightHeaderRuns(frame, client, band);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.x0).toBeGreaterThan(280);
    expect(runs[0]!.x1).toBeLessThan(500);
  });

  it("returns nothing when every header is dark", () => {
    const frame = createGray(1400, 300, 15);
    fillRect(frame, 500, 180, 110, 65, 70);
    fillRect(frame, 650, 180, 190, 65, 78);
    expect(brightHeaderRuns(frame, client, band)).toHaveLength(0);
  });

  it("reports two bright headers separately (elimination must refuse)", () => {
    const frame = createGray(1400, 300, 15);
    fillRect(frame, 320, 180, 140, 65, 110);
    fillRect(frame, 700, 180, 140, 65, 160); // an active tab elsewhere
    expect(brightHeaderRuns(frame, client, band)).toHaveLength(2);
  });
});

describe("informed offset probe", () => {
  const client = { left: 0, top: 0, width: 100, height: 100 };
  const region = { x: 0, y: 0, w: 100, h: 100 };

  it("aims at the brightest block in the cell", () => {
    const frame = createGray(100, 100, 10);
    fillRect(frame, 62, 62, 16, 16, 220); // small sprite off the cell centre
    const point = brightestCellPoint(frame, client, region, 1, 1, { row: 0, col: 0 });
    expect(point).toBeDefined();
    expect(Math.abs(point!.x - 70)).toBeLessThan(25);
    expect(Math.abs(point!.y - 70)).toBeLessThan(25);
  });

  it("returns nothing for a flat cell (no target to probe)", () => {
    const frame = createGray(100, 100, 40);
    expect(brightestCellPoint(frame, client, region, 1, 1, { row: 0, col: 0 })).toBeUndefined();
  });
});

describe("foreign selection per tab kind", () => {
  const item = (dest: string): Parameters<typeof foreignItemsFor>[0][number] => ({
    dest,
    itemClass: dest,
    text: `Item Class: ${dest}`,
    cells: [{ row: 0, col: 0, x: 100, y: 400 }],
  });

  it("in a gear tab, everything that is not the own class leaves (junk included)", () => {
    const items = [item("Rings"), item("junk"), item("Boots")];
    const leaving = foreignItemsFor(items, "Boots");
    expect(leaving.map((i) => i.dest).sort()).toEqual(["Rings", "junk"]);
  });

  it("in a top-level T tab, gear leaves and junk stays", () => {
    const items = [item("Rings"), item("junk"), item("Weapons")];
    const leaving = foreignItemsFor(items, undefined);
    expect(leaving.map((i) => i.dest).sort()).toEqual(["Rings", "Weapons"]);
  });

  it("skips items whose home tab is known full", () => {
    const items = [item("Rings"), item("Weapons")];
    const leaving = foreignItemsFor(items, undefined, new Set(["Weapons"]));
    expect(leaving.map((i) => i.dest)).toEqual(["Rings"]);
  });
});

describe("corrections", () => {
  const lines = [
    JSON.stringify({
      at: "2026-08-29T18:00:00Z",
      why: "focus search box",
      planned: { x: 1035, y: 1786 },
      corrected: { x: 1005, y: 1790 },
    }),
    JSON.stringify({
      at: "2026-08-29T18:01:00Z",
      why: "focus search box",
      planned: { x: 1035, y: 1786 },
      corrected: { x: 1015, y: 1782 },
    }),
    JSON.stringify({
      at: "2026-08-29T18:02:00Z",
      why: "open stash chest",
      planned: { x: 1790, y: 505 },
      box: { x: 1700, y: 500, w: 100, h: 60 },
    }),
    '{"truncated": tru', // killed mid-write — must not break parsing
  ].join("\n");

  it("parses records and skips a truncated trailing line", () => {
    expect(parseCorrections(lines)).toHaveLength(3);
  });

  it("derives the corrected point from a drawn box's centre", () => {
    const record = parseCorrections(lines)[2]!;
    expect(correctedPoint(record)).toEqual({ x: 1750, y: 530 });
  });

  it("groups by step with mean offsets, most-corrected first", () => {
    const summaries = summarizeCorrections(parseCorrections(lines));
    expect(summaries[0]!.why).toBe("focus search box");
    expect(summaries[0]!.count).toBe(2);
    expect(summaries[0]!.meanDx).toBe(-25);
    expect(summaries[0]!.meanDy).toBe(0);
    expect(summaries[1]!.lastBox).toEqual({ x: 1700, y: 500, w: 100, h: 60 });
  });
});

describe("guild taxonomy routing", () => {
  const item = (dest: string, itemClass?: string, text = "Item Class: x\r\nRarity: Rare\r\nThing") => ({
    dest,
    itemClass,
    text,
  });

  it("routes armour and weapon classes onto the numbered chains", () => {
    expect(guildDestForItem(item("Helmets", "Helmets"))).toBe("Armor 1");
    expect(guildDestForItem(item("Body Armor", "Body Armours"))).toBe("Armor 1");
    expect(guildDestForItem(item("2h Mace", "Two Hand Maces"))).toBe("Weapons 1");
    expect(guildDestForItem(item("Bow/Crossbow", "Crossbows"))).toBe("Weapons 1");
  });

  it("falls through a full chain member, then the Duffel Bag, then stays put", () => {
    expect(guildDestForItem(item("Helmets", "Helmets"), new Set(["Armor 1"]))).toBe("Armor 2");
    expect(guildDestForItem(item("Helmets", "Helmets"), new Set(["Armor 1", "Armor 2"]))).toBe(
      "Duffel Bag",
    );
    expect(
      guildDestForItem(item("Helmets", "Helmets"), new Set(["Armor 1", "Armor 2", "Duffel Bag"])),
    ).toBe("junk");
  });

  it("splits the personal Belts merge: belts to HEAVY BELTS, charms to the trinket tab", () => {
    expect(guildDestForItem(item("Belts", "Belts"))).toBe("HEAVY BELTS");
    expect(guildDestForItem(item("Belts", "Charms"))).toBe("Jewels/Amulets/Charms");
    expect(guildDestForItem(item("Amulets", "Amulets"))).toBe("Jewels/Amulets/Charms");
    expect(guildDestForItem(item("Jewels", "Jewels"))).toBe("Jewels/Amulets/Charms");
    expect(guildDestForItem(item("Rings", "Rings"))).toBe("Rings");
  });

  it("files uniques together by their own Rarity line, falling back to class when full", () => {
    const unique = item("Helmets", "Helmets", "Item Class: Helmets\r\nRarity: Unique\r\nCrown");
    expect(guildDestForItem(unique)).toBe("Uniques");
    expect(guildDestForItem(unique, new Set(["Uniques"]))).toBe("Armor 1");
  });

  it("routes non-gear by class and name onto the guild's own tabs", () => {
    expect(guildDestForItem(item("junk", "Stackable Currency", "Exalted Orb"))).toBe("Currency");
    expect(
      guildDestForItem(item("junk", "Stackable Currency", "Greater Essence of the Body")),
    ).toBe("Essence");
    expect(guildDestForItem(item("junk", "Stackable Currency", "Distilled Ire"))).toBe("Delirium");
    expect(guildDestForItem(item("junk", "Stackable Currency", "Breach Splinter"))).toBe("Materials");
    expect(guildDestForItem(item("junk", "Waystones"))).toBe("Joes Maps");
    expect(guildDestForItem(item("junk", "Tablet"))).toBe("Joes Maps");
    expect(guildDestForItem(item("junk", "Uncut Skill Gems"))).toBe("Gems");
    expect(guildDestForItem(item("junk", "Life Flasks"))).toBe("Flasks");
    expect(guildDestForItem(item("junk", "Socketable"))).toBe("Materials");
  });

  it("catches the unmapped in the Duffel Bag, and stays put only when unreadable or all-full", () => {
    expect(guildDestForItem(item("junk", "Mystery Class"))).toBe("Duffel Bag");
    expect(guildDestForItem(item("SomethingNew", "Mystery"))).toBe("Duffel Bag");
    expect(guildDestForItem(item("junk", undefined))).toBe("junk");
    expect(
      guildDestForItem(item("junk", "Waystones"), new Set(["Joes Maps", "Duffel Bag"])),
    ).toBe("junk");
    expect(guildDestForItem(item("junk", "Waystones"), new Set(["Joes Maps"]))).toBe("Duffel Bag");
  });
});
