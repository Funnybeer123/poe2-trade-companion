import { describe, expect, it } from "vitest";
import {
  alignWindow,
  extendCanonical,
  labelsSimilar,
  snapRows,
  type OcrLine,
} from "../src/core/tabList.js";

function line(text: string, y: number): OcrLine {
  return { text, x: 1430, y, w: 200, h: 32 };
}

describe("tabList", () => {
  it("snaps OCR lines to slots and interpolates missed rows", () => {
    const rows = snapRows([
      line("alpha", 192),
      line("beta", 239),
      // gamma missed by OCR at ~286
      line("delta", 333),
      line("epsilon", 381),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["alpha", "beta", "(unreadable)", "delta", "epsilon"]);
    expect(rows[2]!.readable).toBe(false);
    expect(rows[2]!.clickY).toBeGreaterThan(285);
    expect(rows[2]!.clickY).toBeLessThan(315);
  });

  it("matches garbled OCR labels loosely", () => {
    expect(labelsSimilar("-price 1 divine", "price 1 IVIne")).toBe(true);
    expect(labelsSimilar("Maps", "Ma s")).toBe(true);
    expect(labelsSimilar("O Rune", "Rune")).toBe(true);
    expect(labelsSimilar("CUR (Remove-only)", "cUR (Remove-only)")).toBe(true);
    expect(labelsSimilar("-price 18 exalted (Remove-onl", "-price 18 exalted (Remove-only)")).toBe(true);
    expect(labelsSimilar("Runes", "Dist")).toBe(false);
  });

  it("aligns a scrolled window against the canonical list and extends it", () => {
    const canonical = ["tab-a", "tab-b", "tab-c", "tab-d", "tab-e", "tab-f"];
    const window = snapRows([
      line("tab-c", 192),
      line("tab-d", 239),
      line("garble", 286),
      line("tab-f", 333),
      line("tab-g", 381),
    ]);
    const shift = alignWindow(window, canonical);
    expect(shift).toBe(2);
    const extended = extendCanonical(canonical, window, shift!);
    expect(extended).toEqual(["tab-a", "tab-b", "tab-c", "tab-d", "tab-e", "tab-f", "tab-g"]);
  });

  it("refuses to align when labels do not match", () => {
    const window = snapRows([line("x1", 192), line("x2", 239), line("x3", 286), line("x4", 333)]);
    expect(alignWindow(window, ["a", "b", "c", "d", "e"])).toBeUndefined();
  });
});
