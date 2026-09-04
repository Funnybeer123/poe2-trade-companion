import { describe, expect, it } from "vitest";
import { currencyFromLabel, isAskingPriceLabel, parseAskingPrice } from "../src/adapters/shopKeeper.js";
import { buildShopSnapshot } from "../src/core/shopListings.js";
import { starterPriceTable } from "../src/core/priceTable.js";
import type { OcrLine } from "../src/adapters/stashTabKit.js";

/**
 * The merchant's price ground truth (docs/HANDOFF-shop-listings.md, GROUND
 * TRUTH): the hover tooltip's "Asking Price:" line, never the Ctrl+C text.
 */

function line(text: string, x: number, y: number, w = 200, h = 28): OcrLine {
  return { text, x, y, w, h };
}

describe("currencyFromLabel", () => {
  it("folds the dialog's and tooltip's currency labels to orb ids", () => {
    expect(currencyFromLabel("Divine Orb")).toBe("divine");
    expect(currencyFromLabel("Exalted Orb")).toBe("exalted");
    expect(currencyFromLabel("1x Exalted Orb")).toBe("exalted");
    expect(currencyFromLabel("Orb of Alchemy")).toBe("alchemy");
    expect(currencyFromLabel("Orb of Annulment")).toBe("annulment");
    expect(currencyFromLabel("Chaos Orb")).toBe("chaos");
  });

  it("keeps the greater/perfect variants distinct from the base orb", () => {
    expect(currencyFromLabel("Greater Exalted Orb")).toBe("greater-exalted");
    expect(currencyFromLabel("Perfect Chaos Orb")).toBe("perfect-chaos");
  });

  it("returns undefined for empty labels", () => {
    expect(currencyFromLabel("")).toBeUndefined();
    expect(currencyFromLabel("12x")).toBeUndefined();
  });
});

describe("parseAskingPrice", () => {
  it("reads the label + value pair the tooltip renders", () => {
    const result = parseAskingPrice([
      line("Flaming Adherent Bow of the Parched", 900, 30, 900),
      line("Asking Price:", 1150, 560, 230),
      line("1x Divine Orb", 1120, 610, 260),
    ]);
    expect(result).toMatchObject({ amount: 1, currency: "divine" });
  });

  it("accepts the value OCR'd onto the label's own line", () => {
    const result = parseAskingPrice([line("Asking Price: 2x Divine Orb", 1100, 560, 500)]);
    expect(result).toMatchObject({ amount: 2, currency: "divine" });
  });

  it("survives the live OCR variants: icon-as-dash and a misread colon", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 665, 511, 230), line("18X - DIVINE ORB", 633, 575, 300)]),
    ).toMatchObject({ amount: 18, currency: "divine" });
    expect(
      parseAskingPrice([line("ASKING PRICE?", 1205, 583, 230), line("188X DIVINE ORB", 1173, 647, 300)]),
    ).toMatchObject({ amount: 188, currency: "divine" });
  });

  it("joins a value split across two OCR lines", () => {
    const result = parseAskingPrice([
      line("Asking Price:", 1150, 560, 230),
      line("3x", 1160, 612, 40),
      line("Exalted Orb", 1230, 612, 200),
    ]);
    expect(result).toMatchObject({ amount: 3, currency: "exalted" });
  });

  it("ignores lines far from the label and returns undefined without one", () => {
    expect(parseAskingPrice([line("Requires: Level 59", 1100, 400)])).toBeUndefined();
    expect(
      parseAskingPrice([line("Asking Price:", 1150, 560, 230), line("5x Divine Orb", 2900, 1300, 260)]),
    ).toBeUndefined();
  });

  it("folds a diacritic in the label and fuzzy-matches a garbled one (live 2026-09-03)", () => {
    expect(
      parseAskingPrice([line("ASKING PRICÉ:", 660, 1180, 230), line("EXALTED ORB", 700, 1240, 200)]),
    ).toMatchObject({ amount: 1, currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("AsigNGPRlGE:", 660, 1180, 230), line("1x EXALTED ORB", 630, 1240, 260)]),
    ).toMatchObject({ amount: 1, currency: "exalted" });
    expect(isAskingPriceLabel("GAIN 27 MANA PER ENEMY KILLED")).toBe(false);
  });

  it("never turns digit-less debris into an amount (live 2026-09-03: 'IO' → 10x)", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 660, 1180, 230), line("IO Ixt05 EXALTED ORB", 630, 1240, 300)]),
    ).toMatchObject({ amount: 1, currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 660, 1180, 230), line("lxv EXALTED ORB", 630, 1240, 300)]),
    ).toMatchObject({ amount: 1, currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 660, 1180, 230), line("10x EXALTED ORB", 630, 1240, 300)]),
    ).toMatchObject({ amount: 10, currency: "exalted" });
  });

  it("strips shortcut hints glued onto the value row instead of dropping it", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 120, 700, 230), line("1x EXALTED ORB COMPARE", 100, 760, 400)]),
    ).toMatchObject({ amount: 1, currency: "exalted" });
    expect(
      parseAskingPrice([
        line("ASKING PRICE:", 120, 700, 230),
        line("3x Divine Orb SHIFT+ALT PRICE CHECK", 100, 760, 500),
      ]),
    ).toMatchObject({ amount: 3, currency: "divine" });
    // A hint-only line still contributes nothing.
    expect(
      parseAskingPrice([line("ASKING PRICE:", 120, 700, 230), line("COMPARE", 400, 760, 120)]),
    ).toBeUndefined();
  });

  it("anchors on the cooldown lines when the label is unreadable", () => {
    expect(
      parseAskingPrice([
        line("YOU ASSIGNED A RICE fro THIS ITEM RECENTLY,", 520, 1080, 600),
        line("AND CANNOT M DIF O'OREMOVE THE ITEM YET.", 520, 1110, 600),
        line("EXALTED ORB", 640, 1200, 200),
      ]),
    ).toMatchObject({ amount: 1, currency: "exalted", locked: true, amountAssumed: true });
    // Cooldown lines alone prove a price exists but not which: still unread.
    expect(
      parseAskingPrice([
        line("YOU ASSIGNED A PRICE TO THIS ITEM RECENTLY,", 520, 1080, 600),
        line("AND CANNOT MODIFY OR REMOVE THE ITEM YET.", 520, 1110, 600),
      ]),
    ).toBeUndefined();
  });
});

describe("snapshot from tooltip prices", () => {
  const TEXT = [
    "Item Class: Bows",
    "Rarity: Magic",
    "Flaming Adherent Bow of the Parched",
    "--------",
    "Item Level: 80",
    "--------",
    "Adds 23 to 33 Fire Damage",
  ].join("\n");

  it("prefers the asking price over the (absent) Note line", () => {
    const snapshot = buildShopSnapshot(
      [{ text: TEXT, cells: [{ row: 0, col: 0 }], askingPrice: { amount: 2, currency: "divine" } }],
      { at: "2026-09-02T05:00:00.000Z", tab: "Shop", priceTable: starterPriceTable() },
    );
    expect(snapshot.items[0]!.note).toMatchObject({ kind: "price", amount: 2, currency: "divine" });
    expect(snapshot.items[0]!.priceExalted).toBe(80);
    expect(snapshot.unpricedCount).toBe(0);
  });

  it("counts an item with neither tooltip price nor Note as unpriced", () => {
    const snapshot = buildShopSnapshot([{ text: TEXT, cells: [{ row: 0, col: 0 }] }], {
      at: "2026-09-02T05:00:00.000Z",
      tab: "Shop",
    });
    expect(snapshot.unpricedCount).toBe(1);
  });
});

describe("parseAskingPrice — tiny 1x glyph", () => {
  it("folds l/I confusables and icon debris in the amount", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 829, 617, 230), line("lxv", 799, 684, 40), line("EXALTED ORB", 903, 681, 220)]),
    ).toMatchObject({ amount: 1, currency: "exalted" });
  });

  it("assumes and FLAGS 1x when only the currency line survives OCR", () => {
    const result = parseAskingPrice([line("ASKING PRICE:", 665, 511, 230), line("EXALTED ORB", 739, 575, 220)]);
    expect(result).toMatchObject({ amount: 1, currency: "exalted", amountAssumed: true });
    expect(result?.raw).toMatch(/assumed/);
  });

  it("reports the cooldown lock line", () => {
    const result = parseAskingPrice([
      line("YOU ASSIGNED A PRICE TO THIS ITEM RECENTLY,", 402, 397, 900),
      line("AND CANNOT MODIFY OR REMOVE THE ITEM YET.", 484, 456, 900),
      line("ASKING PRICE:", 665, 511, 230),
      line("18X DIVINE ORB", 633, 575, 300),
    ]);
    expect(result).toMatchObject({ amount: 18, currency: "divine", locked: true });
  });
});

describe("parseAskingPrice — shortcut hints beside the price", () => {
  it("ignores the Price Check hint line and strips punctuation debris", () => {
    const result = parseAskingPrice([
      line("ASKING PRICE:", 831, 617, 230),
      line("PRICE CHECK", 554, 640, 200),
      line("'2", 799, 684, 30),
      line("EXALTED ORB", 903, 681, 220),
    ]);
    expect(result).toMatchObject({ amount: 2, currency: "exalted" });
  });
});

describe("parseAskingPrice — amount after the currency", () => {
  it("finds the amount token wherever the OCR put it", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("EXALTED ORB 5Xz", 640, 560, 320)]),
    ).toMatchObject({ amount: 5, currency: "exalted" });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("EXALTED ORB", 700, 560, 220), line("5X", 640, 560, 40)]),
    ).toMatchObject({ amount: 5, currency: "exalted" });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("18X - DIVINE ORB", 633, 575, 300)]),
    ).toMatchObject({ amount: 18, currency: "divine" });
  });
});

describe("parseAskingPrice — world text glued to the value line", () => {
  it("cuts at ORB and accepts PRB/0RB misreads", () => {
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("EXALTED ORB . BENCH", 640, 560, 420)]),
    ).toMatchObject({ currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("EXALTED ORB REPOQO.INO. RFN0H", 640, 560, 520)]),
    ).toMatchObject({ currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("EXALTED PRB", 640, 560, 220)]),
    ).toMatchObject({ currency: "exalted", amountAssumed: true });
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("Ixtc 5) EXALTED ORB", 640, 560, 320)]),
    ).toMatchObject({ amount: 1, currency: "exalted" });
  });
});

describe("currency phrase wins over OCR debris", () => {
  it("reads the known currency phrase wherever it sits", () => {
    expect(currencyFromLabel("AD EXALTED ORB")).toBe("exalted");
    expect(currencyFromLabel("EXALTED ORB . BENCH")).toBe("exalted");
    expect(currencyFromLabel("Greater Exalted Orb")).toBe("greater-exalted");
    expect(currencyFromLabel("Orb of Alchemy")).toBe("alchemy");
    expect(
      parseAskingPrice([line("ASKING PRICE:", 700, 500, 230), line("Ixt AD EXALTED ORB", 640, 560, 360)]),
    ).toMatchObject({ amount: 1, currency: "exalted" });
  });
});
