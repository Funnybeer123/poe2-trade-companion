import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyProfile, type CalibrationProfile } from "../src/core/calibrationProfile.js";
import { overlayItemPixelRect } from "../src/core/dryRunOverlay.js";
import { TOP_LEVEL_GRID_DY } from "../src/core/gearSort.js";
import type { InventoryObservation, LocationStaleness } from "../src/core/inventoryLedger.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { ScreenRect } from "../src/core/screenLayout.js";
import {
  cycleOverlayTab,
  gridCalibrationKey,
  isTopLevelTabLabel,
  parseGridCalibration,
  pickOverlayTab,
  planPriceOverlay,
  priceLabel,
  priceOverlayGeometry,
  type GridCalibrationFile,
  type PriceOverlayGeometry,
} from "../src/core/stashTrackerOverlay.js";

const CLIENT: ScreenRect = { left: 0, top: 0, width: 3840, height: 2160 };

const CALIBRATION: GridCalibrationFile = parseGridCalibration(
  readFileSync(new URL("../fixtures/stashTracker/grid-calibration-sample.json", import.meta.url), "utf8"),
);

function table(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [
      { id: "divine", match: { name: "Divine Orb" }, value: 98 },
      { id: "exalted", match: { name: "Exalted Orb" }, value: 1 },
      { id: "storm", match: { name: "Storm Loop" }, value: 3 },
      { id: "hh", match: { name: "Headhunter" }, value: 120 },
    ],
  };
}

function observation(
  partial: Partial<InventoryObservation> & Pick<InventoryObservation, "fingerprint" | "name">,
): InventoryObservation {
  return {
    at: "2026-09-12T18:20:05.000Z",
    location: "Belts",
    cells: [{ row: 3, col: 5 }],
    itemClass: "Belts",
    rarity: "Unique",
    identified: true,
    runId: "run-1",
    ...partial,
  };
}

const GEOMETRY: PriceOverlayGeometry = {
  region: { x: 34, y: 320, w: 1261, h: 1263 },
  cols: 24,
  rows: 24,
  source: "taught",
};

const STALENESS: LocationStaleness = {
  location: "Belts",
  lastScanAt: "2026-09-12T18:20:05.000Z",
  runId: "run-1",
  ageMs: 3 * 60 * 60_000,
};

function plan(
  observations: InventoryObservation[],
  options: Partial<{ fadeByValue: boolean; showUnpriced: boolean; minLabelExalted: number }> = {},
  excluded = new Set<string>(),
) {
  return planPriceOverlay({
    observations,
    table: table(),
    geometry: GEOMETRY,
    client: CLIENT,
    tab: "Belts",
    staleness: STALENESS,
    excluded,
    options: { fadeByValue: true, showUnpriced: true, minLabelExalted: 0, ...options },
  });
}

describe("parseGridCalibration", () => {
  it("reads the taught entries and drops anything malformed", () => {
    expect(CALIBRATION["Rings#0"]).toEqual({ x: 34, y: 320, w: 1261, h: 1263, cols: 12, rows: 12 });
    expect(parseGridCalibration(undefined)).toEqual({});
    expect(parseGridCalibration("not json")).toEqual({});
    expect(parseGridCalibration("[]")).toEqual({});
    expect(parseGridCalibration('{"a":{"x":1,"y":2,"w":0,"h":10,"cols":12,"rows":12}}')).toEqual({});
    expect(parseGridCalibration('{"a":{"x":1,"y":2,"w":10,"h":10}}')).toEqual({});
  });
});

describe("tab keys and the top-level heuristic", () => {
  it("adds the #0 suffix the sorter writes, except for the bag", () => {
    expect(gridCalibrationKey("Rings")).toBe("Rings#0");
    expect(gridCalibrationKey("Rings#1")).toBe("Rings#1");
    expect(gridCalibrationKey("bag")).toBe("bag");
    expect(gridCalibrationKey("")).toBe("");
  });

  it("recognises only the T band", () => {
    expect(isTopLevelTabLabel("T4")).toBe(true);
    expect(isTopLevelTabLabel("t12")).toBe(true);
    expect(isTopLevelTabLabel("T4#0")).toBe(true);
    expect(isTopLevelTabLabel("Rings")).toBe(false);
    expect(isTopLevelTabLabel("T100")).toBe(false);
    expect(isTopLevelTabLabel("")).toBe(false);
  });
});

describe("priceOverlayGeometry", () => {
  const profile: CalibrationProfile = {
    ...emptyProfile(),
    bagGrid: { x: 2530, y: 1470, w: 634, h: 264, cols: 12, rows: 5 },
    stashGrid: { x: 40, y: 330, w: 1200, h: 1200, cols: 12, rows: 12 },
    activeStashTab: "normal",
  };

  it("prefers a taught per-tab entry", () => {
    const geometry = priceOverlayGeometry({
      tabKey: "Rings",
      topLevel: false,
      gridCalibration: CALIBRATION,
      profile,
      client: CLIENT,
    });
    expect(geometry).toEqual({
      region: { x: 34, y: 320, w: 1261, h: 1263 },
      cols: 12,
      rows: 12,
      source: "taught",
    });
  });

  it("uses the taught top-level default for a T tab", () => {
    const geometry = priceOverlayGeometry({
      tabKey: "T4",
      topLevel: true,
      gridCalibration: CALIBRATION,
      client: CLIENT,
      cellsHint: [{ row: 18, col: 23 }],
    });
    expect(geometry).toMatchObject({ region: { x: 34, y: 253 }, cols: 24, source: "default-toplevel" });
  });

  it("shifts the folder default by TOP_LEVEL_GRID_DY when no top-level entry exists", () => {
    const calibration: GridCalibrationFile = {
      __default_24x24: CALIBRATION["__default_24x24"]!,
    };
    const geometry = priceOverlayGeometry({
      tabKey: "T4",
      topLevel: true,
      gridCalibration: calibration,
      client: CLIENT,
      cellsHint: [{ row: 18, col: 23 }],
    });
    expect(TOP_LEVEL_GRID_DY).toBe(-67);
    expect(geometry).toMatchObject({
      region: { x: 34, y: 320 + TOP_LEVEL_GRID_DY, w: 1261, h: 1263 },
      cols: 24,
      rows: 24,
      source: "default-shifted",
    });
  });

  it("lets an observed cell beyond 11 prove a quad tab", () => {
    const calibration: GridCalibrationFile = {
      __default_24x24: CALIBRATION["__default_24x24"]!,
      __default_12x12: CALIBRATION["__default_12x12"]!,
    };
    expect(
      priceOverlayGeometry({
        tabKey: "Jewels",
        topLevel: false,
        gridCalibration: calibration,
        profile,
        client: CLIENT,
        cellsHint: [{ row: 18, col: 23 }],
      }),
    ).toMatchObject({ cols: 24, rows: 24, source: "default" });
    expect(
      priceOverlayGeometry({
        tabKey: "Jewels",
        topLevel: false,
        gridCalibration: calibration,
        profile,
        client: CLIENT,
        cellsHint: [{ row: 2, col: 3 }],
      }),
    ).toMatchObject({ cols: 12, rows: 12, source: "default" });
  });

  it("falls back to the calibration profile, then to nothing at all", () => {
    expect(
      priceOverlayGeometry({
        tabKey: "Jewels",
        topLevel: false,
        gridCalibration: {},
        profile,
        client: CLIENT,
      }),
    ).toMatchObject({ region: { x: 40, y: 330, w: 1200, h: 1200 }, source: "profile" });
    expect(
      priceOverlayGeometry({
        tabKey: "Jewels",
        topLevel: false,
        gridCalibration: {},
        client: CLIENT,
      }),
    ).toBeUndefined();
  });

  it("uses the profile bag grid for the bag, and refuses without one", () => {
    expect(
      priceOverlayGeometry({ tabKey: "bag", topLevel: false, gridCalibration: CALIBRATION, profile, client: CLIENT }),
    ).toEqual({ region: { x: 2530, y: 1470, w: 634, h: 264 }, cols: 12, rows: 5, source: "bag" });
    expect(
      priceOverlayGeometry({ tabKey: "bag", topLevel: false, gridCalibration: CALIBRATION, client: CLIENT }),
    ).toBeUndefined();
  });
});

describe("priceLabel", () => {
  it("labels table hits, estimates, stacks and unknowns", () => {
    const table1 = table();
    expect(
      priceLabel(
        { observation: observation({ fingerprint: "a", name: "Headhunter" }), valueExalted: 120, source: "price-table" },
        1,
      ),
    ).toMatchObject({ label: "120 ex", tone: "table", unitExalted: 120 });
    expect(
      priceLabel(
        { observation: observation({ fingerprint: "a", name: "Belt" }), valueExalted: 3.4, source: "estimate" },
        1,
      ),
    ).toMatchObject({ label: "~3.4 ex", tone: "estimate" });
    expect(
      priceLabel({ observation: observation({ fingerprint: "a", name: "Belt" }), source: "none" }, 1),
    ).toEqual({ label: "?", tone: "unknown" });
    const stack = priceLabel(
      {
        observation: observation({
          fingerprint: "f",
          name: "Exalted Orb",
          itemClass: "Stackable Currency",
          stackCount: 37,
          count: 1,
        }),
        valueExalted: 37,
        source: "price-table",
      },
      1,
    );
    expect(stack.stackLabel).toBe("×37 37 ex");
    expect(table1.entries.length).toBeGreaterThan(0);
  });

  it("splits a grouped row evenly across its footprints", () => {
    const label = priceLabel(
      { observation: observation({ fingerprint: "a", name: "Headhunter" }), valueExalted: 120, source: "price-table" },
      2,
    );
    expect(label.unitExalted).toBe(60);
    expect(label.label).toBe("60 ex");
  });
});

describe("planPriceOverlay", () => {
  it("places one rectangle per footprint with the grid's own pixel maths", () => {
    const result = plan([observation({ fingerprint: "cafebabecafebabe", name: "Headhunter" })]);
    expect(result.items).toHaveLength(1);
    const expected = overlayItemPixelRect(result.grids[0]!, 3, 5, 1, 1);
    expect(result.items[0]).toMatchObject({
      x: expected.x,
      y: expected.y,
      width: expected.width,
      label: "120 ex",
      tone: "table",
      opacity: 1,
    });
    expect(result.totalExalted).toBe(120);
    expect(result.priced).toBe(1);
    expect(result.unpriced).toBe(0);
    expect(result.clicks).toEqual([]);
  });

  it("says 'est.' in the grid caption so a screenshot cannot read as a price sheet", () => {
    expect(plan([]).grids[0]!.label).toBe("Belts · 3h ago · est. prices");
  });

  it("fades by value and clamps the font size", () => {
    const result = plan([
      observation({ fingerprint: "cafebabecafebabe", name: "Headhunter" }),
      observation({ fingerprint: "a1b2c3d4a1b2c3d4", name: "Storm Loop", cells: [{ row: 6, col: 6 }] }),
    ]);
    const cheap = result.items.find((item) => item.name === "Storm Loop")!;
    expect(cheap.opacity).toBe(0.54);
    expect(result.items.every((item) => item.fontPx >= 10 && item.fontPx <= 22)).toBe(true);
    const flat = plan(
      [observation({ fingerprint: "a1b2c3d4a1b2c3d4", name: "Storm Loop" })],
      { fadeByValue: false },
    );
    expect(flat.items[0]!.opacity).toBe(1);
  });

  it("honours showUnpriced, minLabelExalted and the exclusion list", () => {
    const unpriced = observation({ fingerprint: "b2c3d4e5b2c3d4e5", name: "Doom Noose" });
    expect(plan([unpriced]).items[0]!.label).toBe("?");
    expect(plan([unpriced], { showUnpriced: false }).items).toHaveLength(0);
    expect(plan([unpriced], { showUnpriced: false }).unpriced).toBe(1);
    expect(
      plan([observation({ fingerprint: "a1b2c3d4a1b2c3d4", name: "Storm Loop" })], {
        minLabelExalted: 10,
      }).items,
    ).toHaveLength(0);
    const excluded = plan(
      [observation({ fingerprint: "cafebabecafebabe", name: "Headhunter" })],
      {},
      new Set(["cafebabecafebabe"]),
    );
    expect(excluded.items).toHaveLength(0);
    expect(excluded.totalExalted).toBe(0);
  });

  it("skips cells outside the grid instead of painting off-panel", () => {
    const result = plan([
      observation({ fingerprint: "cafebabecafebabe", name: "Headhunter", cells: [{ row: 40, col: 40 }] }),
    ]);
    expect(result.items).toHaveLength(0);
    // The worth still counts: the item exists, only its rectangle is unknown.
    expect(result.totalExalted).toBe(120);
  });

  it("says the age is unknown when the tab has never been scanned in full", () => {
    const result = planPriceOverlay({
      observations: [],
      table: table(),
      geometry: GEOMETRY,
      client: CLIENT,
      tab: "Belts",
      excluded: new Set(),
      options: { fadeByValue: true, showUnpriced: true, minLabelExalted: 0 },
    });
    expect(result.ageLabel).toBe("age unknown");
  });
});

describe("tab selection", () => {
  const staleness: LocationStaleness[] = [
    { location: "Rings", lastScanAt: "a", runId: "r", ageMs: 90_000 },
    { location: "Belts", lastScanAt: "b", runId: "r", ageMs: 5_000 },
  ];

  it("keeps the preferred tab, else the freshest non-bag scan", () => {
    expect(pickOverlayTab(["Rings", "Belts", "bag"], "Rings", staleness)).toBe("Rings");
    expect(pickOverlayTab(["Rings", "Belts", "bag"], "Gone", staleness)).toBe("Belts");
    expect(pickOverlayTab(["bag"], undefined, [])).toBe("bag");
    expect(pickOverlayTab([], undefined, [])).toBeUndefined();
  });

  it("cycles alphabetically with the bag last and wraps both ways", () => {
    const tabs = ["Rings", "Belts", "bag"];
    expect(cycleOverlayTab(tabs, "Belts", 1)).toBe("Rings");
    expect(cycleOverlayTab(tabs, "Rings", 1)).toBe("bag");
    expect(cycleOverlayTab(tabs, "bag", 1)).toBe("Belts");
    expect(cycleOverlayTab(tabs, "Belts", -1)).toBe("bag");
    expect(cycleOverlayTab(tabs, undefined, 1)).toBe("Belts");
    expect(cycleOverlayTab([], "Belts", 1)).toBeUndefined();
  });
});
