import { describe, expect, it } from "vitest";
import { bagDecision, captureBagObservations, eligibleBagEquipment } from "../src/core/bagAssessment.js";
import { knownPhysicalItemSize } from "../src/core/itemSizeCatalog.js";
import { classDefaultSize } from "../src/core/itemSizeStore.js";
import { scene } from "./support/bagFixtures.js";
import { AT } from "./support/batchFixtures.js";

const shield = (base = "Vaal Tower Shield") =>
  `Item Class: Shields\nRarity: Magic\n${base}\n--------\nBlock chance: 26%\nArmour: 244\n--------\nItem Level: 81\n--------\nUnidentified (Tier 3)`;

describe("confirmed physical item sizes", () => {
  it.each([
    ["Pinnacle Keys", "Ancient Crisis Fragment"],
    ["Augment", "Boar Idol"],
    ["Map Fragments", "An Audience with the King"],
  ])("captures distinct adjacent %s items while retaining non-equipment protection", (itemClass, base) => {
    const raw = `Item Class: ${itemClass}\nRarity: Currency\n${base}\n--------\nFixture description`;
    const observed = scene([{ text: raw, row: 0, col: 0, w: 1, h: 1 }, { text: raw, row: 0, col: 1, w: 1, h: 1 }]);
    const report = captureBagObservations("small-items", observed.cells, undefined, AT);
    expect(classDefaultSize(itemClass)).toEqual({ w: 1, h: 1 });
    expect(report.capture?.complete).toBe(true);
    expect(report.rows.map(row => row.cells)).toEqual([[{ row: 0, col: 0 }], [{ row: 0, col: 1 }]]);
    expect(eligibleBagEquipment(raw)).toBe(false);
    expect(report.rows.map(row => bagDecision(row, report, AT).action)).toEqual(["keep", "keep"]);
  });

  it("keeps two touching 2x4 Vaal Tower Shields distinct with eight confirmed cells each", () => {
    const observed = scene([{ text: shield(), row: 0, col: 0, w: 2, h: 4 }, { text: shield(), row: 0, col: 2, w: 2, h: 4 }]);
    const report = captureBagObservations("tower-shields", observed.cells, undefined, AT);
    expect(report.capture?.complete).toBe(true);
    expect(report.unreadCells).toEqual([]);
    expect(report.rows.map(row => row.cells?.length)).toEqual([8, 8]);
    expect(report.rows.map(row => bagDecision(row, report, AT).action)).toEqual(["review", "review"]);
  });

  it("rejects a partial Vaal Tower Shield rather than treating it as the 2x3 shield default", () => {
    const observed = scene([{ text: shield(), row: 0, col: 0, w: 2, h: 3 }]);
    const report = captureBagObservations("partial-tower", observed.cells, undefined, AT);
    expect(report.capture?.complete).toBe(false);
    expect(report.unreadCells).toHaveLength(6);
    expect(bagDecision(report.rows[0]!, report, AT).action).toBe("review");
  });

  it("limits the exception to the exact base and shield class", () => {
    expect(knownPhysicalItemSize("Shields", "Vaal Tower Shield")).toEqual({ w: 2, h: 4 });
    expect(knownPhysicalItemSize("Shields", "Unknown Tower Shield")).toEqual({ w: 2, h: 3 });
    expect(knownPhysicalItemSize("Shields", "Vaal Tower Shield of the Bear")).toEqual({ w: 2, h: 3 });
    expect(knownPhysicalItemSize("Unknown Class", "Vaal Tower Shield")).toBeUndefined();
    expect(classDefaultSize("Shields")).toEqual({ w: 2, h: 3 });
    const observed = scene([{ text: shield("Unknown Tower Shield"), row: 0, col: 0, w: 2, h: 4 }]);
    expect(captureBagObservations("unconfirmed-base", observed.cells, undefined, AT).capture?.complete).toBe(false);
  });
});
