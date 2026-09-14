import { describe, expect, it } from "vitest";
import { bagCellPixels, boxPixels, emptyBagPixels, obstructingBagUi, sameBagPixels, visibleLife, visibleLifeInHud } from "../src/core/bagPixels.js";

describe("live bag image evidence", () => {
  it("pairs separate Life OCR columns by HUD position instead of reading Shield or Ward", () => {
    const client = { width: 3840, height: 2160 };
    const label = { text: "Life", x: 93, y: 1590, w: 56, h: 30 };
    const value = { text: "2,446/2,599", x: 234, y: 1593, w: 176, h: 36 };
    const shield = { text: "1,165/1,165", x: 262, y: 1637, w: 148, h: 36 };
    expect(visibleLifeInHud([label, shield, value], client)).toBe(true);
    expect(visibleLifeInHud([label, { ...value, text: "*2,446/2,599" }, shield, value], client)).toBe(true);
    for (const lines of [[label, shield], [label, { ...value, text: "0/2,599" }, shield],
      [label, value, { ...value, x: 420, w: 100 }], [{ ...label, y: 500 }, { ...value, y: 500 }],
      [{ ...label, text: "Shield" }, value], [value], [label, { ...value, x: 1000 }]]) {
      expect(visibleLifeInHud(lines, client)).toBe(false);
    }
  });
  it("samples cell interiors independently, keeping the grid rim out of identity evidence", () => {
    const image = { width: 240, height: 100, data: Buffer.alloc(240 * 100 * 3, 20) };
    const grid = { x: 0, y: 0, w: 240, h: 100, cols: 12, rows: 5 };
    const before = bagCellPixels(image, grid, { row: 0, col: 0 });
    for (let y = 0; y < 20; y++) for (let x = 0; x < 3; x++) image.data.fill(255, (y * 240 + x) * 3, (y * 240 + x) * 3 + 3);
    expect(sameBagPixels(before, bagCellPixels(image, grid, { row: 0, col: 0 }))).toBe(true);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) image.data.fill(70, (y * 240 + x) * 3, (y * 240 + x) * 3 + 3);
    expect(sameBagPixels(before, bagCellPixels(image, grid, { row: 0, col: 0 }))).toBe(false);
    expect(emptyBagPixels(bagCellPixels(image, grid, { row: 0, col: 1 }))).toBe(true);
  });
  it("rejects unobserved/outside pixels instead of treating them as empty", () => {
    const image = { width: 10, height: 10, data: Buffer.alloc(300) };
    for (const box of [{ x: -1, y: 0, w: 2, h: 2 }, { x: 9, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 0, h: 2 }]) {
      expect(() => boxPixels(image, box)).toThrow("outside");
    }
    expect(emptyBagPixels([])).toBe(false);
    expect(sameBagPixels([], [])).toBe(false);
    expect(sameBagPixels([0], [0, 0])).toBe(false);
  });
  it("retains dark coloured backgrounds and small bright sprites as potentially occupied", () => {
    const dark = Array<number>(3072).fill(20);
    expect(emptyBagPixels(dark)).toBe(true);
    const red = dark.map((value, index) => index % 3 === 2 ? 65 : value);
    expect(emptyBagPixels(red)).toBe(false);
    const tinySprite = [...dark]; tinySprite[1536] = 80;
    expect(emptyBagPixels(tinySprite)).toBe(false);
    expect(emptyBagPixels(Array<number>(3072).fill(Number.NaN))).toBe(false);
  });
  it.each(["Life 0/100", "Life 101 / 100", "Life 100", "Maximum Life 100", "Life ? / 100"])("does not infer life from %s", text => {
    expect(visibleLife(text)).toBe(false);
  });
  it("accepts an explicit positive current/max Life pair and recognizes dangerous overlays", () => {
    expect(visibleLife("Inventory\nLife 1,234 / 2,000\nShield 0 / 500")).toBe(true);
    for (const text of ["You have died", "Resurrect at checkpoint", "Accept Trade", "Destroy this item?", "Are you sure?", "Sell Items", "Connection failed"]) {
      expect(obstructingBagUi(text)).toBe(true);
    }
    expect(obstructingBagUi("Inventory Cosmetics Life 100/100")).toBe(false);
  });
  it.each(["Trade", "Stash", "Guild Stash", "Merchant", "Gamble", "Vendor"])("rejects the standalone %s panel even when whole-frame OCR joins words", title => {
    expect(obstructingBagUi("Inventory Life 100/100 " + title + " Accept Cancel", ["Inventory", "Life 100/100", "  " + title.toUpperCase() + ":  ", "Accept", "Cancel"])).toBe(true);
    expect(obstructingBagUi("Inventory\nLife 100/100\n" + title + "\nAccept\nCancel")).toBe(true);
  });
  it("keeps normal Inventory/Cosmetics tabs and non-title sentences distinct from obstructing panels", () => {
    expect(obstructingBagUi("Inventory Cosmetics Life 100/100", ["Inventory", "Cosmetics", "Life 100/100"])).toBe(false);
    expect(obstructingBagUi("Inventory Life 100/100 Merchant Quarter", ["Inventory", "Life 100/100", "Merchant Quarter"])).toBe(false);
  });
});
