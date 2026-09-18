import { describe, expect, it } from "vitest";
import {
  BAG_GRID_CELLS,
  SHOP_DELIST,
  STASH_SCAN,
  shopBagCanAccept,
  shopItemStacksInBag,
} from "../src/core/copyTiming.js";

describe("shop withdraw timing + bag-full gate", () => {
  it("exposes a burst delist profile (no per-item verify dwell)", () => {
    expect(STASH_SCAN.shop.hoverMs).toBeLessThanOrEqual(STASH_SCAN.inventory.hoverMs);
    expect(SHOP_DELIST.burstDwellMs).toBe(0);
    expect(SHOP_DELIST.burstChunk).toBeGreaterThanOrEqual(12);
  });

  it("treats a full bag as unable to accept a non-stacking withdraw", () => {
    expect(BAG_GRID_CELLS).toBe(60);
    expect(shopBagCanAccept(0, 1)).toBe(false);
    expect(shopBagCanAccept(1, 1)).toBe(true);
    expect(shopBagCanAccept(2, 3)).toBe(false);
    expect(shopBagCanAccept(3, 3)).toBe(true);
  });

  it("recognizes stackable currency (bag cell count may stay flat)", () => {
    expect(
      shopItemStacksInBag({
        itemClass: "Stackable Currency",
        text: "Item Class: Stackable Currency\nStack Size: 12/20\nChaos Orb",
      }),
    ).toBe(true);
  });
});
