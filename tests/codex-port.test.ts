import { describe, expect, it } from "vitest";
import { analyzeCellSamples, classifySample, groupOccupiedRegions } from "../src/core/cellOccupancy.js";
import { cellCenterBilinear, cellCenterTwoCorner, itemCenterBilinear } from "../src/core/gridMath.js";
import { extractItemMods, looksLikePoeItemText, parseItemText } from "../src/core/parseItem.js";
import { classDefaultSize } from "../src/core/itemSizeStore.js";
import { compileRules, isScrollOfWisdom, matchItemsAgainstText } from "../src/core/scanRules.js";

describe("Codex occupancy classifier", () => {
  it("treats dark low-chroma cells as empty", () => {
    expect(classifySample({ r: 18, g: 16, b: 20 })).toBe("empty");
  });

  it("treats hover-blue as highlight, not empty", () => {
    expect(classifySample({ r: 20, g: 24, b: 70 })).toBe("highlight");
  });

  it("requires several empty votes and no occupied votes", () => {
    const empty = { r: 14, g: 14, b: 16 };
    const occupied = { r: 120, g: 80, b: 40 };
    const emptyVotes = Array.from({ length: 9 }, () => empty);
    expect(analyzeCellSamples(emptyVotes).isEmpty).toBe(true);
    expect(analyzeCellSamples([empty, empty, occupied, empty, empty, empty, empty, empty, empty]).isEmpty).toBe(false);
  });

  it("treats ambiguous and highlight-heavy cells as occupied", () => {
    const highlight = { r: 22, g: 26, b: 68 };
    expect(analyzeCellSamples(Array.from({ length: 9 }, () => highlight)).isEmpty).toBe(false);
    expect(analyzeCellSamples([{ r: 40, g: 40, b: 40 }]).isEmpty).toBe(false);
  });

  it("groups disconnected occupied regions", () => {
    const grid = [
      [true, false, true],
      [true, false, false],
    ];
    const regions = groupOccupiedRegions(grid);
    expect(regions).toHaveLength(2);
    expect(regions.some((region) => region.rectangular && region.cells.length === 2)).toBe(true);
  });
});

describe("Codex grid math", () => {
  it("uses cell centers for a 2x2 two-corner grid", () => {
    const point = cellCenterTwoCorner({ topLeft: { x: 0, y: 0 }, bottomRight: { x: 200, y: 100 } }, 0, 0, 2, 2);
    expect(point).toEqual({ x: 50, y: 25 });
  });

  it("interpolates a skewed quad", () => {
    const corners = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 240, y: 10 },
      bottomLeft: { x: 8, y: 240 },
      bottomRight: { x: 248, y: 250 },
    };
    const center = cellCenterBilinear(corners, 0, 0, 2, 2);
    expect(center.x).toBeGreaterThan(0);
    expect(center.x).toBeLessThan(130);
    const item = itemCenterBilinear(corners, 0, 0, 2, 1, 2, 2);
    expect(item.x).toBeGreaterThan(center.x);
  });
});

describe("Codex item parse and class sizes", () => {
  it("accepts PoE clipboard text and extracts two-number damage mods", () => {
    const text = [
      "Item Class: Gloves",
      "Rarity: Rare",
      "Ash Grip",
      "Riveted Mitts",
      "--------",
      "+12 to Strength",
      "Adds 4 to 8 Fire Damage to Attacks",
      "Unidentified",
    ].join("\n");
    expect(looksLikePoeItemText(text)).toBe(true);
    const item = parseItemText(text);
    expect(item.identified).toBe(false);
    const fire = extractItemMods(text).find((mod) => /Adds 4 to 8 Fire/.test(mod.text));
    expect(fire).toMatchObject({ value: 4, value2: 8 });
  });

  it("skips header properties but keeps waystone colon mods", () => {
    const text = [
      "Item Class: Waystones",
      "Rarity: Magic",
      "Waystone (Tier 11)",
      "--------",
      "Waystone Tier: 11",
      "Magic Monsters: +30% (augmented)",
      "Item Quantity: +18% (augmented)",
    ].join("\n");
    const mods = extractItemMods(text).map((mod) => mod.text);
    expect(mods).toContain("Magic Monsters: +30%");
    expect(mods).toContain("Item Quantity: +18%");
    expect(mods.some((mod) => mod.startsWith("Waystone Tier"))).toBe(true);
  });

  it("fills missing Codex class sizes", () => {
    expect(classDefaultSize("Shields")).toEqual({ w: 2, h: 3 });
    expect(classDefaultSize("Charms")).toEqual({ w: 1, h: 1 });
    expect(classDefaultSize("Daggers")).toEqual({ w: 1, h: 3 });
    expect(classDefaultSize("Spears")).toEqual({ w: 1, h: 4 });
    expect(classDefaultSize("Waystones")).toEqual({ w: 1, h: 1 });
    expect(classDefaultSize("Tablet")).toEqual({ w: 1, h: 1 });
    expect(classDefaultSize("Wombgifts")).toEqual({ w: 1, h: 1 });
  });
});

describe("Codex scan rules", () => {
  it("matches AND lines, OR segments, and resist helpers", () => {
    const item = [
      "Rarity: Rare",
      "+24 to maximum Life",
      "+17% to Cold Resistance",
      "+12% to Fire Resistance",
    ].join("\n");
    const andHit = matchItemsAgainstText(item, [
      { name: "life+cold", regex: "to Cold Resistance\n--------\nAND\n--------\n+24 to maximum Life" },
    ]);
    expect(andHit.map((rule) => rule.name)).toEqual(["life+cold"]);

    const orHit = matchItemsAgainstText(item, [{ name: "either", regex: "to Chaos Resistance\nOR\nto Cold Resistance" }]);
    expect(orHit).toHaveLength(1);

    const resists = matchItemsAgainstText(item, [
      { name: "any2", regex: "ANY_RESIST>=2" },
      { name: "total", regex: "TOTAL_ELE_RES>=20" },
    ]);
    expect(resists.map((rule) => rule.name)).toEqual(["any2", "total"]);
  });

  it("matches Adds averages and range suffixes", () => {
    const compiled = compileRules([{ name: "fire", regex: "Adds # to # Fire Damage to Attacks [4-8;5-9]" }]);
    expect(
      matchItemsAgainstText("Adds 4 to 8 Fire Damage to Attacks", compiled).map((rule) => rule.name),
    ).toEqual(["fire"]);
  });

  it("recognizes a wisdom scroll", () => {
    expect(isScrollOfWisdom("Item Class: Stackable Currency\nScroll of Wisdom")).toBe(true);
  });
});
