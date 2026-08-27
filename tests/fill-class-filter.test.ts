import { describe, expect, it } from "vitest";
import type { StashItem } from "../src/core/bagPack.js";
import {
  isClassFilterReason,
  itemMatchesWantedClass,
  noMatchReason,
  normalizeItemClass,
  parseWantedClasses,
  readClassFlag,
  searchQueryForClass,
  searchQueriesForClasses,
  searchScenarioQuery,
} from "../src/core/itemClassFilter.js";
import { pickClassCopyTargets, searchFillPool, sizeFillPool } from "../src/core/fillIdentify.js";
import { isStashSearchClick, searchLooksFailed, stashSearchClick } from "../src/core/stashSearch.js";
import { emptySizeDatabase, withClassDefaults } from "../src/core/itemSizeStore.js";
import { FillBagFromStash } from "../src/core/skills.js";
import { perceiveUi, type UiFacts } from "../src/core/uiPerception.js";
import { emptyProfile, packNpcPatch, packPatch } from "../src/core/calibrationProfile.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function item(id: string, w: number, h: number, row: number, col: number, itemClass?: string): StashItem {
  const cells: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) cells.push({ row: row + r, col: col + c });
  }
  return {
    id,
    w,
    h,
    itemClass,
    grab: { row, col, x: col * 10, y: row * 10, bag: "stash" },
    cells,
  };
}

function textFor(itemClass: string, name = "Test Item"): string {
  return ["Item Class: " + itemClass, "Rarity: Normal", name].join("\n");
}

describe("wanted item class aliases", () => {
  it("normalizes belt aliases to Belts", () => {
    expect(normalizeItemClass("belt")).toBe("Belts");
    expect(normalizeItemClass("Belts")).toBe("Belts");
    expect(normalizeItemClass("BELTS")).toBe("Belts");
  });

  it("normalizes body armour aliases to Body Armours", () => {
    expect(normalizeItemClass("body")).toBe("Body Armours");
    expect(normalizeItemClass("body armour")).toBe("Body Armours");
    expect(normalizeItemClass("body armor")).toBe("Body Armours");
    expect(normalizeItemClass("Body Armours")).toBe("Body Armours");
  });

  it("parses a comma list and drops blanks", () => {
    expect(parseWantedClasses("Belts,Body Armours")).toEqual(["Belts", "Body Armours"]);
    expect(parseWantedClasses("belt, body armor")).toEqual(["Belts", "Body Armours"]);
    expect(parseWantedClasses("")).toEqual([]);
    expect(parseWantedClasses(undefined)).toEqual([]);
  });

  it("reads --class= from argv, including unquoted Body Armours", () => {
    expect(readClassFlag(["--cycles=2"])).toEqual([]);
    expect(readClassFlag(["--class=Belts", "--cycles=2"])).toEqual(["Belts"]);
    expect(readClassFlag(["--class=Body", "Armours", "--cycles=2"])).toEqual(["Body Armours"]);
    expect(readClassFlag(["--class=Belts,Body", "Armours"])).toEqual(["Belts", "Body Armours"]);
  });

  it("matches parsed clipboard class against wanted aliases", () => {
    expect(itemMatchesWantedClass({ itemClass: "Belts" }, ["Belts"])).toBe(true);
    expect(itemMatchesWantedClass({ itemClass: "Belts" }, ["belt"])).toBe(true);
    expect(itemMatchesWantedClass({ itemClass: "Body Armours" }, ["body armor"])).toBe(true);
    expect(itemMatchesWantedClass({ itemClass: "Shields" }, ["Body Armours"])).toBe(false);
    expect(itemMatchesWantedClass({ itemClass: "Belts" }, [])).toBe(true);
  });

  it("names the empty-match reason after a single class", () => {
    expect(noMatchReason(["Belts"])).toBe("stash-no-unused-belts");
    expect(noMatchReason(["Body Armours"])).toBe("stash-no-unused-body-armours");
    expect(noMatchReason(["Belts", "Body Armours"])).toBe("no-matching-items");
    expect(isClassFilterReason("stash-no-unused-belts")).toBe(true);
  });

  it("maps wanted classes to stash-search queries", () => {
    expect(searchQueryForClass("Belts")).toBe('"class: Belts"');
    expect(searchQueryForClass("body armor")).toBe('"class: Body Armours"');
    expect(searchQueryForClass("Currency")).toBe('"class: (currency|stackable currency)"');
    expect(searchQueriesForClasses(["Belts", "Body Armours"])).toEqual([
      '"class: Belts"',
      '"class: Body Armours"',
    ]);
    expect(searchScenarioQuery(["Belts", "Body Armours"])).toBe(
      '"class: Belts" | "class: Body Armours"',
    );
  });
});

describe("stash search highlight fill", () => {
  const quad = { x: 28, y: 245, w: 1252, h: 1276 };
  const search = { x: 560, y: 1570, w: 380, h: 30 };

  it("clicks the center of the calibrated search box, not a guessed footer point", () => {
    const point = stashSearchClick(search);
    expect(point).toEqual({ x: 750, y: 1585 });
    expect(isStashSearchClick(point, search, quad)).toBe(true);
    expect(isStashSearchClick({ x: 529, y: 1559 }, search, quad)).toBe(false);
    expect(point.y).toBeGreaterThan(quad.y + quad.h);
    expect(point.x).toBeLessThan(quad.x + quad.w);
    expect(
      isStashSearchClick(
        { x: 1065, y: 1792 },
        { x: 827, y: 1765, w: 478, h: 55 },
        quad,
      ),
    ).toBe(true);
    expect(
      isStashSearchClick(
        { x: 1065, y: 1900 },
        { x: 827, y: 1875, w: 478, h: 50 },
        quad,
      ),
    ).toBe(false);
  });

  it("treats a still-full unused set as a failed search", () => {
    expect(searchLooksFailed(392, 20)).toBe(false);
    expect(searchLooksFailed(392, 200)).toBe(true);
    expect(searchLooksFailed(40, 12)).toBe(false);
  });

  it("sizes only exact highlighted class footprints and does not copy", () => {
    const belt = item("0,0:2x1", 2, 1, 0, 0);
    const coin = item("1,3:1x1", 1, 1, 1, 3);
    const body = item("3,6:2x3", 2, 3, 3, 6);
    const sprites = [belt, coin, body];
    const occupied = sprites.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    const result = searchFillPool({
      sprites,
      occupiedStash: occupied,
      occupiedBag: [],
      bagRegion: { x: 0, y: 0, w: 100, h: 100 },
      stashCols: 24,
      exclude: new Set(),
      wantedClasses: ["Belts"],
      query: "Belt",
      litCells: 3,
    });
    expect(result.method).toBe("search");
    expect(result.copies).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ itemClass: "Belts", w: 2, h: 1 });
    expect(result.skipped.map((row) => row.id)).toEqual(expect.arrayContaining([coin.id, body.id]));
  });
});

describe("class-filtered fill identify", () => {
  it("prefers sprites whose footprint could be the wanted class", () => {
    const belt = item("0,0:2x1", 2, 1, 0, 0);
    const body = item("2,0:2x3", 2, 3, 2, 0);
    const coin = item("0,4:1x1", 1, 1, 0, 4);
    const picked = pickClassCopyTargets([body, coin, belt], ["Belts"], 2);
    expect(picked.map((row) => row.id)).toEqual(["0,0:2x1", "0,4:1x1"]);
  });

  it("keeps only copied Belts and leaves non-matches unused", async () => {
    const belt = item("0,0:2x1", 2, 1, 0, 0);
    const otherBeltSized = item("1,3:2x1", 2, 1, 1, 3);
    const body = item("3,6:2x3", 2, 3, 3, 6);
    const sprites = [belt, otherBeltSized, body];
    const occupied = sprites.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    const texts = new Map([
      [belt.grab.x, textFor("Belts", "Wide Belt")],
      [otherBeltSized.grab.x, textFor("Rings", "Ruby Ring")],
      [body.grab.x, textFor("Body Armours", "Plate Vest")],
    ]);
    const result = await sizeFillPool({
      sprites,
      occupiedStash: occupied,
      occupiedBag: [],
      bagRegion: { x: 0, y: 0, w: 100, h: 100 },
      stashCols: 24,
      exclude: new Set(),
      sizeDb: withClassDefaults(emptySizeDatabase()),
      wantedClasses: ["Belts"],
      copyItem: async (x) => texts.get(x) ?? "",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ itemClass: "Belts", w: 2, h: 1 });
    expect(result.classes).toEqual(["Belts"]);
    expect(result.skipped.some((row) => row.itemClass === "Rings" || row.id === otherBeltSized.id)).toBe(true);
    expect(result.items.some((row) => row.itemClass === "Body Armours")).toBe(false);
  });

  it("stops clipboard identification at the requested match limit", async () => {
    const sprites = [
      item("0,0:1x3", 1, 3, 0, 0),
      item("0,2:1x3", 1, 3, 0, 2),
      item("0,4:1x3", 1, 3, 0, 4),
    ];
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
      wantedClasses: ["Wands"],
      maxMatches: 1,
      copyItem: async () => {
        copies += 1;
        return textFor("Wands", "Shrine Sceptre");
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.copies).toBe(1);
    expect(copies).toBe(1);
  });

  it("skips a 2x3 shield when the wanted class is Body Armours", async () => {
    const armour = item("0,0:2x3", 2, 3, 0, 0);
    const shield = item("0,3:2x3", 2, 3, 0, 3);
    const sprites = [armour, shield];
    const occupied = sprites.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    const result = await sizeFillPool({
      sprites,
      occupiedStash: occupied,
      occupiedBag: [],
      bagRegion: { x: 0, y: 0, w: 100, h: 100 },
      stashCols: 24,
      exclude: new Set(),
      sizeDb: withClassDefaults(emptySizeDatabase()),
      wantedClasses: ["Body Armours"],
      copyItem: async (x) => (x === armour.grab.x ? textFor("Body Armours", "Plate Vest") : textFor("Shields", "Tower Shield")),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ itemClass: "Body Armours", w: 2, h: 3 });
    expect(result.skipped.map((row) => row.itemClass)).toContain("Shields");
  });

  it("returns leftover unused sprites when no class filter is set", async () => {
    const sprites = [item("0,0:1x1", 1, 1, 0, 0), item("0,2:2x2", 2, 2, 0, 2)];
    const occupied = sprites.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    const result = await sizeFillPool({
      sprites,
      occupiedStash: occupied,
      occupiedBag: [],
      bagRegion: { x: 0, y: 0, w: 100, h: 100 },
      stashCols: 24,
      exclude: new Set(),
      sizeDb: withClassDefaults(emptySizeDatabase()),
      copyItem: async () => textFor("Helmets", "Cryptic Helm"),
    });
    expect(result.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FillBagFromStash class filter", () => {
  function planAction(skill: FillBagFromStash, facts: UiFacts) {
    return skill.plan(facts);
  }

  function factsWithStash() {
    const frame = stashAndBagFrame([], [{ row: 0, col: 0 }]);
    const profile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      stashGrid: {
        x: 80,
        y: 144,
        w: 736,
        h: 630,
        cols: 12,
        rows: 12,
        patch: packPatch(frame, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      bagGrid: {
        x: 1048,
        y: 324,
        w: 480,
        h: 450,
        cols: 12,
        rows: 5,
        patch: packPatch(frame, TEST_CLIENT, { x: 1048, y: 324, w: 480, h: 450 }),
      },
      npcs: [
        {
          id: "stash",
          label: "Stash",
          x: 800,
          y: 520,
          patch: packNpcPatch(frame, TEST_CLIENT, 800, 520),
        },
      ],
    };
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    facts.stashItems = [
      item("0,0:2x1", 2, 1, 0, 0),
      item("2,0:1x1", 1, 1, 2, 0),
    ];
    facts.occupiedStash = facts.stashItems.flatMap((row) => row.cells.map((cell) => ({ ...cell, x: 0, y: 0 })));
    facts.occupiedBag = [];
    return facts;
  }

  it("clicks only identified class matches and remembers only those cells", () => {
    const facts = factsWithStash();
    const exclude = new Set<string>();
    const withdrawn: StashItem[] = [];
    const belt = item("0,0:2x1", 2, 1, 0, 0, "Belts");
    const skill = new FillBagFromStash([belt], exclude, true, withdrawn, ["Belts"]);
    const step = planAction(skill, facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions).toHaveLength(1);
      expect(step.actions[0]).toMatchObject({ x: belt.grab.x, y: belt.grab.y });
    }
    expect([...exclude]).toEqual([]);
    expect(withdrawn).toHaveLength(0);
    facts.occupiedBag = [
      { row: 0, col: 0, x: 0, y: 0 },
      { row: 0, col: 1, x: 0, y: 0 },
    ];
    facts.occupiedStash = facts.occupiedStash.filter((cell) => cell.row >= 2);
    facts.stashItems = facts.stashItems.filter((stashItem) => stashItem.grab.row >= 2);
    expect(planAction(skill, facts).reason).toBe("filter-exhausted");
    expect([...exclude]).toEqual(["0,0"]);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.itemClass).toBe("Belts");
  });

  it("does not leftover-click unknown sprites when --class is set", () => {
    const facts = factsWithStash();
    const exclude = new Set<string>();
    const skill = new FillBagFromStash(undefined, exclude, true, [], ["Belts"]);
    expect(planAction(skill, facts).reason).toBe("filter-exhausted");
    expect(exclude.size).toBe(0);
  });

  it("does not click a known item that lacks a matching class", () => {
    const facts = factsWithStash();
    const exclude = new Set<string>();
    const leftover = item("2,0:1x1", 1, 1, 2, 0);
    const skill = new FillBagFromStash([leftover], exclude, true, [], ["Belts"]);
    expect(planAction(skill, facts).reason).toBe("filter-exhausted");
    expect(exclude.size).toBe(0);
  });
});
